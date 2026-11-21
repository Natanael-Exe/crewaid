import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessError, SANDBOX_WORKING_DIRECTORY } from '@crewaid/sandbox-core';
import type { ContainerStatus, SandboxContainer } from '@crewaid/sandbox-core';
import {
  SANDBOX_IDENTITY_LABEL,
  SANDBOX_LABELS,
  SANDBOX_LIMITS,
  SANDBOX_MANAGED_BY,
  SIGNATURE_HEADER,
  SUPERVISOR_PATHS,
  SUPERVISOR_NETWORK_LABEL,
  SupervisorEngine,
  SupervisorRefusedError,
  containerNameFor,
  signRequest,
  workspaceVolumeNameFor,
  type ContainerCreateSpec,
  type ContainerEngine,
  type WorkspaceVolume,
} from '@crewaid/sandbox-docker';

import { COMPUTER_PORTS, readSupervisorConfig, type SupervisorConfig } from './admission.js';
import { createSupervisorServer, type AuditLine } from './server.js';

/**
 * D-200's refusals, against an in-memory daemon.
 *
 * Every case that refuses also proves the verb works when the request is the
 * one the provider really sends — a supervisor that refused everything would
 * pass the refusals and nothing else.
 */

const SECRET = 'a'.repeat(64);
const PREVIOUS = 'b'.repeat(64);
const IMAGE = 'crewaid/sandbox:test';
const NETWORK = 'crewaid-test-net';

type FakeContainer = {
  id: string;
  network: string;
  labels: Record<string, string>;
  running: boolean;
  mounts: { volume: string; path: string }[];
};

class FakeEngine implements ContainerEngine {
  readonly containers = new Map<string, FakeContainer>();
  readonly volumes = new Map<string, WorkspaceVolume>();
  readonly created: ContainerCreateSpec[] = [];
  readonly calls: string[] = [];
  #next = 0;

  handle(id: string): SandboxContainer {
    const { containers, calls } = this;
    return {
      id,
      start: () =>
        settle(() => {
          calls.push(`start ${id}`);
          containers.get(id)!.running = true;
        }),
      stop: () =>
        settle(() => {
          calls.push(`stop ${id}`);
          containers.get(id)!.running = false;
        }),
      remove: () =>
        settle(() => {
          calls.push(`remove ${id}`);
          containers.delete(id);
        }),
      inspect: () =>
        settle((): ContainerStatus => {
          const container = containers.get(id);
          if (container === undefined) throw Object.assign(new Error('gone'), { statusCode: 404 });
          return {
            running: container.running,
            network: container.network,
            exitCode: null,
            portBindings: container.running ? { 7070: { host: '127.0.0.1', port: 49000 } } : {},
            mounts: container.mounts,
            labels: container.labels,
          };
        }),
      spawn: () => Promise.reject(new Error('the supervisor never execs for a caller')),
    };
  }

  /** A container someone else made, mounting whatever it likes. */
  addForeign(
    labels: Record<string, string> = {},
    mounts: FakeContainer['mounts'] = [],
    network = NETWORK,
  ): string {
    const id = this.#id();
    this.containers.set(id, { id, labels, network, running: true, mounts });
    return id;
  }

  #id(): string {
    this.#next += 1;
    return this.#next.toString(16).padStart(12, '0');
  }

  listWorkspaceVolumes() {
    return settle(() => [...this.volumes.values()]);
  }
  retireBotProfile(volume: string) {
    return settle(() => void this.calls.push(`retire ${volume}`));
  }
  workspaceMarker(volume: string) {
    return settle(() => {
      this.calls.push(`marker ${volume}`);
      return null;
    });
  }
  removeWorkspaceVolume(name: string) {
    return settle(() => {
      this.calls.push(`remove-volume ${name}`);
      this.volumes.delete(name);
    });
  }
  ensureNetwork(name: string) {
    return settle(() => void this.calls.push(`network ${name}`));
  }
  create(spec: ContainerCreateSpec) {
    return settle(() => {
      this.created.push(spec);
      const id = this.#id();
      this.containers.set(id, {
        id,
        network: spec.network,
        labels: { ...spec.labels },
        running: false,
        mounts: spec.mounts.map((mount) => ({ ...mount })),
      });
      return this.handle(id);
    });
  }
  async findByLabel(label: string, value: string) {
    return (await this.listByLabel(label, value))[0] ?? null;
  }
  listByLabel(label: string, value: string) {
    return settle(() =>
      [...this.containers.values()]
        .filter((container) => container.labels[label] === value)
        .map((container) => this.handle(container.id)),
    );
  }
  listByVolume(volume: string) {
    return settle(() =>
      [...this.containers.values()]
        .filter((container) => container.mounts.some((mount) => mount.volume === volume))
        .map((container) => this.handle(container.id)),
    );
  }
  findById(id: string) {
    return settle(() => (this.containers.has(id) ? this.handle(id) : null));
  }
  findVolume(name: string) {
    return settle(() => this.volumes.get(name) ?? null);
  }
  createVolume(spec: { name: string; labels: Readonly<Record<string, string>> }) {
    return settle(() => {
      const volume = this.volumes.get(spec.name) ?? { name: spec.name, labels: { ...spec.labels } };
      this.volumes.set(spec.name, volume);
      return volume;
    });
  }
}

