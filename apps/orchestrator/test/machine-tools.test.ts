import { describe, expect, it } from 'vitest';
import type { ToolDefinition as Tool } from '../src/agent/tool-contract.js';
import { machineTools } from '../src/agent/machine-tools.js';
import type { ToolContext } from '../src/agent/tool-registry.js';
import { MACHINE_HOME } from '../src/agent/workspace-paths.js';
import type { Seat } from '../src/sandbox/seat.service.js';

/**
 * The machine-level built-ins — the bot's eyes, hands and camera.
 *
 * Asserted like the computer tools: by the command that reaches the machine
 * and the sentence the model reads back, because those two decide what the
 * model does next. The seat's display is the load-bearing fact in every one —
 * a pointer click or a capture aimed at the ROOT display (the shell's own
 * `DISPLAY`) records the wrong desktop entirely, which is the measured
 * failure that made these tools exist.
 */

const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';
const DISPLAY = ':7';
const SEAT: Seat = {
  seatId: 'seat-1',
  browserGeneration: 1,
  profile: 'private-fixture',
  botId: BOT,
  display: DISPLAY,
  rfbPort: 5901,
  cdpPort: 9301,
  browserReady: false,
  widthPx: 1280,
  heightPx: 800,
};

type Ran = {
  command: string;
  workingDirectory?: string | undefined;
  env?: Record<string, string> | undefined;
};

function context(
  overrides: {
    run?: (options: Ran) => { exitCode: number; stdout: string; stderr: string };
    readBinaryFile?: (options: { path: string }) => Uint8Array | null;
  } = {},
): { context: ToolContext; ran: Ran[]; attached: Array<{ filename: string; bytes: number }> } {
  const ran: Ran[] = [];
  const attached: Array<{ filename: string; bytes: number }> = [];
  const session = {
    run: async (options: Ran) => {
      ran.push(options);
      return overrides.run?.(options) ?? { exitCode: 0, stdout: '', stderr: '' };
    },
    readBinaryFile: async (options: { path: string }) =>
      overrides.readBinaryFile === undefined
        ? new Uint8Array([1, 2, 3])
        : overrides.readBinaryFile(options),
  };
  return {
    ran,
    attached,
    context: {
      userId: 'user-under-test',
      botId: BOT,
      attachmentHost: () => Promise.resolve('message-under-test'),
      trigger: { id: 'trigger-under-test', chainId: null, hopCount: 0 },
      browser: async () => {
        throw new Error('machine tools must not open CDP');
      },
      session: async () => session,
    } as unknown as ToolContext,
  };
}

function tools(
  overrides: {
    run?: (options: Ran) => { exitCode: number; stdout: string; stderr: string };
    readBinaryFile?: (options: { path: string }) => Uint8Array | null;
  } = {},
): ReturnType<typeof context> {
  return context(overrides);
}

