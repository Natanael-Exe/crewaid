/**
 * The sandbox supervisor's HTTP surface.
 *
 * One `POST` per `ContainerEngine` verb, nothing else. Each request is
 * authenticated before its body is parsed, admitted against the supervisor's
 * own configuration before it reaches Docker, and written to the audit log
 * whatever its outcome — a refusal is the line an operator most needs.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { HarnessError } from '@crewaid/sandbox-core';
import {
  NonceCache,
  SANDBOX_LABELS,
  SANDBOX_MANAGED_BY,
  SIGNATURE_HEADER,
  SUPERVISOR_PATHS,
  SUPERVISOR_NETWORK_LABEL,
  toWireStatus,
  verifyRequest,
  type ContainerEngine,
  type SupervisorRefusal,
} from '@crewaid/sandbox-docker';

import {
  AdmissionRefused,
  Requests,
  admitCreate,
  admitImage,
  admitLookupLabel,
  admitManagedVolume,
  admitNetwork,
  admitVolumeLabels,
  type SupervisorConfig,
} from './admission.js';

/** A verb's body is a few hundred bytes; anything near this is not one. */
const MAX_BODY_BYTES = 64 * 1024;

export type AuditLine = {
  readonly event: 'supervisor.action';
  readonly verb: string;
  readonly target: string | null;
  readonly outcome: 'ok' | 'refused' | 'unauthorized' | 'failed';
  readonly reason?: string;
};

export interface SupervisorDependencies {
  readonly config: SupervisorConfig;
  readonly engine: ContainerEngine;
  /** Where audit lines go. Defaults to one JSON line on stdout. */
  readonly audit?: (line: AuditLine) => void;
  /** Seam for tests. */
  readonly now?: () => number;
}

class NotFound extends Error {}

const isOwnedComputer = (
  status: { labels: Readonly<Record<string, string>>; network?: string },
  config: SupervisorConfig,
) =>
  status.labels[SANDBOX_LABELS.managedBy] === SANDBOX_MANAGED_BY &&
  status.network === config.network;

type Handler = (
  body: unknown,
) => Promise<{ readonly result: unknown; readonly target: string | null }>;

