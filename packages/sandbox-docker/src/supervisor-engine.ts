/**
 * `ContainerEngine` over the sandbox supervisor.
 *
 * The provider's lifecycle logic is unchanged: it still asks for a network, a
 * volume, a container. What changed is who answers. The supervisor holds the
 * Docker socket and decides what each verb may do; this side only signs the
 * request and turns the answer back into the port's shapes.
 *
 * A container's commands do not go through the supervisor at all. `spawn`
 * opens the computer's own agent-bridge `/exec`, the path every hosted
 * provider already uses, so the supervisor needs no exec verb to give
 * away.
 */

import { HarnessError, bridgeExec, SANDBOX_PORTS } from '@crewaid/sandbox-core';
import type {
  ContainerExecSpec,
  ContainerProcess,
  ContainerStatus,
  SandboxContainer,
} from '@crewaid/sandbox-core';

import type { ContainerCreateSpec, ContainerEngine, WorkspaceVolume } from './container-engine.js';
import {
  MIN_SECRET_LENGTH,
  SIGNATURE_HEADER,
  SUPERVISOR_PATHS,
  fromWireStatus,
  signRequest,
  type SupervisorRefusal,
  type WireContainerStatus,
} from './supervisor-protocol.js';

/** Thrown when the supervisor answers no, so a caller can tell a refusal from an outage. */
export class SupervisorRefusedError extends HarnessError {
  readonly code: SupervisorRefusal['code'];
  /**
   * The HTTP status, under the name Docker's errors use, so the provider's
   * existing "404 means already gone" checks read a supervisor answer the
   * same way they read the daemon's.
   */
  readonly statusCode: number;

  constructor(path: string, statusCode: number, refusal: SupervisorRefusal) {
    super({ message: `sandbox supervisor refused ${path}: ${refusal.error}` });
    this.code = refusal.code;
    this.statusCode = statusCode;
  }
}

export interface SupervisorEngineOptions {
  /** `SANDBOX_SUPERVISOR_URL`, e.g. `http://sandbox-supervisor:7300`. */
  readonly url: string;
  /** `SANDBOX_SUPERVISOR_SECRET`. Signs requests; never sent. */
  readonly secret: string;
  /** Seam for tests. */
  readonly fetch?: typeof fetch;
  /** Per-request deadline. A wedged supervisor must not hold a lifecycle lock forever. */
  readonly timeoutMs?: number;
}

