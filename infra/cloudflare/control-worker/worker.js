// Control plane for Crewaid computers on Cloudflare Containers (D-151).
//
// The orchestrator cannot reach a container directly: every container belongs
// to a Durable Object, and only that object can start it, run a command in it
// or open a TCP connection to one of its ports. This Worker is that object,
// one per computer, behind a single bearer secret, plus a registry that makes
// the computers listable (Durable Objects cannot be enumerated).
//
// A container's disk is ephemeral: it starts from the image every time. The
// computer's workspace is therefore a tar of /home/bot in R2, streamed by this
// Worker (the container never holds an R2 credential). A start restores it
// before the desktop comes up; a stop closes the bots' browsers so they flush
// their cookies, saves, then destroys the container. While a computer runs,
// an alarm saves it every SAVE_EVERY_MS and stops it if the orchestrator has
// not been heard from for ORPHAN_AFTER_MS — any open tunnel keeps a container
// awake past its own inactivity timeout (measured), so an orchestrator that
// died with a screen open would otherwise leave it running indefinitely.
//
// Routes, all under /v1 and all requiring `Authorization: Bearer <CONTROL_SECRET>`:
//   GET  /v1/computers                         every provisioned computer
//   POST /v1/computers/:id/provision           create the workspace record (idempotent)
//   GET  /v1/computers/:id                     status
//   POST /v1/computers/:id/start               restore the workspace, start the desktop
//   POST /v1/computers/:id/stop                close browsers, save, destroy
//   POST /v1/computers/:id/retire-profile      {botId}; deferred to the next start if stopped
//   POST /v1/computers/:id/retain              {orphaned, now, retentionMs} -> retention outcome
//   GET  /v1/computers/:id/tcp/:port           WebSocket <-> raw TCP to a container port

import { DurableObject } from 'cloudflare:workers';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PART_BYTES = 10 * 1024 * 1024;
const BRIDGE_PORT = 7070;
const MAX_INACTIVITY_MS = 6 * 60 * 60 * 1000;
// The desktop waits for this file, named per start, so the workspace is in
// place before anything opens it. A per-start name, because /tmp is not
// carried between starts but a stale name must never release a new start.
const GATE =
  'while [ ! -e "/tmp/.crewaid-go-$CREWAID_START_ID" ]; do sleep 0.2; done; ' +
  'exec /usr/local/bin/entrypoint.sh';

// Chunks waiting to become one upload part. Each byte is copied once, into
// the part it lands in: appending by re-copying the whole buffer per chunk is
// quadratic, and on a browser-sized workspace it exhausted the Durable Object's
// CPU limit mid-save (measured), which reset the object and left the save hung.
class PartQueue {
  #chunks = [];
  size = 0;

  push(chunk) {
    this.#chunks.push(chunk);
    this.size += chunk.length;
  }

