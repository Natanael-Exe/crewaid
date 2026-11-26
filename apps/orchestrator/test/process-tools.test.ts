import { describe, expect, it } from 'vitest';
import type { ToolDefinition as Tool } from '../src/agent/tool-contract.js';
import { processTools } from '../src/agent/process-tools.js';
import type { ToolContext } from '../src/agent/tool-registry.js';
import { MACHINE_HOME } from '../src/agent/workspace-paths.js';
import type { Seat } from '../src/sandbox/seat.service.js';
import {
  MachineProcessError,
  type MachineProcessPort,
  type ManagedProcessInfo,
  type ManagedProcessOutput,
  type ReadManagedProcessInput,
  type StartManagedProcessInput,
} from '../src/sandbox/machine-process.service.js';

const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';
const OWN = `${MACHINE_HOME}/agents/${BOT}`;

const SEAT: Seat = {
  seatId: 'seat-1',
  browserGeneration: 1,
  profile: 'private-fixture',
  botId: BOT,
  display: ':10',
  dbusAddress: 'unix:path=/tmp/runtime-bot/seat10.bus',
  rfbPort: 5901,
  cdpPort: 9301,
  browserReady: false,
  identityRevision: 0,
  widthPx: 1280,
  heightPx: 800,
};

function sampleInfo(overrides: Partial<ManagedProcessInfo> = {}): ManagedProcessInfo {
  return {
    processId: 'proc-abc123def456',
    botId: BOT,
    runId: 'run-42',
    command: 'pnpm dev',
    cwd: OWN,
    status: 'running',
    exitCode: null,
    stopReason: null,
    startedAtMs: Date.UTC(2026, 10, 26, 12, 0, 0),
    expiresAtMs: Date.UTC(2026, 10, 26, 12, 30, 0),
    maxDurationSec: 1800,
    remainingSec: 1795,
    elapsedMs: 5_000,
    totalBytes: 12,
    droppedBytes: 0,
    ...overrides,
  };
}

function harness(
  overrides: {
    seat?: Seat | null;
    start?: (input: StartManagedProcessInput) => Promise<ManagedProcessInfo>;
    list?: (botId: string) => Promise<readonly ManagedProcessInfo[]>;
    readOutput?: (input: ReadManagedProcessInput) => Promise<ManagedProcessOutput | null>;
    stop?: (botId: string, processId: string) => Promise<ManagedProcessOutput | null>;
  } = {},
) {
  let woke = 0;
  const started: StartManagedProcessInput[] = [];
  const reads: ReadManagedProcessInput[] = [];
  const processes: MachineProcessPort = {
    start: async (input) => {
      started.push(input);
      return overrides.start ? overrides.start(input) : sampleInfo({ command: input.command, cwd: input.cwd });
    },
    list: async (botId) => (overrides.list ? overrides.list(botId) : []),
    readOutput: async (input) => {
      reads.push(input);
      return overrides.readOutput
        ? overrides.readOutput(input)
        : {
            ...sampleInfo(),
            output: 'ready on http://localhost:3000\n',
            offset: input.offset ?? 0,
            nextOffset: 31,
            truncated: false,
          };
    },
    stop: async (botId, processId) =>
      overrides.stop
        ? overrides.stop(botId, processId)
        : {
            ...sampleInfo({ status: 'exited', exitCode: 143, stopReason: 'stopped', remainingSec: 0 }),
            output: 'shutting down\n',
            offset: 0,
            nextOffset: 14,
            truncated: false,
          },
  };

  const tools = processTools({
    machines: {
      ensureSeatFor: async () => {
        if (overrides.seat === null) throw new Error('no seat');
        return overrides.seat ?? SEAT;
      },
    },
    processes,
  });

  const ctx = {
    userId: 'user-1',
    botId: BOT,
    runId: 'run-42',
    groupId: null,
    attachmentHost: () => Promise.resolve('msg-1'),
    session: async () => {
      woke += 1;
      return {};
    },
  } as unknown as ToolContext;

  const exec = (name: string, input: unknown, options: unknown = {}): Promise<unknown> => {
    const entry = tools.find((item) => item.name === name);
    if (entry === undefined) throw new Error(`missing tool ${name}`);
    const built = entry.build(ctx) as Tool & {
      execute: (arg: unknown, opts: unknown) => Promise<unknown>;
    };
    return built.execute(input, options);
  };

  return { tools, exec, started, reads, woke: () => woke };
}