/** Read at construction, so a missing URL or secret fails the boot rather than the first start. */
export function readSupervisorOptions(env: NodeJS.ProcessEnv): SupervisorEngineOptions {
  const url = env['SANDBOX_SUPERVISOR_URL'] ?? '';
  const secret = env['SANDBOX_SUPERVISOR_SECRET'] ?? '';
  if (url === '') {
    throw new Error(
      'SANDBOX_SUPERVISOR_URL is required for SANDBOX_PROVIDER=docker: the orchestrator reaches ' +
        'Docker only through the sandbox supervisor (D-200).',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('SANDBOX_SUPERVISOR_URL must be an http:// URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('SANDBOX_SUPERVISOR_URL must be an http:// URL');
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SANDBOX_SUPERVISOR_SECRET must be at least ${MIN_SECRET_LENGTH} characters ` +
        '(openssl rand -hex 32), and the same value the supervisor has.',
    );
  }
  return { url: parsed.origin, secret };
}

export class SupervisorEngine implements ContainerEngine {
  readonly #url: string;
  readonly #secret: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: SupervisorEngineOptions) {
    this.#url = options.url.replace(/\/+$/, '');
    this.#secret = options.secret;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** One signed call. A refusal throws `SupervisorRefusedError`; anything else is an outage. */
  async call<T>(path: string, body: unknown = {}): Promise<T> {
    const text = JSON.stringify(body);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: signRequest(this.#secret, { method: 'POST', path, body: text }),
        },
        body: text,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new HarnessError({
        message:
          `the sandbox supervisor at ${this.#url} did not answer ${path}. ` +
          'Computers cannot start or stop until it is back. The action may have completed; ' +
          'reconcile its state after recovery.',
        cause: error,
      });
    }
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new SupervisorRefusedError(path, response.status, asRefusal(parsed));
    }
    return parsed as T;
  }

  async listWorkspaceVolumes(): Promise<readonly WorkspaceVolume[]> {
    return (await this.call<{ volumes: WorkspaceVolume[] }>(SUPERVISOR_PATHS.listWorkspaceVolumes))
      .volumes;
  }

  async retireBotProfile(volumeName: string, image: string, botId: string): Promise<void> {
    await this.call(SUPERVISOR_PATHS.retireBotProfile, { volume: volumeName, image, botId });
  }

  async workspaceMarker(
    name: string,
    image: string,
    now: number,
    clear: boolean,
    history?: 'read' | 'write',
  ): Promise<number | null> {
    return (
      await this.call<{ value: number | null }>(SUPERVISOR_PATHS.workspaceMarker, {
        volume: name,
        image,
        now,
        clear,
        ...(history !== undefined ? { history } : {}),
      })
    ).value;
  }

  async removeWorkspaceVolume(name: string): Promise<void> {
    await this.call(SUPERVISOR_PATHS.removeWorkspaceVolume, { volume: name });
  }

  async ensureNetwork(name: string): Promise<void> {
    await this.call(SUPERVISOR_PATHS.ensureNetwork, { network: name });
  }

  async create(spec: ContainerCreateSpec): Promise<SandboxContainer> {
    const { id } = await this.call<{ id: string }>(SUPERVISOR_PATHS.create, spec);
    return new SupervisedContainer(this, id);
  }

  async findByLabel(label: string, value: string): Promise<SandboxContainer | null> {
    const { id } = await this.call<{ id: string | null }>(SUPERVISOR_PATHS.findByLabel, {
      label,
      value,
    });
    return id === null ? null : new SupervisedContainer(this, id);
  }

  async listByLabel(label: string, value: string): Promise<readonly SandboxContainer[]> {
    const { ids } = await this.call<{ ids: string[] }>(SUPERVISOR_PATHS.listByLabel, {
      label,
      value,
    });
    return ids.map((id) => new SupervisedContainer(this, id));
  }

  async listByVolume(volumeName: string): Promise<readonly SandboxContainer[]> {
    const { ids } = await this.call<{ ids: string[] }>(SUPERVISOR_PATHS.listByVolume, {
      volume: volumeName,
    });
    return ids.map((id) => new SupervisedContainer(this, id));
  }

  async findById(id: string): Promise<SandboxContainer | null> {
    const found = await this.call<{ id: string | null }>(SUPERVISOR_PATHS.findById, { id });
    return found.id === null ? null : new SupervisedContainer(this, found.id);
  }

  async findVolume(name: string): Promise<WorkspaceVolume | null> {
    return (
      await this.call<{ volume: WorkspaceVolume | null }>(SUPERVISOR_PATHS.findVolume, {
        volume: name,
      })
    ).volume;
  }

  async createVolume(spec: {
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
  }): Promise<WorkspaceVolume> {
    return (
      await this.call<{ volume: WorkspaceVolume }>(SUPERVISOR_PATHS.createVolume, {
        volume: spec.name,
        labels: spec.labels,
      })
    ).volume;
  }
}

/** A computer the supervisor created, addressed by id. */
class SupervisedContainer implements SandboxContainer {
  constructor(
    private readonly engine: SupervisorEngine,
    readonly id: string,
  ) {}

  async start(): Promise<void> {
    await this.engine.call(SUPERVISOR_PATHS.start, { id: this.id });
  }

  /** Idempotent, as the port promises: a container that is already gone is stopped. */
  async stop(timeoutSeconds?: number): Promise<void> {
    await this.engine
      .call(SUPERVISOR_PATHS.stop, {
        id: this.id,
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      })
      .catch(ignoreGone);
  }

  async remove(): Promise<void> {
    await this.engine.call(SUPERVISOR_PATHS.remove, { id: this.id }).catch(ignoreGone);
  }

  async inspect(): Promise<ContainerStatus> {
    const { status } = await this.engine.call<{ status: WireContainerStatus }>(
      SUPERVISOR_PATHS.inspect,
      { id: this.id },
    );
    return fromWireStatus(status);
  }

  /** Through the computer's own bridge, never the daemon (D-200). */
  async spawn(spec: ContainerExecSpec): Promise<ContainerProcess> {
    const status = await this.inspect();
    const bridge = status.portBindings[SANDBOX_PORTS.bridge];
    if (!status.running || bridge === undefined) {
      throw new HarnessError({
        message: `container ${this.id} is not running, so its agent-bridge cannot run a command`,
      });
    }
    return bridgeExec({ host: bridge.host, port: bridge.port }, spec);
  }
}

function ignoreGone(error: unknown): void {
  if (error instanceof SupervisorRefusedError && error.statusCode === 404) return;
  throw error;
}

function asRefusal(body: unknown): SupervisorRefusal {
  if (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'string' &&
    'code' in body &&
    typeof body.code === 'string'
  ) {
    return body as SupervisorRefusal;
  }
  return { error: 'no reason given', code: 'failed' };
}
