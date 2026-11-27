import { describe, expect, it } from 'vitest';
import {
  MachineProcessError,
  MachineProcessService,
  type ManagedProcessInfo,
  type ManagedProcessOutput,
} from '../src/sandbox/machine-process.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { SandboxProvider } from '../src/sandbox/sandbox.provider.js';
import type { ComputerOwner, KeepRunningLease, SandboxLeaseService } from '../src/sandbox/sandbox-lease.service.js';
import type { StructuredLogger } from '../src/logging/structured-logger.js';

const BOT = 'bot-1';

function makeInfo(overrides: Partial<ManagedProcessInfo> = {}): ManagedProcessInfo {
  return {
    processId: 'proc-111',
    botId: BOT,
    runId: 'run-a',
    command: 'pnpm dev',
    cwd: `/home/bot/agents/${BOT}`,
    status: 'running',
    exitCode: null,
    stopReason: null,
    startedAtMs: 1_000,
    expiresAtMs: 1_801_000,
    maxDurationSec: 1800,
    remainingSec: 1800,
    elapsedMs: 0,
    totalBytes: 0,
    droppedBytes: 0,
    ...overrides,
  };
}

function setup(options: {
  sandboxState?: 'RUNNING' | 'STOPPED';
  fetchHandler: (url: URL, init?: RequestInit) => Promise<Response> | Response;
  onRelease?: (botId: string) => Promise<void>;
}) {
  const acquired: Array<{ userId: string; botId: string; owner: ComputerOwner }> = [];
  let released = 0;

  const prisma = {
    sandbox: {
      findFirst: async () => ({
        id: 'sandbox-1',
        sessionId: 'session-1',
        state: options.sandboxState ?? 'RUNNING',
      }),
    },
  } as unknown as PrismaService;

  const provider = {
    attachSession: async () => ({
      getPortEndpoint: async () => ({
        url: 'http://127.0.0.1:7070',
        headers: { 'x-bridge-auth': 'tok' },
      }),
    }),
  } as unknown as SandboxProvider;

  const leases = {
    acquire: async (
      userId: string,
      botId: string,
      owner: ComputerOwner,
    ): Promise<KeepRunningLease> => {
      acquired.push({ userId, botId, owner });
      return {
        botId,
        renew: async () => true,
        release: async () => {
          if (options.onRelease !== undefined) {
            await options.onRelease(botId);
          }
          released += 1;
        },
      };
    },
  } as unknown as SandboxLeaseService;

  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as StructuredLogger;

  const service = new MachineProcessService(prisma, provider, leases, logger);
  service.configureForTests({
    watchWaitMs: 50,
    watchMinIntervalMs: 5,
    fetchImpl: async (input, init) => options.fetchHandler(new URL(String(input)), init),
  });

  return { service, acquired, released: () => released };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MachineProcessService', () => {
  it('acquires a background-process lease and releases it via the exit watcher when the process finishes', async () => {
    let pollCount = 0;
    const watchOffsets: Array<string | null> = [];
    const { service, acquired, released } = setup({
      fetchHandler: (url, init) => {
        if (init?.method === 'POST' && url.pathname === '/processes') {
          return jsonResponse({ ok: true, process: makeInfo() });
        }
        if (init?.method === 'GET' && url.pathname === '/processes/proc-111') {
          pollCount += 1;
          watchOffsets.push(url.searchParams.get('offset'));
          const proc: ManagedProcessOutput = {
            ...makeInfo({
              status: pollCount >= 2 ? 'exited' : 'running',
              exitCode: pollCount >= 2 ? 0 : null,
            }),
            output: '',
            offset: 0,
            nextOffset: pollCount * 10,
            truncated: false,
          };
          return jsonResponse({ ok: true, process: proc });
        }
        return jsonResponse({ ok: false }, 404);
      },
    });

    await service.start({
      userId: 'user-1',
      botId: BOT,
      runId: 'run-a',
      command: 'pnpm test',
      cwd: `/home/bot/agents/${BOT}`,
    });

    expect(acquired).toEqual([{ userId: 'user-1', botId: BOT, owner: 'background-process' }]);

    // Wait briefly for the exit watcher to observe status === 'exited' and release the lease.
    for (let i = 0; i < 40 && released() === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(pollCount).toBeGreaterThanOrEqual(2);
    expect(released()).toBe(1);
    // The watcher reads past all output, so the bridge sends status and no log bytes.
    expect(new Set(watchOffsets)).toEqual(new Set([String(Number.MAX_SAFE_INTEGER)]));
    service.onModuleDestroy();
  });

  it('stopRun terminates only the cancelled run and never wakes a stopped computer', async () => {
    const stopRunCalls: unknown[] = [];
    const { service, released } = setup({
      fetchHandler: (url, init) => {
        if (init?.method === 'POST' && url.pathname === '/processes') {
          const body = JSON.parse(String(init.body)) as { runId?: string };
          return jsonResponse({
            ok: true,
            process: makeInfo({ processId: `proc-${body.runId}`, runId: body.runId ?? null }),
          });
        }
        if (init?.method === 'POST' && url.pathname === '/processes/stop-run') {
          const body = JSON.parse(String(init.body)) as { runId: string };
          stopRunCalls.push(body);
          return jsonResponse({ ok: true, stopped: [`proc-${body.runId}`] });
        }
        return jsonResponse({
          ok: true,
          process: { ...makeInfo(), output: '', offset: 0, nextOffset: 0, truncated: false },
        });
      },
    });

    await service.start({
      userId: 'user-1',
      botId: BOT,
      runId: 'run-keep',
      command: 'pnpm dev',
      cwd: `/home/bot/agents/${BOT}`,
    });
    await service.start({
      userId: 'user-1',
      botId: BOT,
      runId: 'run-cancel',
      command: 'pnpm load-test',
      cwd: `/home/bot/agents/${BOT}`,
    });

    const stopped = await service.stopRun(BOT, 'run-cancel');
    expect(stopped).toEqual(['proc-run-cancel']);
    expect(stopRunCalls).toEqual([{ botId: BOT, runId: 'run-cancel' }]);
    // Only the cancelled run's lease was released; run-keep's stays held until destroy.
    expect(released()).toBe(1);
    service.onModuleDestroy();
    expect(released()).toBe(2);

    let fetchedStopped = false;
    const stoppedBox = setup({
      sandboxState: 'STOPPED',
      fetchHandler: () => {
        fetchedStopped = true;
        return jsonResponse({ ok: true });
      },
    });
    expect(await stoppedBox.service.stopRun(BOT, 'run-x')).toEqual([]);
    expect(fetchedStopped).toBe(false);
  });

  it('distinguishes older image 404 from NO_SUCH_PROCESS 404 and releases lease on failed start', async () => {
    const oldImage = setup({
      fetchHandler: () => jsonResponse({ ok: false, detail: 'no route /processes' }, 404),
    });
    await expect(
      oldImage.service.start({
        userId: 'user-1',
        botId: BOT,
        command: 'pnpm dev',
        cwd: `/home/bot/agents/${BOT}`,
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_UPGRADE_REQUIRED' });
    expect(oldImage.released()).toBe(1);

    const missing = setup({
      fetchHandler: () => jsonResponse({ ok: false, code: 'NO_SUCH_PROCESS' }, 404),
    });
    await expect(missing.service.readOutput({ botId: BOT, processId: 'proc-gone' })).resolves.toBeNull();
    expect(MachineProcessError).toBeDefined();
  });

  it('awaits pending lease releases during onModuleDestroy and survives a rejected release', async () => {
    const resolvers: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
    let callIndex = 0;
    const { service, released } = setup({
      fetchHandler: (url, init) => {
        if (init?.method === 'POST' && url.pathname === '/processes') {
          const body = JSON.parse(String(init.body)) as { runId?: string };
          return jsonResponse({
            ok: true,
            process: makeInfo({ processId: `proc-${body.runId}`, runId: body.runId ?? null }),
          });
        }
        return jsonResponse({
          ok: true,
          process: { ...makeInfo(), output: '', offset: 0, nextOffset: 0, truncated: false },
        });
      },
      onRelease: () =>
        new Promise<void>((resolve, reject) => {
          callIndex += 1;
          resolvers.push({ resolve, reject });
        }),
    });

    await service.start({
      userId: 'user-1',
      botId: BOT,
      runId: 'run-slow',
      command: 'pnpm dev',
      cwd: `/home/bot/agents/${BOT}`,
    });
    await service.start({
      userId: 'user-1',
      botId: BOT,
      runId: 'run-failing-release',
      command: 'pnpm dev',
      cwd: `/home/bot/agents/${BOT}`,
    });

    let destroySettled = false;
    const destroying = Promise.resolve(service.onModuleDestroy()).then(() => {
      destroySettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(callIndex).toBe(2);
    expect(destroySettled).toBe(false);

    resolvers[0]!.resolve();
    resolvers[1]!.reject(new Error('db already closed'));
    await destroying;

    expect(destroySettled).toBe(true);
    expect(released()).toBe(1);
  });
});
