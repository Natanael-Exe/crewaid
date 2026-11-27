import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { SANDBOX_PORTS } from '@crewaid/sandbox-core';

import { StructuredLogger } from '../logging/structured-logger.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { computerOfBot } from './attached-computer.js';
import { SANDBOX_PROVIDER, type SandboxProvider } from './sandbox.provider.js';
import { SandboxLeaseService, type KeepRunningLease } from './sandbox-lease.service.js';

/**
 * Orchestrator client for `agent-bridge`'s managed background processes (D-241 Step 2).
 *
 * Each running background process holds a `'background-process'` keep-running lease
 * backed by an exit watcher that long-polls the bridge and releases the lease the
 * moment the process exits, is stopped, or the container becomes unreachable.
 *
 * Watchers and lease handles live in orchestrator memory: an orchestrator restart
 * clears them so the lease lapses and idle-stop may eventually pause a surviving
 * process, matching WORKSPACE §17's crash-recovery contract.
 */

export interface ManagedProcessInfo {
  readonly processId: string;
  readonly botId: string;
  readonly runId: string | null;
  readonly command: string;
  readonly cwd: string;
  readonly status: 'running' | 'exited';
  readonly exitCode: number | null;
  readonly stopReason: string | null;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly maxDurationSec: number;
  readonly remainingSec: number;
  readonly elapsedMs: number;
  readonly totalBytes: number;
  readonly droppedBytes: number;
}

export interface ManagedProcessOutput extends ManagedProcessInfo {
  readonly output: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly truncated: boolean;
}

export interface StartManagedProcessInput {
  readonly userId: string;
  readonly botId: string;
  readonly runId?: string | undefined;
  readonly command: string;
  readonly cwd: string;
  readonly env?: Record<string, string> | undefined;
  readonly maxDurationSec?: number | undefined;
}

export interface ReadManagedProcessInput {
  readonly botId: string;
  readonly processId: string;
  readonly offset?: number | undefined;
  readonly waitMs?: number | undefined;
  readonly abortSignal?: AbortSignal | undefined;
}

export class MachineProcessError extends Error {
  constructor(
    message: string,
    readonly code: string = 'PROCESS_FAILED',
  ) {
    super(message);
    this.name = 'MachineProcessError';
  }
}

export interface MachineProcessPort {
  start(input: StartManagedProcessInput): Promise<ManagedProcessInfo>;
  list(botId: string): Promise<readonly ManagedProcessInfo[]>;
  readOutput(input: ReadManagedProcessInput): Promise<ManagedProcessOutput | null>;
  stop(botId: string, processId: string): Promise<ManagedProcessOutput | null>;
}

const DEFAULT_BRIDGE_TIMEOUT_MS = 15_000;
const WATCH_WAIT_MS = 25_000;
const WATCH_MIN_INTERVAL_MS = 2_000;
/**
 * The offset the exit watcher reads from: past any output a process can write.
 * The bridge then waits for exit (or `waitMs`) and sends no bytes, so a chatty
 * dev server's logs never cross the bridge only to learn it is still running.
 */
const WATCH_OFFSET = Number.MAX_SAFE_INTEGER;
const OLD_IMAGE_MESSAGE =
  'this computer is running an older image without managed background processes. ' +
  'Upgrade the computer image or use shell for short commands.';

type ActiveWatcher = {
  readonly botId: string;
  readonly runId: string | null;
  readonly lease: KeepRunningLease;
  readonly controller: AbortController;
};

type BridgeResponse = {
  readonly ok?: boolean;
  readonly code?: string;
  readonly detail?: string;
  readonly process?: ManagedProcessInfo | ManagedProcessOutput;
  readonly processes?: ManagedProcessInfo[];
  readonly stopped?: string[];
};