/** One tool's `execute`, as the SDK would call it. */
async function run(
  name: string,
  ctx: ToolContext,
  input: unknown = {},
  seat: Seat = SEAT,
): Promise<unknown> {
  const entry = machineTools({
    machines: { ensureSeatFor: async () => seat },
    attachments: {
      storeFromBot: async () => {
        throw new Error('not expected in this test');
      },
    },
  }).find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no tool named ${name}`);
  const built = entry.build(ctx) as Tool & {
    execute: (input: unknown, options: unknown) => Promise<unknown>;
  };
  return built.execute(input, {});
}

function runWithAttachments(
  store: (input: {
    filename: string;
    bytes: Buffer;
  }) => Promise<{ id: string; filename: string; sizeBytes: number }>,
) {
  return async (name: string, ctx: ToolContext, input: unknown = {}): Promise<unknown> => {
    const entry = machineTools({
      machines: { ensureSeatFor: async () => SEAT },
      attachments: { storeFromBot: store },
    }).find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`no tool named ${name}`);
    const built = entry.build(ctx) as Tool & {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    return built.execute(input, {});
  };
}

describe('capture_screen', () => {
  it('captures the SEAT display, not the shell’s DISPLAY', async () => {
    const { context: ctx, ran } = tools();
    await run('capture_screen', ctx);

    expect(ran[0]?.command).toContain('scrot ');
    expect(ran[0]?.env).toEqual({ DISPLAY: DISPLAY, DBUS_SESSION_BUS_ADDRESS: '' });
  });

  it('answers with the image and the coordinate space it was taken in', async () => {
    const { context: ctx } = tools();
    const output = (await run('capture_screen', ctx)) as { base64: string; widthPx: number };

    const definition = machineTools({
      machines: { ensureSeatFor: async () => SEAT },
      attachments: {
        storeFromBot: async () => {
          throw new Error('not expected');
        },
      },
    })[0];
    const built = definition?.build(ctx) as Tool & {
      toModelOutput?: (a: { output: unknown }) => unknown;
    };
    const modelOutput = (await built.toModelOutput?.({
      output,
      input: {},
      toolCallId: 'capture-call',
    })) as {
      type: string;
      value: Array<{ type: string; mediaType?: string; text?: string }>;
    };
    expect(modelOutput.type).toBe('content');
    expect(modelOutput.value[0]?.mediaType).toBe('image/png');
    expect(modelOutput.value[1]?.text).toContain('1280x800');
  });

  it('keeps the capture as a file in the bot’s own area', async () => {
    // A capture used to live in /tmp for the length of one call and then be
    // deleted, so the model could SEE it and nothing else — no path to hand to
    // attach_file, nothing to give a teammate. A bot in a live session said as
    // much ("the screenshot I take only exists inside my reply as an image"),
    // then went behind this tool's back with `shell` + `scrot`. Recordings have
    // always been files under `agents/<botId>/recordings`; a capture is the
    // same kind of evidence.
    const { context: ctx, ran } = tools();
    await run('capture_screen', ctx);

    expect(ran[0]?.command).toContain(`${MACHINE_HOME}/agents/${BOT}/screenshots/`);
    expect(ran[0]?.command).toContain('mkdir -p');
    expect(ran.some((call) => call.command.includes('rm -f'))).toBe(false);
  });

  it('tells the model where the file is, beside the image', async () => {
    const { context: ctx } = tools();
    const output = (await run('capture_screen', ctx)) as { path: string };

    const definition = machineTools({
      machines: { ensureSeatFor: async () => SEAT },
      attachments: {
        storeFromBot: async () => {
          throw new Error('not expected');
        },
      },
    })[0];
    const built = definition?.build(ctx) as Tool & {
      toModelOutput?: (a: { output: unknown }) => unknown;
    };
    const modelOutput = (await built.toModelOutput?.({
      output,
      input: {},
      toolCallId: 'capture-call',
    })) as {
      type: string;
      value: Array<{ type: string; mediaType?: string; text?: string }>;
    };

    expect(modelOutput.value[1]?.text).toContain(output.path);
  });

  it('carries the seat’s own session bus when the machine reports one', async () => {
    // A seat runs its own D-Bus; the machine's is a different session, and a
    // process that joins the wrong one is the failure `plank` already
    // documents. Absent the field the command keeps the image's environment —
    // which is what every other case in this file asserts.
    const { context: ctx, ran } = tools();
    await run(
      'capture_screen',
      ctx,
      {},
      {
        ...SEAT,
        dbusAddress: 'unix:path=/tmp/runtime-bot/seat7.bus',
      },
    );

    expect(ran[0]?.env).toEqual({
      DISPLAY,
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/runtime-bot/seat7.bus',
    });
  });

  it('tells the model when the machine has no screenshot utility', async () => {
    const { context: ctx } = tools({ run: () => ({ exitCode: 127, stdout: '', stderr: '' }) });
    const result = await run('capture_screen', ctx);
    expect(result).toContain('no screenshot utility');
  });

  it('reports a failing capture with its exit code and stderr', async () => {
    const { context: ctx } = tools({
      run: () => ({ exitCode: 1, stdout: '', stderr: 'Cannot open display' }),
    });
    const result = await run('capture_screen', ctx);
    expect(result).toContain('exit 1');
    expect(result).toContain('Cannot open display');
  });
});

describe('mouse and keyboard', () => {
  it('moves and clicks through xdotool on the seat display', async () => {
    const { context: ctx, ran } = tools();
    await run('mouse_click', ctx, { x: 640, y: 400 });

    expect(ran[0]?.command).toBe(`xdotool mousemove --sync 640 400 click 1`);
    expect(ran[0]?.env).toEqual({ DISPLAY: DISPLAY, DBUS_SESSION_BUS_ADDRESS: '' });
  });

  it('double-clicks by repeating the left button', async () => {
    const { context: ctx, ran } = tools();
    await run('mouse_click', ctx, { x: 10, y: 20, button: 'double' });
    expect(ran[0]?.command).toContain('click --repeat 2 1');
  });

  it('right-clicks button 3', async () => {
    const { context: ctx, ran } = tools();
    await run('mouse_click', ctx, { x: 10, y: 20, button: 'right' });
    expect(ran[0]?.command).toContain('click 3');
  });

  it('refuses coordinates outside the screen instead of clicking the void', async () => {
    const { context: ctx, ran } = tools();
    const result = await run('mouse_click', ctx, { x: 1500, y: 400 });
    expect(result).toContain('refused');
    expect(result).toContain('1280px wide');
    expect(ran).toHaveLength(0);
  });

  it('scrolls with wheel clicks at the parked pointer', async () => {
    const { context: ctx, ran } = tools();
    await run('mouse_scroll', ctx, { direction: 'down', amount: 5 });
    expect(ran[0]?.command).toBe('xdotool click --repeat 5 5');
  });

  it('types text quoted and presses keys in order', async () => {
    const { context: ctx, ran } = tools();
    await run('keyboard', ctx, { text: "it's here", keys: ['ctrl+l', 'Return'] });

    expect(ran[0]?.command).toContain(`xdotool type --delay 25 -- 'it'\\''s here'`);
    expect(ran[0]?.command).toContain(`xdotool key -- 'ctrl+l' 'Return'`);
  });

  it('refuses a keyboard call with nothing to send', async () => {
    const { context: ctx } = tools();
    const result = await run('keyboard', ctx, {});
    expect(result).toContain('refused');
  });
});

