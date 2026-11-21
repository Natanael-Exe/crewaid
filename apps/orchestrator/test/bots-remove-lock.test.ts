import { describe, expect, it, vi } from 'vitest';
import { BotsService } from '../src/bots/bots.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { SandboxProvider } from '../src/sandbox/sandbox.provider.js';
import type { SeatService } from '../src/sandbox/seat.service.js';
import type { TurnEventBus } from '../src/agent/turn-event.bus.js';

describe('BotsService.remove — out-of-transaction sandbox teardown', () => {
  function setup(options: { destroyThrows?: Error } = {}) {
    let inTx = false;
    const events: string[] = [];
    let sandboxState = 'RUNNING';
    let botDeleted = false;
    let sandboxDeleted = false;

    const tx = {
      $executeRaw: vi.fn(async () => 0),
      bot: {
        findFirst: vi.fn(async () =>
          botDeleted
            ? null
            : { id: 'bot-1', userId: 'user-1', name: 'Quill', kind: 'WORKER', sandboxId: 'sb-1' },
        ),
        count: vi.fn(async () => 0),
        delete: vi.fn(async () => {
          botDeleted = true;
          events.push('tx:bot.delete');
        }),
      },
      sandbox: {
        findUnique: vi.fn(async () => ({ id: 'sb-1', sessionId: 'sess-1', state: sandboxState })),
        update: vi.fn(async ({ data }: { data: { state: string } }) => {
          sandboxState = data.state;
          events.push(`tx:sandbox.update:${data.state}`);
        }),
        delete: vi.fn(async () => {
          sandboxDeleted = true;
          events.push('tx:sandbox.delete');
        }),
      },
      task: {
        findMany: vi.fn(async () => []),
      },
      deliverable: {
        findMany: vi.fn(async () => []),
      },
      attachment: {
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
    };

    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
        inTx = true;
        events.push('tx:start');
        try {
          return await fn(tx);
        } finally {
          inTx = false;
          events.push('tx:end');
        }
      }),
      sandbox: {
        updateMany: vi.fn(async ({ data }: { data: { state: string } }) => {
          sandboxState = data.state;
          events.push(`prisma:sandbox.restore:${data.state}`);
          return { count: 1 };
        }),
      },
    };

    const provider = {
      attachSession: vi.fn(async () => {
        expect(inTx, 'attachSession must not run inside a DB transaction').toBe(false);
        events.push('provider:attachSession');
        return {
          destroy: vi.fn(async () => {
            expect(inTx, 'session.destroy must not run inside a DB transaction').toBe(false);
            events.push('provider:destroy');
            if (options.destroyThrows) throw options.destroyThrows;
          }),
        };
      }),
      listManagedSessions: vi.fn(async () => {
        expect(inTx, 'listManagedSessions must not run inside a DB transaction').toBe(false);
        events.push('provider:listManagedSessions');
        return [{ botId: 'sb-1', containerId: 'ctr-1' }];
      }),
      removeManagedSession: vi.fn(async () => {
        expect(inTx, 'removeManagedSession must not run inside a DB transaction').toBe(false);
        events.push('provider:removeManagedSession');
      }),
    };

    const seatService = { releaseSeat: vi.fn(async () => false) };
    const turnBus = {
      emitBotsChanged: vi.fn(),
      emitWorkChanged: vi.fn(),
    };

    const service = new BotsService(
      prisma as unknown as PrismaService,
      provider as unknown as SandboxProvider,
      seatService as unknown as SeatService,
      turnBus as unknown as TurnEventBus,
    );

    return {
      service,
      events,
      getState: () => ({ sandboxState, botDeleted, sandboxDeleted }),
    };
  }

  it('fences sandbox, destroys runtime outside any transaction, then deletes rows', async () => {
    const { service, events, getState } = setup();
    await service.remove('user-1', 'bot-1');

    expect(getState()).toEqual({
      sandboxState: 'STARTING',
      botDeleted: true,
      sandboxDeleted: true,
    });
    expect(events).toEqual([
      'tx:start',
      'tx:sandbox.update:STARTING',
      'tx:end',
      'provider:attachSession',
      'provider:destroy',
      'provider:listManagedSessions',
      'provider:removeManagedSession',
      'tx:start',
      'tx:bot.delete',
      'tx:sandbox.delete',
      'tx:end',
    ]);
  });

  it('restores sandbox state and preserves rows if runtime destruction fails', async () => {
    const { service, events, getState } = setup({ destroyThrows: new Error('docker timeout') });
    await expect(service.remove('user-1', 'bot-1')).rejects.toThrow('docker timeout');

    expect(getState()).toEqual({
      sandboxState: 'RUNNING',
      botDeleted: false,
      sandboxDeleted: false,
    });
    expect(events).toContain('prisma:sandbox.restore:RUNNING');
    expect(events).not.toContain('tx:bot.delete');
  });
});