describe('process tools registration and approval polarity', () => {
  it('classifies process_start as sensitive, process_output as read-only, and process_stop as contained', () => {
    const { tools } = harness();
    const byName = new Map(tools.map((entry) => [entry.name, entry]));
    expect([...byName.keys()].sort()).toEqual(['process_output', 'process_start', 'process_stop']);
    expect(byName.get('process_start')?.behavior.effect).toBe('unknown');
    expect(byName.get('process_output')?.behavior.effect).toBe('read');
    expect(byName.get('process_stop')?.behavior.effect).toBe('draft');
  });
});

describe('process_start', () => {
  it('wakes the computer, passes runId and seat env, and displays the explicit time limit', async () => {
    const h = harness();
    const result = (await h.exec('process_start', {
      command: 'pnpm dev',
      cwd: 'app',
      maxDurationSec: 1800,
    })) as string;

    expect(h.woke()).toBe(1);
    expect(h.started[0]).toMatchObject({
      userId: 'user-1',
      botId: BOT,
      runId: 'run-42',
      command: 'pnpm dev',
      cwd: `${OWN}/app`,
      env: { DISPLAY: ':10', DBUS_SESSION_BUS_ADDRESS: SEAT.dbusAddress },
      maxDurationSec: 1800,
    });
    expect(result).toContain('proc-abc123def456');
    expect(result).toContain('time limit: 30m');
    expect(result).toContain('2026-11-26T12:30:00Z');
  });

  it('refuses a cwd outside the workspace before waking the computer', async () => {
    const h = harness();
    const result = (await h.exec('process_start', { command: 'ls', cwd: '/etc' })) as string;
    expect(result).toContain('process_start refused');
    expect(h.woke()).toBe(0);
    expect(h.started).toHaveLength(0);
  });

  it('surfaces older sandbox image errors cleanly', async () => {
    const h = harness({
      start: async () => {
        throw new MachineProcessError(
          'this computer is running an older image without managed background processes.',
          'IMAGE_UPGRADE_REQUIRED',
        );
      },
    });
    const result = (await h.exec('process_start', { command: 'pnpm dev' })) as string;
    expect(result).toContain('process_start failed');
    expect(result).toContain('older image');
  });
});

describe('process_output', () => {
  it('lists active processes when processId is omitted', async () => {
    const h = harness({ list: async () => [sampleInfo()] });
    const result = (await h.exec('process_output', {})) as string;
    expect(result).toContain('proc-abc123def456');
    expect(result).toContain('pnpm dev');
    expect(result).toContain('29m 55s left');
  });

  it('reads incremental output, shows ring-buffer eviction notice, and handles abort cleanly', async () => {
    const h = harness({
      readOutput: async (input) => ({
        ...sampleInfo({ droppedBytes: 1024, totalBytes: 4096 }),
        output: 'compiled successfully\n',
        offset: input.offset ?? 0,
        nextOffset: 4096,
        truncated: true,
      }),
    });

    const out = (await h.exec('process_output', {
      processId: 'proc-abc123def456',
      offset: 0,
      waitMs: 1000,
    })) as string;
    expect(out).toContain('nextOffset: 4096');
    expect(out).toContain('ring buffer');
    expect(out).toContain('compiled successfully');

    const controller = new AbortController();
    const aborting = harness({
      readOutput: async () => {
        controller.abort();
        throw new Error('aborted');
      },
    });
    const aborted = (await aborting.exec(
      'process_output',
      { processId: 'proc-abc123def456' },
      { abortSignal: controller.signal },
    )) as string;
    expect(aborted).toContain('stopped waiting because the turn was cancelled');
  });
});

describe('process_stop', () => {
  it('stops a process and returns final status and trailing output', async () => {
    const h = harness();
    const result = (await h.exec('process_stop', { processId: 'proc-abc123def456' })) as string;
    expect(result).toContain('Stopped proc-abc123def456');
    expect(result).toContain('reason: stopped');
    expect(result).toContain('shutting down');
  });
});