function watcherKey(botId: string, processId: string): string {
  return `${botId}:${processId}`;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

@Injectable()
export class MachineProcessService implements MachineProcessPort, OnModuleDestroy {
  private readonly watchers = new Map<string, ActiveWatcher>();
  private watchWaitMs = WATCH_WAIT_MS;
  private watchMinIntervalMs = WATCH_MIN_INTERVAL_MS;
  private fetchImpl: typeof fetch = fetch;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SANDBOX_PROVIDER) private readonly provider: SandboxProvider,
    @Inject(SandboxLeaseService) private readonly leases: SandboxLeaseService,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  /** Test seam for deterministic fast polling and fake bridge servers. */
  configureForTests(options: {
    readonly watchWaitMs?: number;
    readonly watchMinIntervalMs?: number;
    readonly fetchImpl?: typeof fetch;
  }): void {
    if (options.watchWaitMs !== undefined) this.watchWaitMs = options.watchWaitMs;
    if (options.watchMinIntervalMs !== undefined)
      this.watchMinIntervalMs = options.watchMinIntervalMs;
    if (options.fetchImpl !== undefined) this.fetchImpl = options.fetchImpl;
  }

  async start(input: StartManagedProcessInput): Promise<ManagedProcessInfo> {
    const sessionId = await this.requireSessionId(input.botId);
    const lease = await this.leases.acquire(input.userId, input.botId, 'background-process');
    try {
      const reply = await this.bridge(sessionId, '/processes', {
        body: {
          botId: input.botId,
          command: input.command,
          cwd: input.cwd,
          ...(input.env !== undefined ? { env: input.env } : {}),
          ...(input.runId !== undefined ? { runId: input.runId } : {}),
          ...(input.maxDurationSec !== undefined ? { maxDurationSec: input.maxDurationSec } : {}),
        },
      });
      if (reply?.process === undefined) {
        throw new MachineProcessError('bridge returned no process record');
      }
      const started = reply.process;
      if (started.status === 'running') {
        this.registerWatcher(
          sessionId,
          input.botId,
          input.runId ?? null,
          started.processId,
          lease,
        );
      } else {
        await lease.release();
      }
      return started;
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  async list(botId: string): Promise<readonly ManagedProcessInfo[]> {
    const sessionId = await this.runningSessionId(botId);
    if (sessionId === null) return [];
    const reply = await this.bridge(
      sessionId,
      `/processes?botId=${encodeURIComponent(botId)}`,
    );
    return reply?.processes ?? [];
  }

  async readOutput(input: ReadManagedProcessInput): Promise<ManagedProcessOutput | null> {
    const sessionId = await this.runningSessionId(input.botId);
    if (sessionId === null) return null;
    const params = new URLSearchParams({ botId: input.botId });
    if (input.offset !== undefined) params.set('offset', String(input.offset));
    if (input.waitMs !== undefined) params.set('waitMs', String(input.waitMs));

    const waitMs = input.waitMs ?? 0;
    const reply = await this.bridge(
      sessionId,
      `/processes/${encodeURIComponent(input.processId)}?${params.toString()}`,
      {
        allowNoSuchProcess: true,
        timeoutMs: Math.max(DEFAULT_BRIDGE_TIMEOUT_MS, waitMs + 5_000),
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      },
    );
    if (reply === null || reply.process === undefined) return null;
    const result = reply.process as ManagedProcessOutput;
    if (result.status === 'exited') {
      await this.releaseWatcher(watcherKey(input.botId, input.processId));
    }
    return result;
  }

  async stop(botId: string, processId: string): Promise<ManagedProcessOutput | null> {
    const key = watcherKey(botId, processId);
    const sessionId = await this.runningSessionId(botId);
    if (sessionId === null) {
      await this.releaseWatcher(key);
      return null;
    }
    try {
      const reply = await this.bridge(
        sessionId,
        `/processes/${encodeURIComponent(processId)}/stop`,
        { body: { botId }, allowNoSuchProcess: true },
      );
      if (reply === null || reply.process === undefined) return null;
      return reply.process as ManagedProcessOutput;
    } finally {
      await this.releaseWatcher(key);
    }
  }

  /**
   * Stop every running process started during a cancelled run without waking a
   * stopped computer. Processes from completed turns carry different run IDs and
   * stay untouched.
   */
  async stopRun(botId: string, runId: string): Promise<readonly string[]> {
    const sessionId = await this.runningSessionId(botId);
    const matchingKeys: string[] = [];
    for (const [key, entry] of this.watchers.entries()) {
      if (entry.botId === botId && entry.runId === runId) matchingKeys.push(key);
    }

    let stopped: readonly string[] = [];
    if (sessionId !== null) {
      try {
        const reply = await this.bridge(sessionId, '/processes/stop-run', {
          body: { botId, runId },
          allowOldImage404: true,
        });
        stopped = reply?.stopped ?? [];
      } catch (error) {
        this.logger.warn('sandbox.process.stop-run.failed', {
          botId,
          runId,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const keysToRelease = new Set([
      ...matchingKeys,
      ...stopped.map((processId) => watcherKey(botId, processId)),
    ]);
    await Promise.all([...keysToRelease].map((key) => this.releaseWatcher(key)));
    return stopped;
  }

  async onModuleDestroy(): Promise<void> {
    const releases: Promise<void>[] = [];
    for (const [key, watcher] of [...this.watchers.entries()]) {
      this.watchers.delete(key);
      watcher.controller.abort();
      releases.push(watcher.lease.release());
    }
    await Promise.allSettled(releases);
  }

  private registerWatcher(
    sessionId: string,
    botId: string,
    runId: string | null,
    processId: string,
    lease: KeepRunningLease,
  ): void {
    const key = watcherKey(botId, processId);
    const existing = this.watchers.get(key);
    if (existing !== undefined) {
      existing.controller.abort();
      void existing.lease.release();
    }
    const controller = new AbortController();
    this.watchers.set(key, { botId, runId, lease, controller });
    void this.watchUntilExit(key, sessionId, botId, processId, controller.signal);
  }

  private async watchUntilExit(
    key: string,
    sessionId: string,
    botId: string,
    processId: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      while (!signal.aborted) {
        const startedAt = Date.now();
        const params = new URLSearchParams({
          botId,
          offset: String(WATCH_OFFSET),
          waitMs: String(this.watchWaitMs),
        });
        const reply = await this.bridge(
          sessionId,
          `/processes/${encodeURIComponent(processId)}?${params.toString()}`,
          {
            allowNoSuchProcess: true,
            timeoutMs: this.watchWaitMs + 5_000,
            abortSignal: signal,
          },
        );
        if (reply === null || reply.process === undefined) break;
        const proc = reply.process as ManagedProcessOutput;
        if (proc.status === 'exited') break;
        const elapsed = Date.now() - startedAt;
        if (elapsed < this.watchMinIntervalMs) {
          await abortableDelay(this.watchMinIntervalMs - elapsed, signal);
        }
      }
    } catch {
      // Container stopped, bridge restarted, or watcher aborted — release lease below.
    } finally {
      await this.releaseWatcher(key);
    }
  }

  private async releaseWatcher(key: string): Promise<void> {
    const watcher = this.watchers.get(key);
    if (watcher === undefined) return;
    this.watchers.delete(key);
    watcher.controller.abort();
    await watcher.lease.release();
  }

  private async runningSessionId(botId: string): Promise<string | null> {
    const computer = await computerOfBot(this.prisma, botId, {
      id: true,
      sessionId: true,
      state: true,
    });
    if (computer === null || computer.state !== 'RUNNING') return null;
    return computer.sessionId ?? computer.id;
  }

  private async requireSessionId(botId: string): Promise<string> {
    const computer = await computerOfBot(this.prisma, botId, {
      id: true,
      sessionId: true,
    });
    if (computer === null) throw new MachineProcessError(`bot ${botId} has no computer`);
    return computer.sessionId ?? computer.id;
  }

  private async bridge(
    sessionId: string,
    path: string,
    options: {
      readonly body?: unknown;
      readonly allowNoSuchProcess?: boolean;
      readonly allowOldImage404?: boolean;
      readonly timeoutMs?: number;
      readonly abortSignal?: AbortSignal;
    } = {},
  ): Promise<BridgeResponse | null> {
    const session = await this.provider.attachSession({ sessionId });
    if (session === null) {
      throw new MachineProcessError(`no container is attached to session ${sessionId}`);
    }
    const endpoint = await session.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
    const headers: Record<string, string> = { ...endpoint.headers };
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS);
    const signal =
      options.abortSignal === undefined ? timeout : AbortSignal.any([options.abortSignal, timeout]);

    const response = await this.fetchImpl(new URL(path, endpoint.url), {
      headers,
      signal,
      ...(options.body === undefined
        ? { method: 'GET' }
        : { method: 'POST', body: JSON.stringify(options.body) }),
    });

    const rawText = await response.text().catch(() => '');
    let parsed: BridgeResponse | undefined;
    try {
      const value: unknown = JSON.parse(rawText);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        parsed = value;
      }
    } catch {
      /* Non-JSON body handled below. */
    }

    if (response.status === 404) {
      if (parsed?.code === 'NO_SUCH_PROCESS' && options.allowNoSuchProcess === true) {
        return null;
      }
      if (options.allowOldImage404 === true) return null;
      if (parsed?.code !== 'NO_SUCH_PROCESS') {
        throw new MachineProcessError(OLD_IMAGE_MESSAGE, 'IMAGE_UPGRADE_REQUIRED');
      }
      throw new MachineProcessError('no such managed process', 'NO_SUCH_PROCESS');
    }

    if (!response.ok) {
      const detail = parsed?.detail ?? rawText.slice(0, 200);
      throw new MachineProcessError(
        detail || `the machine refused ${path} with ${response.status}`,
        parsed?.code ?? 'PROCESS_FAILED',
      );
    }

    return parsed ?? {};
  }
}