  take(length) {
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const head = this.#chunks[0];
      const wanted = length - offset;
      if (head.length <= wanted) {
        out.set(head, offset);
        offset += head.length;
        this.#chunks.shift();
      } else {
        out.set(head.subarray(0, wanted), offset);
        this.#chunks[0] = head.subarray(wanted);
        offset += wanted;
      }
    }
    this.size -= length;
    return out;
  }
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const json = (body, status = 200) => Response.json(body, { status });
const numberVar = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Computer extends DurableObject {
  #queue = Promise.resolve();
  // Set while this object is stopping its own container, so the exit that
  // follows is recorded as a stop rather than reported as a crash.
  #stopping = false;

  // Lifecycle operations run one at a time: a stop must never interleave with
  // a start or a save of the same computer.
  #serial(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  get #settings() {
    return {
      instance: {
        vcpu: numberVar(this.env.INSTANCE_VCPU, 4),
        memoryMib: numberVar(this.env.INSTANCE_MEMORY_MIB, 12288),
        diskMb: numberVar(this.env.INSTANCE_DISK_MB, 20000),
      },
      saveEveryMs: numberVar(this.env.SAVE_EVERY_MS, 30 * 60 * 1000),
      orphanAfterMs: numberVar(this.env.ORPHAN_AFTER_MS, 15 * 60 * 1000),
      alarmEveryMs: numberVar(this.env.ALARM_EVERY_MS, 5 * 60 * 1000),
    };
  }

  async #meta() {
    return (await this.ctx.storage.get('meta')) ?? null;
  }

  async #putMeta(meta) {
    await this.ctx.storage.put('meta', meta);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const [, , , id, action, arg] = url.pathname.split('/');
    try {
      if (action !== 'tcp') await this.#heard();
      if (request.method === 'GET' && action === undefined) return json(await this.#status(id));
      if (request.method === 'GET' && action === 'tcp') return this.#tunnel(Number(arg));
      if (request.method !== 'POST') throw new HttpError(405, 'method', 'method not allowed');
      const body = await request.json().catch(() => ({}));
      switch (action) {
        case 'provision':
          return json(await this.#serial(() => this.#provision(id)));
        case 'start':
          return json(await this.#serial(() => this.#start(id)));
        case 'stop':
          return json(await this.#serial(() => this.#stop(id)));
        case 'retire-profile':
          return json(await this.#serial(() => this.#retireProfile(body.botId)));
        case 'retain':
          return json(await this.#serial(() => this.#retain(id, body)));
        default:
          throw new HttpError(404, 'route', `no route ${action}`);
      }
    } catch (error) {
      if (error instanceof HttpError)
        return json({ code: error.code, message: error.message }, error.status);
      return json(
        { code: 'internal', message: String(error?.message ?? error).slice(0, 500) },
        500,
      );
    }
  }

  // Every request from the orchestrator is proof it is alive; the health
  // sweep reads status every few seconds for each running computer.
  async #heard() {
    const meta = await this.#meta();
    if (meta !== null) await this.#putMeta({ ...meta, lastSeen: Date.now() });
  }

  async #status(id) {
    const meta = await this.#meta();
    if (meta === null) return { id, exists: false, running: false };
    return {
      id,
      exists: true,
      running: this.ctx.container.running,
      runtimeCreatedAt: meta.runtimeCreatedAt ?? null,
      orphanedSince: meta.orphanedSince ?? null,
      savedAt: meta.save?.at ?? null,
      backupBytes: meta.save?.bytes ?? null,
      startedAt: meta.startedAt ?? null,
      exit: meta.exit ?? null,
      pendingRetirements: meta.pendingRetirements ?? [],
    };
  }

  async #provision(id) {
    let meta = await this.#meta();
    if (meta === null) {
      meta = { id, provisionedAt: Date.now(), runtimeCreatedAt: null, pendingRetirements: [] };
      await this.#putMeta(meta);
      await this.#registry('add', id);
    }
    return this.#status(id);
  }

  async #start(id) {
    const meta = await this.#meta();
    if (meta === null)
      throw new HttpError(404, 'workspace_missing', `computer ${id} has no workspace`);
    const container = this.ctx.container;
    if (container.running) return this.#status(id);
    const settings = this.#settings;
    const startId = crypto.randomUUID();
    // Until this start's restore completes, nothing may save: a save of a home
    // that was never restored would replace the workspace with an empty one.
    // Kept in storage so it survives the object restarting mid-run.
    await this.#putMeta({ ...meta, currentStartId: startId, readyStartId: null });
    container.start({
      image: container.images.base,
      enableInternet: true,
      instance: settings.instance,
      entrypoint: ['/bin/sh', '-c', GATE],
      env: { CREWAID_START_ID: startId },
      labels: { computer: id },
    });
    const exits = container
      .monitor()
      .then(() => ({ code: 0 }))
      .catch((error) => ({
        code: error?.exitCode ?? null,
        error: String(error?.message ?? error).slice(0, 300),
      }));
    this.ctx.waitUntil(
      exits.then(async (exit) => {
        const requested = this.#stopping;
        this.#stopping = false;
        const current = await this.#meta();
        if (current !== null) {
          await this.#putMeta({
            ...current,
            exit: requested ? null : { ...exit, at: Date.now() },
            startedAt: null,
          });
        }
      }),
    );
    try {
      for (let waited = 0; !container.running; waited += 100) {
        if (waited > 60_000)
          throw new HttpError(504, 'start_timeout', `computer ${id} did not start within 60 s`);
        await delay(100);
      }
      await container.setInactivityTimeout(MAX_INACTIVITY_MS);
      if (meta.save?.key) {
        const restored = await this.#restore(meta.save.key);
        if (!restored.ok) {
          throw new HttpError(
            500,
            'restore_failed',
            `restoring the workspace failed: ${restored.detail}`,
          );
        }
      }
      // Idempotent, so applied at every start until a save has captured them.
      for (const botId of meta.pendingRetirements ?? []) {
        await this.#exec(['python3', '/opt/agent-bridge/profiles.py', 'retire', botId]);
      }
      await this.#exec(['touch', `/tmp/.crewaid-go-${startId}`]);
    } catch (error) {
      // A container whose workspace is not in place must not keep running: its
      // desktop never starts, and a later stop would save the empty home.
      this.#stopping = true;
      await container.destroy('start failed').catch(() => undefined);
      throw error;
    }
    await this.#putMeta({
      ...(await this.#meta()),
      readyStartId: startId,
      runtimeCreatedAt: meta.runtimeCreatedAt ?? Date.now(),
      orphanedSince: null,
      startedAt: Date.now(),
      exit: null,
    });
    await this.ctx.storage.setAlarm(Date.now() + settings.alarmEveryMs);
    return this.#status(id);
  }

  async #stop(id) {
    const container = this.ctx.container;
    if (container.running) {
      await this.#closeSeats();
      await this.#save();
      this.#stopping = true;
      await container.destroy('stopped by the orchestrator');
      for (let waited = 0; container.running && waited < 30_000; waited += 100) await delay(100);
    }
    const meta = await this.#meta();
    if (meta !== null) await this.#putMeta({ ...meta, startedAt: null });
    return this.#status(id);
  }

  // A browser killed with its container can lose its last cookie writes;
  // `Browser.close`, which the bridge's close uses, flushes them.
  async #closeSeats() {
    try {
      const port = this.ctx.container.getTcpPort(BRIDGE_PORT);
      const listing = await (await port.fetch('http://bridge/seats')).json();
      for (const seat of listing.seats ?? []) {
        await port.fetch(`http://bridge/seats/${encodeURIComponent(seat.seatId)}/close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      }
    } catch {
      // A bridge that is already down has no browser left to flush.
    }
  }

  async #save() {
    const meta = await this.#meta();
    if (meta === null || !this.ctx.container.running) return;
    if (meta.readyStartId == null || meta.readyStartId !== meta.currentStartId) {
      throw new HttpError(
        409,
        'not_restored',
        'the workspace was not restored in this run; refusing to save over it',
      );
    }
    // Retirements already applied inside the container; this save captures
    // their tombstones, so they stop being pending once it completes.
    const captured = new Set(meta.pendingRetirements ?? []);
    const key = `computers/${meta.id}/home.tar.gz`;
    const proc = await this.ctx.container.exec(['tar', '-C', '/home', '-czf', '-', 'bot'], {
      stderr: 'pipe',
    });
    // Read concurrently: a stderr pipe nobody drains can block tar mid-archive.
    const stderr = new Response(proc.stderr).text();
    // Multipart, so a workspace of any size streams through in bounded memory;
    // an aborted upload leaves the previous save in place.
    const upload = await this.env.WORKSPACES.createMultipartUpload(key);
    const parts = [];
    const queue = new PartQueue();
    let bytes = 0;
    try {
      const reader = proc.stdout.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        queue.push(value);
        while (queue.size >= PART_BYTES) {
          parts.push(await upload.uploadPart(parts.length + 1, queue.take(PART_BYTES)));
        }
      }
      if (queue.size > 0 || parts.length === 0) {
        parts.push(await upload.uploadPart(parts.length + 1, queue.take(queue.size)));
      }
      const exitCode = await proc.exitCode;
      // tar exits 1 when a file changed while it was read (a live browser
      // profile); the archive is still complete and restorable.
      if (exitCode > 1) throw new Error(`tar exited ${exitCode}: ${(await stderr).slice(0, 300)}`);
      await upload.complete(parts);
    } catch (error) {
      await upload.abort().catch(() => undefined);
      throw error;
    }
    const current = await this.#meta();
    await this.#putMeta({
      ...current,
      save: { key, bytes, at: Date.now() },
      pendingRetirements: (current.pendingRetirements ?? []).filter(
        (botId) => !captured.has(botId),
      ),
    });
  }

  async #restore(key) {
    const object = await this.env.WORKSPACES.get(key);
    if (object === null) return { ok: false, detail: `no saved workspace at ${key}` };
    const proc = await this.ctx.container.exec(['tar', '-C', '/home', '-xzf', '-'], {
      stdin: object.body,
    });
    const out = await proc.output();
    return out.exitCode === 0
      ? { ok: true }
      : {
          ok: false,
          detail: `tar exited ${out.exitCode}: ${new TextDecoder().decode(out.stderr).slice(0, 300)}`,
        };
  }

  async #exec(argv) {
    const proc = await this.ctx.container.exec(argv);
    return proc.output();
  }

  async #retireProfile(botId) {
    if (typeof botId !== 'string' || !ID.test(botId) || botId === 'Default') {
      throw new HttpError(400, 'invalid_profile', 'invalid bot profile');
    }
    const meta = await this.#meta();
    if (meta === null)
      throw new HttpError(404, 'workspace_missing', 'workspace is missing; cannot retire profile');
    if (this.ctx.container.running) {
      const result = await this.#exec([
        'python3',
        '/opt/agent-bridge/profiles.py',
        'retire',
        botId,
      ]);
      if (result.exitCode !== 0)
        throw new HttpError(500, 'retire_failed', 'could not persist profile retirement');
      // Pending until a save captures the tombstone: a crash before then
      // would lose it, and the next start re-applies it.
      const current = await this.#meta();
      await this.#putMeta({
        ...current,
        pendingRetirements: [...new Set([...(current.pendingRetirements ?? []), botId])],
      });
      return { retired: true, deferred: false };
    }
    // Stopped: the workspace is only a tar in R2, so the tombstone is written
    // on the next start, after the restore and before the desktop opens it.
    const pending = new Set(meta.pendingRetirements ?? []);
    pending.add(botId);
    await this.#putMeta({ ...meta, pendingRetirements: [...pending] });
    return { retired: false, deferred: true };
  }

  async #retain(id, { orphaned, now, retentionMs }) {
    const meta = await this.#meta();
    if (meta === null) return { outcome: 'absent' };
    if (!orphaned) {
      if (meta.orphanedSince != null) await this.#putMeta({ ...meta, orphanedSince: null });
      return { outcome: 'retained' };
    }
    if (this.ctx.container.running) return { outcome: 'in-use' };
    const first = meta.orphanedSince ?? now;
    if (meta.orphanedSince == null) await this.#putMeta({ ...meta, orphanedSince: first });
    if (now - first < retentionMs) return { outcome: 'retained' };
    if (meta.save?.key) await this.env.WORKSPACES.delete(meta.save.key);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.#registry('remove', id);
    return { outcome: 'deleted' };
  }

  async alarm() {
    const meta = await this.#meta();
    if (meta === null || !this.ctx.container.running) return;
    const { saveEveryMs, orphanAfterMs, alarmEveryMs } = this.#settings;
    const now = Date.now();
    await this.#serial(async () => {
      if (!this.ctx.container.running) return;
      // Reapplied every run: whether the setting survives this object
      // restarting is not documented, and the default is far shorter.
      await this.ctx.container.setInactivityTimeout(MAX_INACTIVITY_MS);
      if (now - (meta.lastSeen ?? 0) > orphanAfterMs) {
        await this.#stop(meta.id);
        return;
      }
      if (now - (meta.save?.at ?? meta.startedAt ?? 0) > saveEveryMs) await this.#save();
    });
    if (this.ctx.container.running) await this.ctx.storage.setAlarm(Date.now() + alarmEveryMs);
  }

  async #registry(op, id) {
    const stub = this.env.REGISTRY.get(this.env.REGISTRY.idFromName('registry'));
    await stub.fetch(`http://registry/${op}/${encodeURIComponent(id)}`, { method: 'POST' });
  }

  #tunnel(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new HttpError(400, 'port', 'invalid port');
    if (!this.ctx.container.running)
      throw new HttpError(409, 'not_running', 'the computer is not running');
    const [client, server] = Object.values(new WebSocketPair());
    // Current compatibility dates deliver binary messages as Blob (the web
    // standard); read as an ArrayBuffer, a Blob is zero bytes.
    server.binaryType = 'arraybuffer';
    server.accept();
    const socket = this.ctx.container.getTcpPort(port).connect(`10.0.0.1:${port}`);
    const writer = socket.writable.getWriter();
    server.addEventListener('message', (event) => {
      const data =
        typeof event.data === 'string'
          ? new TextEncoder().encode(event.data)
          : new Uint8Array(event.data);
      writer.write(data).catch(() => server.close(1011, 'write failed'));
    });
    server.addEventListener('close', () => {
      writer.close().catch(() => undefined);
    });
    this.ctx.waitUntil(
      (async () => {
        try {
          await socket.opened;
          const reader = socket.readable.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            server.send(value);
          }
          server.close(1000, 'guest closed');
        } catch (error) {
          try {
            server.close(4002, String(error?.message ?? error).slice(0, 100));
          } catch {
            // Already closed by the client.
          }
        }
      })(),
    );
    return new Response(null, { status: 101, webSocket: client });
  }
}