export function createSupervisorServer(deps: SupervisorDependencies): Server {
  const { config, engine } = deps;
  const audit =
    deps.audit ??
    ((line) => process.stdout.write(`${JSON.stringify({ time: Date.now(), ...line })}\n`));
  const now = deps.now ?? Date.now;
  const nonces = new NonceCache();

  /** A computer the supervisor created, or a refusal. Reads may see more; nothing else may act. */
  const managedContainer = async (id: string) => {
    const container = await engine.findById(id);
    if (container === null) throw new NotFound(`container ${id} does not exist`);
    const status = await container.inspect();
    if (!isOwnedComputer(status, config)) {
      throw new AdmissionRefused(`container ${id} is not managed by ${SANDBOX_MANAGED_BY}`);
    }
    return { container, status };
  };

  /** Only computers the supervisor made are answered by a label lookup. */
  const managedOnly = async (
    ids: readonly {
      readonly id: string;
      inspect: () => Promise<{ labels: Readonly<Record<string, string>>; network?: string }>;
    }[],
  ) => {
    const kept: string[] = [];
    for (const container of ids) {
      const status = await container.inspect().catch((error: unknown) => {
        // Only disappearance is absence. A daemon failure must abort the
        // listing, or reconciliation could mistake a live computer for lost.
        if ((error as { statusCode?: unknown } | null)?.statusCode === 404) return null;
        throw error;
      });
      if (status !== null && isOwnedComputer(status, config)) kept.push(container.id);
    }
    return kept;
  };

  const handlers: Record<string, Handler> = {
    [SUPERVISOR_PATHS.ensureNetwork]: async (raw) => {
      const body = Requests.ensureNetwork.parse(raw);
      admitNetwork(config, body.network);
      await engine.ensureNetwork(body.network);
      return { result: {}, target: body.network };
    },

    [SUPERVISOR_PATHS.create]: async (raw) => {
      const spec = await admitCreate(config, raw, (name) => engine.findVolume(name));
      const container = await engine.create(spec);
      return { result: { id: container.id }, target: spec.name };
    },

    [SUPERVISOR_PATHS.start]: async (raw) => {
      const { id } = Requests.container.parse(raw);
      const { container } = await managedContainer(id);
      await container.start();
      return { result: {}, target: id };
    },

    [SUPERVISOR_PATHS.stop]: async (raw) => {
      const body = Requests.stop.parse(raw);
      const { container } = await managedContainer(body.id);
      await container.stop(body.timeoutSeconds);
      return { result: {}, target: body.id };
    },

    [SUPERVISOR_PATHS.remove]: async (raw) => {
      const { id } = Requests.container.parse(raw);
      const container = await engine.findById(id);
      // Already gone is the outcome a remove promises.
      if (container === null) return { result: {}, target: id };
      const status = await container.inspect();
      if (!isOwnedComputer(status, config)) {
        throw new AdmissionRefused(`container ${id} is not managed by ${SANDBOX_MANAGED_BY}`);
      }
      await container.remove();
      return { result: {}, target: id };
    },

    [SUPERVISOR_PATHS.inspect]: async (raw) => {
      const { id } = Requests.container.parse(raw);
      const container = await engine.findById(id);
      if (container === null) throw new NotFound(`container ${id} does not exist`);
      const status = await container.inspect();
      // A container mounting a workspace may be anyone's, and the provider has
      // to see that it is running there to refuse a second writer. It learns
      // that and no more: an unmanaged container's labels and ports stay here.
      const managed = isOwnedComputer(status, config);
      const wire = managed
        ? toWireStatus(status)
        : { ...toWireStatus(status), labels: {}, portBindings: {} };
      return { result: { status: wire }, target: id };
    },

    [SUPERVISOR_PATHS.findByLabel]: async (raw) => {
      const body = Requests.byLabel.parse(raw);
      admitLookupLabel(body.label);
      const all = await engine.listByLabel(body.label, body.value);
      const [id] = await managedOnly(all);
      return { result: { id: id ?? null }, target: `${body.label}=${body.value}` };
    },

    [SUPERVISOR_PATHS.listByLabel]: async (raw) => {
      const body = Requests.byLabel.parse(raw);
      admitLookupLabel(body.label);
      const ids = await managedOnly(await engine.listByLabel(body.label, body.value));
      return { result: { ids }, target: `${body.label}=${body.value}` };
    },

    [SUPERVISOR_PATHS.listByVolume]: async (raw) => {
      const { volume } = Requests.volume.parse(raw);
      admitManagedVolume(await engine.findVolume(volume), volume, config.network);
      // Every container mounting it, managed or not: a foreign writer is still
      // a writer, and the provider refuses to start a second one beside it.
      const containers = await engine.listByVolume(volume);
      return { result: { ids: containers.map((container) => container.id) }, target: volume };
    },

    [SUPERVISOR_PATHS.findById]: async (raw) => {
      const { id } = Requests.container.parse(raw);
      const container = await engine.findById(id);
      if (container === null) return { result: { id: null }, target: id };
      const status = await container.inspect();
      const managed = isOwnedComputer(status, config);
      return { result: { id: managed ? container.id : null }, target: id };
    },

    [SUPERVISOR_PATHS.listWorkspaceVolumes]: async () => {
      const volumes = (await engine.listWorkspaceVolumes()).filter((volume) => {
        try {
          admitManagedVolume(volume, volume.name, config.network);
          return true;
        } catch (error) {
          if (error instanceof AdmissionRefused) return false;
          throw error;
        }
      });
      return { result: { volumes }, target: null };
    },

    [SUPERVISOR_PATHS.findVolume]: async (raw) => {
      const { volume } = Requests.volume.parse(raw);
      // A read inside the workspace namespace: the provider checks the owner
      // label itself, and says why when it is wrong.
      return { result: { volume: await engine.findVolume(volume) }, target: volume };
    },

    [SUPERVISOR_PATHS.createVolume]: async (raw) => {
      const body = Requests.createVolume.parse(raw);
      admitVolumeLabels(body.volume, body.labels);
      const existing = await engine.findVolume(body.volume);
      if (existing !== null) admitManagedVolume(existing, body.volume, config.network);
      const volume = await engine.createVolume({
        name: body.volume,
        labels: { ...body.labels, [SUPERVISOR_NETWORK_LABEL]: config.network },
      });
      admitManagedVolume(volume, body.volume, config.network);
      return { result: { volume }, target: body.volume };
    },

    [SUPERVISOR_PATHS.removeWorkspaceVolume]: async (raw) => {
      const { volume } = Requests.volume.parse(raw);
      admitManagedVolume(await engine.findVolume(volume), volume, config.network);
      await engine.removeWorkspaceVolume(volume);
      return { result: {}, target: volume };
    },

    [SUPERVISOR_PATHS.workspaceMarker]: async (raw) => {
      const body = Requests.marker.parse(raw);
      admitImage(config, body.image);
      admitManagedVolume(await engine.findVolume(body.volume), body.volume, config.network);
      const value = await engine.workspaceMarker(
        body.volume,
        body.image,
        body.now,
        body.clear,
        body.history,
      );
      return { result: { value }, target: body.volume };
    },

    [SUPERVISOR_PATHS.retireBotProfile]: async (raw) => {
      const body = Requests.retire.parse(raw);
      admitImage(config, body.image);
      // The workspace is the shared computer's; the bot is whichever of the
      // crew's browser profiles is being retired inside it.
      admitManagedVolume(await engine.findVolume(body.volume), body.volume, config.network);
      await engine.retireBotProfile(body.volume, body.image, body.botId);
      return { result: {}, target: body.volume };
    },
  };

  return createServer((request, response) => {
    void serve(request, response).catch(() => {
      if (!response.headersSent) respond(response, 500, { error: 'internal', code: 'failed' });
    });
  });

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '').split('?')[0] ?? '';
    // Unauthenticated and content-free: a container healthcheck can reach it
    // without the secret, and learns only that the process is up.
    if (path === SUPERVISOR_PATHS.health && request.method === 'GET') {
      respond(response, 200, { ok: true });
      return;
    }
    const handler =
      request.method === 'POST' && Object.hasOwn(handlers, path) ? handlers[path] : undefined;
    if (handler === undefined) {
      respond(response, 404, { error: 'no such verb', code: 'not-found' });
      return;
    }

    let body: string;
    try {
      body = await readBody(request);
    } catch {
      audit({
        event: 'supervisor.action',
        verb: path,
        target: null,
        outcome: 'refused',
        reason: 'request too large',
      });
      respond(response, 413, { error: 'request too large', code: 'invalid' });
      return;
    }

    const verdict = verifyRequest(
      config.secrets,
      { method: 'POST', path, body },
      header(request, SIGNATURE_HEADER),
      nonces,
      now(),
    );
    if (!verdict.ok) {
      audit({
        event: 'supervisor.action',
        verb: path,
        target: null,
        outcome: 'unauthorized',
        reason: verdict.reason,
      });
      respond(response, 401, { error: `unauthorized: ${verdict.reason}`, code: 'unauthorized' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body === '' ? '{}' : body);
    } catch {
      audit({
        event: 'supervisor.action',
        verb: path,
        target: null,
        outcome: 'refused',
        reason: 'body is not JSON',
      });
      respond(response, 400, { error: 'body is not JSON', code: 'invalid' });
      return;
    }

    try {
      const { result, target } = await handler(parsed);
      audit({ event: 'supervisor.action', verb: path, target, outcome: 'ok' });
      respond(response, 200, result);
    } catch (error) {
      const [status, refusal] = refusalOf(error);
      audit({
        event: 'supervisor.action',
        verb: path,
        target: auditTarget(parsed),
        outcome: status === 500 ? 'failed' : 'refused',
        reason: refusal.error,
      });
      respond(response, status, refusal);
    }
  }
}

/** Valid resource identifiers only: arbitrary payloads and secrets never enter the log. */
function auditTarget(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  for (const key of ['id', 'volume', 'name', 'network'] as const) {
    if (key in body) {
      const value: unknown = Reflect.get(body, key);
      if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value))
        return value;
    }
  }
  return null;
}

function refusalOf(error: unknown): [number, SupervisorRefusal] {
  if (error instanceof AdmissionRefused) return [403, { error: error.message, code: 'refused' }];
  if (error instanceof NotFound) return [404, { error: error.message, code: 'not-found' }];
  if (error instanceof Error && error.name === 'ZodError') {
    return [400, { error: 'the request does not match the verb', code: 'invalid' }];
  }
  if ((error as { statusCode?: unknown } | null)?.statusCode === 404) {
    return [404, { error: 'no such resource', code: 'not-found' }];
  }
  const message =
    HarnessError.isInstance(error) || error instanceof Error ? error.message : String(error);
  return [500, { error: message, code: 'failed' }];
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}