describe('screen recording', () => {
  it('starts ffmpeg detached on the seat display, bounded in time', async () => {
    const { context: ctx, ran } = tools({
      run: (options) =>
        options.command.includes('cat ')
          ? { exitCode: 0, stdout: 'idle', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
    });
    const result = await run('record_screen_start', ctx);

    expect(ran[0]?.command).toContain('echo idle');
    const start = ran[1];
    expect(start?.command).toContain('ffmpeg');
    expect(start?.command).toContain(`-i '${DISPLAY}'`);
    expect(start?.command).toContain('-video_size 1280x800');
    expect(start?.command).toContain('-t 600');
    expect(start?.command).toContain('& echo $! >');
    expect(start?.env).toEqual({ DISPLAY: DISPLAY, DBUS_SESSION_BUS_ADDRESS: '' });
    expect(result).toContain('Recording started');
  });

  it('refuses a second recording while one is live', async () => {
    const { context: ctx, ran } = tools({
      run: (options) =>
        options.command.includes('kill -0')
          ? { exitCode: 0, stdout: 'running', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
    });
    const result = await run('record_screen_start', ctx);
    expect(result).toContain('already running');
    expect(ran).toHaveLength(1);
  });

  it('stops with SIGINT — a killed ffmpeg writes an unplayable file', async () => {
    const { context: ctx, ran } = tools({
      run: (options) =>
        options.command.includes('kill -INT')
          ? { exitCode: 0, stdout: 'STOPPED', stderr: '' }
          : options.command.includes('ls -t')
            ? { exitCode: 0, stdout: `/home/bot/agents/${BOT}/recordings/screen-1.mp4`, stderr: '' }
            : options.command.includes('stat')
              ? { exitCode: 0, stdout: '123', stderr: '' }
              : { exitCode: 0, stdout: '', stderr: '' },
    });
    const execute = runWithAttachments(async (input) => ({
      id: 'att-1',
      filename: input.filename,
      sizeBytes: input.bytes.length,
    }));
    const result = (await execute('record_screen_stop', ctx)) as string;

    expect(ran[0]?.command).toContain('kill -INT "$pid"');
    expect(ran[0]?.command).not.toContain('kill -9');
    expect(result).toContain('attached to your reply');
  });

  it('attaches the recording to the reply the turn is composing', async () => {
    const attached: Array<{ filename: string; messageId: string }> = [];
    const { context: ctx } = tools({
      run: (options) =>
        options.command.includes('kill -INT')
          ? { exitCode: 0, stdout: 'STOPPED', stderr: '' }
          : options.command.includes('ls -t')
            ? { exitCode: 0, stdout: `/home/bot/agents/${BOT}/recordings/screen-1.mp4`, stderr: '' }
            : options.command.includes('stat')
              ? { exitCode: 0, stdout: '123', stderr: '' }
              : { exitCode: 0, stdout: '', stderr: '' },
    });
    const execute = runWithAttachments(async (input) => {
      attached.push({ filename: input.filename, messageId: 'message-under-test' });
      return { id: 'att-1', filename: input.filename, sizeBytes: input.bytes.length };
    });
    const result = (await execute('record_screen_stop', ctx)) as string;

    expect(attached).toEqual([{ filename: 'screen-1.mp4', messageId: 'message-under-test' }]);
    expect(result).toContain('screen-1.mp4');
  });

  it('leaves the file with the model when it is over the attachment cap', async () => {
    const { context: ctx } = tools({
      run: (options) =>
        options.command.includes('kill -INT')
          ? { exitCode: 0, stdout: 'STOPPED', stderr: '' }
          : options.command.includes('ls -t')
            ? { exitCode: 0, stdout: `/home/bot/agents/${BOT}/recordings/screen-1.mp4`, stderr: '' }
            : options.command.includes('stat')
              ? { exitCode: 0, stdout: String(64 * 1024 * 1024), stderr: '' }
              : { exitCode: 0, stdout: '', stderr: '' },
    });
    const execute = runWithAttachments(async () => {
      throw new Error('store must not be called for an over-cap file');
    });
    const result = (await execute('record_screen_stop', ctx)) as string;

    expect(result).toContain('NOT attached');
    expect(result).toContain('Compress');
  });

  it('says so when nothing was recording', async () => {
    const { context: ctx } = tools({
      run: (options) =>
        options.command.includes('ls -t')
          ? { exitCode: 0, stdout: '', stderr: '' }
          : { exitCode: 0, stdout: 'STOPPED', stderr: '' },
    });
    const result = await run('record_screen_stop', ctx);
    expect(result).toContain('no recording was found');
  });
});