// Durable Objects cannot be listed, so one object keeps the set of computer ids.
export class Registry extends DurableObject {
  async fetch(request) {
    const [, op, raw] = new URL(request.url).pathname.split('/');
    const id = raw === undefined ? undefined : decodeURIComponent(raw);
    if (op === 'add' && id) await this.ctx.storage.put(`c:${id}`, 1);
    else if (op === 'remove' && id) await this.ctx.storage.delete(`c:${id}`);
    else if (op !== 'list') return json({ code: 'route', message: 'no route' }, 404);
    const ids = [...(await this.ctx.storage.list({ prefix: 'c:' })).keys()].map((key) =>
      key.slice(2),
    );
    return json({ ids });
  }
}

async function authorized(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const given = new TextEncoder().encode(request.headers.get('authorization') ?? '');
  const wanted = new TextEncoder().encode(`Bearer ${secret}`);
  return given.byteLength === wanted.byteLength && crypto.subtle.timingSafeEqual(given, wanted);
}

export default {
  async fetch(request, env) {
    if (!(await authorized(request, env.CONTROL_SECRET))) {
      return json({ code: 'unauthorized', message: 'unauthorized' }, 401);
    }
    const url = new URL(request.url);
    if (url.pathname === '/v1/computers' && request.method === 'GET') {
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
      const { ids } = await (await registry.fetch('http://registry/list')).json();
      const computers = await Promise.all(
        ids.map(async (id) => {
          const stub = env.COMPUTER.get(env.COMPUTER.idFromName(id));
          return (
            await stub.fetch(`http://computer/v1/computers/${encodeURIComponent(id)}`)
          ).json();
        }),
      );
      return json({ computers });
    }
    const match = /^\/v1\/computers\/([^/]+)(?:\/.*)?$/.exec(url.pathname);
    if (match === null || !ID.test(match[1]))
      return json({ code: 'route', message: 'not found' }, 404);
    return env.COMPUTER.get(env.COMPUTER.idFromName(match[1])).fetch(request);
  },
};