/** A synchronous fake's answer as the port's promise, rejections included. */
function settle<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

const config: SupervisorConfig = readSupervisorConfig({
  SANDBOX_SUPERVISOR_SECRET: SECRET,
  SANDBOX_SUPERVISOR_SECRET_PREVIOUS: PREVIOUS,
  SANDBOX_IMAGE: IMAGE,
  SANDBOX_NETWORK: NETWORK,
});

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function start(engine = new FakeEngine()) {
  const audit: AuditLine[] = [];
  server = createSupervisorServer({ config, engine, audit: (line) => audit.push(line) });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new SupervisorEngine({ url, secret: SECRET });
  return { engine, audit, url, client };
}

async function raw(
  url: string,
  path: string,
  body: unknown,
  signature?: string | null,
): Promise<{ status: number; body: unknown }> {
  const text = JSON.stringify(body);
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature === null
        ? {}
        : {
            [SIGNATURE_HEADER]:
              signature ?? signRequest(SECRET, { method: 'POST', path, body: text }),
          }),
    },
    body: text,
  });
  return { status: response.status, body: await response.json() };
}

/** The spec `DockerSandboxProvider.createSession` sends for a bot's computer. */
function computerSpec(
  botId: string,
  overrides: Partial<ContainerCreateSpec> = {},
): ContainerCreateSpec {
  const sessionId = `crewaid-${botId}`;
  return {
    image: IMAGE,
    screen: { widthPx: 1280, heightPx: 800 },
    name: containerNameFor(sessionId),
    network: NETWORK,
    publishPorts: [...COMPUTER_PORTS],
    labels: {
      [SANDBOX_LABELS.sessionId]: sessionId,
      [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY,
      [SANDBOX_IDENTITY_LABEL]: botId,
    },
    limits: SANDBOX_LIMITS,
    mounts: [{ volume: workspaceVolumeNameFor(botId), path: SANDBOX_WORKING_DIRECTORY }],
    ...overrides,
  };
}

async function withWorkspace(client: SupervisorEngine, botId: string) {
  return client.createVolume({
    name: workspaceVolumeNameFor(botId),
    labels: { [SANDBOX_LABELS.botId]: botId, [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY },
  });
}

describe('D-200 the supervisor authenticates every verb', () => {
  it('runs a signed verb, and refuses the same verb unsigned, forged, stale or replayed', async () => {
    const { url, engine, audit } = await start();
    const path = SUPERVISOR_PATHS.ensureNetwork;
    const body = { network: NETWORK };
    const text = JSON.stringify(body);

    expect((await raw(url, path, body)).status).toBe(200);
    expect(engine.calls).toEqual([`network ${NETWORK}`]);

    expect((await raw(url, path, body, null)).status).toBe(401);
    const forged = signRequest('c'.repeat(64), { method: 'POST', path, body: text });
    expect((await raw(url, path, body, forged)).status).toBe(401);
    const stale = signRequest(SECRET, { method: 'POST', path, body: text }, Date.now() - 120_000);
    expect((await raw(url, path, body, stale)).status).toBe(401);
    // A signature covers the body: the same header on another body is forged.
    const signed = signRequest(SECRET, { method: 'POST', path, body: text });
    expect((await raw(url, path, body, signed)).status).toBe(200);
    expect((await raw(url, path, body, signed)).status).toBe(401);
    const other = signRequest(SECRET, { method: 'POST', path, body: text });
    expect((await raw(url, path, { network: 'host' }, other)).status).toBe(401);

    expect(engine.calls).toEqual([`network ${NETWORK}`, `network ${NETWORK}`]);
    expect(
      audit.filter((line) => line.outcome === 'unauthorized').map((line) => line.reason),
    ).toEqual(['missing', 'bad-signature', 'stale', 'replayed', 'bad-signature']);
  });

  it('accepts the previous secret during a rotation', async () => {
    const { url } = await start();
    const path = SUPERVISOR_PATHS.ensureNetwork;
    const text = JSON.stringify({ network: NETWORK });
    const signature = signRequest(PREVIOUS, { method: 'POST', path, body: text });
    expect((await raw(url, path, { network: NETWORK }, signature)).status).toBe(200);
  });

  it('never puts the secret in a response or an audit line', async () => {
    const { url, audit, client } = await start();
    await client.ensureNetwork(NETWORK);
    await raw(url, SUPERVISOR_PATHS.ensureNetwork, { network: 'host' });
    await raw(url, SUPERVISOR_PATHS.ensureNetwork, { network: NETWORK }, null);
    const everything = JSON.stringify(audit);
    expect(audit.length).toBeGreaterThanOrEqual(3);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(PREVIOUS);
  });

  it('has no exec verb and answers health without the secret, saying nothing else', async () => {
    const { url } = await start();
    expect(
      (await raw(url, '/v1/containers/exec', { id: '0'.repeat(12), cmd: ['sh'] })).status,
    ).toBe(404);
    const health = await fetch(`${url}${SUPERVISOR_PATHS.health}`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  });
});

describe('D-200 a computer is created only as the supervisor would build it', () => {
  it('creates the computer the provider asks for, labelled by the supervisor', async () => {
    const { client, engine, audit } = await start();
    await withWorkspace(client, 'bot-1');
    const container = await client.create(computerSpec('bot-1'));
    await container.start();
    expect(engine.created).toHaveLength(1);
    expect(engine.created[0]?.labels[SANDBOX_LABELS.managedBy]).toBe(SANDBOX_MANAGED_BY);
    expect((await container.inspect()).running).toBe(true);
    expect(audit.map((line) => [line.verb, line.outcome])).toContainEqual([
      SUPERVISOR_PATHS.create,
      'ok',
    ]);
  });

  it.each([
    ['an arbitrary image', { image: 'alpine:latest' }],
    ['another network', { network: 'host' }],
    ['a host path', { mounts: [{ volume: '/etc', path: SANDBOX_WORKING_DIRECTORY }] }],
    ['a mount elsewhere', { mounts: [{ volume: workspaceVolumeNameFor('bot-1'), path: '/root' }] }],
    [
      "another bot's workspace",
      { mounts: [{ volume: workspaceVolumeNameFor('bot-2'), path: SANDBOX_WORKING_DIRECTORY }] },
    ],
    ['an extra port', { publishPorts: [...COMPUTER_PORTS, 22] }],
    [
      'looser limits',
      { limits: { ...SANDBOX_LIMITS, memoryBytes: SANDBOX_LIMITS.memoryBytes * 2 } },
    ],
    ['capabilities kept', { limits: { ...SANDBOX_LIMITS, dropAllCapabilities: false } }],
    [
      'swap enabled by lowering memory alone',
      { limits: { ...SANDBOX_LIMITS, memoryBytes: SANDBOX_LIMITS.memoryBytes / 2 } },
    ],
    [
      'a label of its own',
      { labels: { ...computerSpec('bot-1').labels, 'com.docker.compose.project': 'x' } },
    ],
    [
      'another owner',
      { labels: { ...computerSpec('bot-1').labels, [SANDBOX_LABELS.managedBy]: 'someone' } },
    ],
    ['a privileged extra field', { privileged: true } as Partial<ContainerCreateSpec>],
  ])('refuses %s, and creates nothing', async (_name, overrides) => {
    const { client, engine, audit } = await start();
    await withWorkspace(client, 'bot-1');
    await withWorkspace(client, 'bot-2');
    const error = await client.create(computerSpec('bot-1', overrides)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupervisorRefusedError);
    expect((error as SupervisorRefusedError).statusCode).toBe(403);
    expect(engine.created).toEqual([]);
    expect(audit.at(-1)).toMatchObject({ verb: SUPERVISOR_PATHS.create, outcome: 'refused' });
  });

  it('refuses a workspace it did not label', async () => {
    const { client, engine } = await start();
    engine.volumes.set(workspaceVolumeNameFor('bot-1'), {
      name: workspaceVolumeNameFor('bot-1'),
      labels: { [SANDBOX_LABELS.botId]: 'bot-1' },
    });
    await expect(client.create(computerSpec('bot-1'))).rejects.toBeInstanceOf(
      SupervisorRefusedError,
    );
    expect(engine.created).toEqual([]);
  });
});

describe('D-200 only the supervisor’s own resources are acted on', () => {
  it('fences another deployment even when its resources carry the same managed label', async () => {
    const { client, engine } = await start();
    const labels = { [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY };
    const foreign = engine.addForeign(labels, [], 'another-deployment-network');
    const volume = workspaceVolumeNameFor('other-computer');
    engine.volumes.set(volume, {
      name: volume,
      labels: {
        ...labels,
        [SANDBOX_LABELS.botId]: 'other-computer',
        [SUPERVISOR_NETWORK_LABEL]: 'another-deployment-network',
      },
    });
    expect(await client.listByLabel(SANDBOX_LABELS.managedBy, SANDBOX_MANAGED_BY)).toEqual([]);
    expect(await client.findById(foreign)).toBeNull();
    expect(await client.listWorkspaceVolumes()).toEqual([]);
    for (const verb of ['start', 'stop', 'remove'] as const) {
      await expect(client.call(SUPERVISOR_PATHS[verb], { id: foreign })).rejects.toMatchObject({
        statusCode: 403,
      });
    }
    await expect(client.removeWorkspaceVolume(volume)).rejects.toMatchObject({ statusCode: 403 });
    await expect(client.workspaceMarker(volume, IMAGE, Date.now(), true)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(engine.containers.get(foreign)?.running).toBe(true);
    expect(engine.volumes.has(volume)).toBe(true);
    expect(engine.calls).toEqual([]);
  });
  it('refuses to start, stop or remove a container it did not create', async () => {
    const { client, engine } = await start();
    const foreign = engine.addForeign({ 'com.example': 'theirs' });
    const handle = await client.findById(foreign);
    // A foreign container is not found by id either: there is no handle to misuse.
    expect(handle).toBeNull();
    for (const verb of ['start', 'stop', 'remove'] as const) {
      const error = await client
        .call(SUPERVISOR_PATHS[verb], { id: foreign })
        .catch((e: unknown) => e);
      expect((error as SupervisorRefusedError).statusCode).toBe(403);
    }
    expect(engine.containers.has(foreign)).toBe(true);
    expect(engine.calls).toEqual([]);
  });

  it('shows a foreign writer on a workspace without its labels or ports', async () => {
    const { client, engine } = await start();
    await withWorkspace(client, 'bot-1');
    const volume = workspaceVolumeNameFor('bot-1');
    const foreign = engine.addForeign({ secret: 'label' }, [
      { volume, path: SANDBOX_WORKING_DIRECTORY },
    ]);
    const [writer] = await client.listByVolume(volume);
    expect(writer?.id).toBe(foreign);
    const status = await writer!.inspect();
    // Enough for the provider to refuse a second writer, and nothing more.
    expect(status.running).toBe(true);
    expect(status.mounts).toEqual([{ volume, path: SANDBOX_WORKING_DIRECTORY }]);
    expect(status.labels).toEqual({});
    expect(status.portBindings).toEqual({});
  });

  it('answers label lookups with managed containers only, and only on its own labels', async () => {
    const { client, engine } = await start();
    engine.addForeign({ [SANDBOX_LABELS.sessionId]: 'crewaid-bot-9' });
    expect(await client.findByLabel(SANDBOX_LABELS.sessionId, 'crewaid-bot-9')).toBeNull();
    await expect(
      client.findByLabel('com.docker.compose.project', 'crewaid'),
    ).rejects.toBeInstanceOf(SupervisorRefusedError);
  });

  it('refuses to label, mark, retire or remove a volume outside its own', async () => {
    const { client, engine } = await start();
    await expect(
      client.createVolume({
        name: workspaceVolumeNameFor('bot-1'),
        labels: { [SANDBOX_LABELS.botId]: 'bot-2', [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY },
      }),
    ).rejects.toBeInstanceOf(SupervisorRefusedError);
    await expect(client.createVolume({ name: 'postgres-data', labels: {} })).rejects.toBeInstanceOf(
      SupervisorRefusedError,
    );
    engine.volumes.set(workspaceVolumeNameFor('bot-3'), {
      name: workspaceVolumeNameFor('bot-3'),
      labels: {},
    });
    await expect(
      client.removeWorkspaceVolume(workspaceVolumeNameFor('bot-3')),
    ).rejects.toBeInstanceOf(SupervisorRefusedError);
    await expect(
      client.workspaceMarker(workspaceVolumeNameFor('bot-3'), IMAGE, Date.now(), true),
    ).rejects.toBeInstanceOf(SupervisorRefusedError);
    await expect(
      client.retireBotProfile(workspaceVolumeNameFor('bot-3'), IMAGE, 'bot-2'),
    ).rejects.toBeInstanceOf(SupervisorRefusedError);
    await withWorkspace(client, 'bot-1');
    await expect(
      client.workspaceMarker(workspaceVolumeNameFor('bot-1'), 'alpine:latest', Date.now(), true),
    ).rejects.toBeInstanceOf(SupervisorRefusedError);
    // The same verbs on its own volume go through.
    await client.retireBotProfile(workspaceVolumeNameFor('bot-1'), IMAGE, 'bot-1');
    await client.workspaceMarker(workspaceVolumeNameFor('bot-1'), IMAGE, Date.now(), true);
    await client.removeWorkspaceVolume(workspaceVolumeNameFor('bot-1'));
    expect(engine.calls).toEqual([
      `retire ${workspaceVolumeNameFor('bot-1')}`,
      `marker ${workspaceVolumeNameFor('bot-1')}`,
      `remove-volume ${workspaceVolumeNameFor('bot-1')}`,
    ]);
    expect(engine.volumes.has(workspaceVolumeNameFor('bot-3'))).toBe(true);
  });

  it('treats a container that is already gone as stopped and removed', async () => {
    const { client } = await start();
    await withWorkspace(client, 'bot-1');
    const container = await client.create(computerSpec('bot-1'));
    await container.remove();
    await container.stop();
    await container.remove();
    await expect(container.inspect()).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses an existing volume with a forged owner before reusing or mutating it', async () => {
    const { client, engine } = await start();
    const volume = workspaceVolumeNameFor('bot-1');
    engine.volumes.set(volume, {
      name: volume,
      labels: { [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY, [SANDBOX_LABELS.botId]: 'bot-2' },
    });
    await expect(withWorkspace(client, 'bot-1')).rejects.toMatchObject({ statusCode: 403 });
    await expect(client.workspaceMarker(volume, IMAGE, Date.now(), true)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(client.removeWorkspaceVolume(volume)).rejects.toMatchObject({ statusCode: 403 });
    expect(engine.calls).toEqual([]);
    expect(engine.volumes.get(volume)?.labels[SANDBOX_LABELS.botId]).toBe('bot-2');
  });
});

describe('D-200 an unreachable supervisor fails safe', () => {
  it('reattaches the existing computer after the supervisor process restarts', async () => {
    const { client, engine, url } = await start();
    await withWorkspace(client, 'bot-1');
    const container = await client.create(computerSpec('bot-1'));
    await container.start();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    await expect(container.inspect()).rejects.toThrow('did not answer');
    expect(engine.containers.get(container.id)?.running).toBe(true);
    server = createSupervisorServer({ config, engine, audit: () => {} });
    await new Promise<void>((resolve) =>
      server!.listen(Number(new URL(url).port), '127.0.0.1', resolve),
    );
    const attached = await client.findById(container.id);
    expect(attached?.id).toBe(container.id);
    expect((await attached!.inspect()).running).toBe(true);
    await attached!.stop();
    await attached!.remove();
    expect(engine.created).toHaveLength(1);
    expect(engine.volumes.has(workspaceVolumeNameFor('bot-1'))).toBe(true);
  });
  it('does not turn a failed inspection into a missing computer, and recovers on the next pass', async () => {
    const { client, engine } = await start();
    await withWorkspace(client, 'bot-1');
    const container = await client.create(computerSpec('bot-1'));
    await container.start();
    const list = engine.listByLabel.bind(engine);
    vi.spyOn(engine, 'listByLabel').mockResolvedValueOnce([
      {
        ...engine.handle(container.id),
        inspect: () => Promise.reject(new Error('daemon connection lost')),
      },
    ]);
    await expect(
      client.listByLabel(SANDBOX_LABELS.managedBy, SANDBOX_MANAGED_BY),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(engine.containers.get(container.id)?.running).toBe(true);
    expect(engine.calls).toEqual([`start ${container.id}`]);
    expect(
      (await list(SANDBOX_LABELS.managedBy, SANDBOX_MANAGED_BY)).map((handle) => handle.id),
    ).toEqual([container.id]);
    expect(
      (await client.listByLabel(SANDBOX_LABELS.managedBy, SANDBOX_MANAGED_BY)).map(
        (handle) => handle.id,
      ),
    ).toEqual([container.id]);
  });
  it('is an outage error naming the supervisor, not a refusal', async () => {
    const client = new SupervisorEngine({
      url: 'http://127.0.0.1:1',
      secret: SECRET,
      timeoutMs: 2_000,
    });
    const error = await client.listWorkspaceVolumes().catch((e: unknown) => e);
    expect(HarnessError.isInstance(error)).toBe(true);
    expect(error).not.toBeInstanceOf(SupervisorRefusedError);
    expect((error as Error).message).toMatch(/did not answer/);
  });
});
