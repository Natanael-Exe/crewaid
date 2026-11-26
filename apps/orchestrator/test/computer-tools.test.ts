import { describe, expect, it } from 'vitest';
import type { ToolDefinition as Tool } from '../src/agent/tool-contract.js';
import { computerTools } from '../src/agent/computer-tools.js';
import type { ToolContext } from '../src/agent/tool-registry.js';
import { MACHINE_HOME } from '../src/agent/workspace-paths.js';
import type { Seat } from '../src/sandbox/seat.service.js';

/**
 * M5-BE-05 — the four computer built-ins (§6/M5).
 *
 * Asserted by what the MODEL is told, which is the part that decides what it
 * does next. A refused path that reads as a stack trace is a model that
 * retries the same call; one that names the right directory is a model that
 * goes there.
 */

const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';
const OWN = `${MACHINE_HOME}/agents/${BOT}`;

type Ran = {
  command: string;
  workingDirectory?: string | undefined;
  env?: Record<string, string> | undefined;
};

function context(
  overrides: {
    run?: (options: Ran) => { exitCode: number; stdout: string; stderr: string };
    readTextFile?: (options: { path: string }) => string | null;
    writeTextFile?: (options: { path: string; content: string }) => void;
    screenshot?: () => Buffer;
  } = {},
): { context: ToolContext; ran: Ran[]; wrote: Array<{ path: string; content: string }> } {
  const ran: Ran[] = [];
  const wrote: Array<{ path: string; content: string }> = [];
  const session = {
    run: async (options: Ran) => {
      ran.push(options);
      return overrides.run?.(options) ?? { exitCode: 0, stdout: '', stderr: '' };
    },
    // `?? default` would swallow an override that deliberately returns
    // `null` — which is the sandbox's "no such file" and a case under test.
    readTextFile: async (options: { path: string }) =>
      overrides.readTextFile === undefined ? 'file contents' : overrides.readTextFile(options),
    writeTextFile: async (options: { path: string; content: string }) => {
      wrote.push(options);
      overrides.writeTextFile?.(options);
    },
  };
  const page = {
    screenshot: async () => overrides.screenshot?.() ?? Buffer.from('a png, honestly'),
  };
  return {
    ran,
    wrote,
    context: {
      userId: 'user-under-test',
      botId: BOT,
      attachmentHost: () => Promise.resolve('message-under-test'),
      browser: async () => page,
      session: async () => session,
    } as unknown as ToolContext,
  };
}

/**
 * The bot's seat, as `AgentBrowserService.ensureSeatFor` hands one over.
 *
 * `dbusAddress` is set here rather than left absent because the shell is the
 * tool that has to put a command in the seat's OWN session — a fixture without
 * it would let a regression that drops the address pass.
 */
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
  widthPx: 1280,
  heightPx: 800,
};

/** The tools as the module registers them, with a machine that always answers. */
function tools(seat: Seat | null = SEAT): ReturnType<typeof computerTools> {
  return computerTools({
    machines: {
      ensureSeatFor: async () => {
        if (seat === null) throw new Error('bot under-test has no computer');
        return seat;
      },
    },
  });
}

/** One tool's `execute`, as the SDK would call it. */
function run(
  name: string,
  ctx: ToolContext,
  input: unknown,
  options: unknown = {},
): Promise<unknown> {
  const entry = tools().find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no tool named ${name}`);
  const built = entry.build(ctx) as Tool & {
    execute: (input: unknown, options: unknown) => Promise<unknown>;
  };
  return built.execute(input, options);
}

function definition(name: string): Tool & { toModelOutput?: unknown; description?: string } {
  const entry = tools().find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no tool named ${name}`);
  return entry.build(context().context) as Tool;
}

describe("the tools name the bot's real paths, not placeholders", () => {
  it("tells fs_read/fs_write/shell where this bot's own area is", () => {
    // "<your bot id>" was a placeholder the one reader that mattered could
    // not resolve — a model cannot act on a boundary it cannot fill in.
    for (const name of ['fs_read', 'fs_write', 'shell']) {
      const description = definition(name).description ?? '';
      expect(description, name).toContain(OWN);
      expect(description, name).not.toContain('<your bot id>');
    }
  });
});

describe('the four tools are registered the way the registry expects', () => {
  it('offers exactly §6/M5’s four, as built-ins that isolate their failures', () => {
    expect(
      tools()
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(['fs_read', 'fs_write', 'screenshot', 'shell']);
    for (const entry of tools()) {
      expect(entry.behavior.origin, entry.name).toEqual({ kind: 'builtin' });
      expect(entry.behavior.failure, entry.name).toEqual({ kind: 'isolate' });
    }
  });
});

describe('shell', () => {
  it('runs the command and reports the exit code with the output', async () => {
    const { context: ctx, ran } = context({
      run: () => ({ exitCode: 0, stdout: 'a.txt\nb.txt\n', stderr: '' }),
    });

    const result = await run('shell', ctx, { command: 'ls' });

    // M5-BE-30: the command reaches the machine wrapped in a bound that lives
    // THERE. SHELL_TIMEOUT_MS bounded the orchestrator's wait and never the
    // machine, so a command whose orchestrator stopped waiting ran to
    // completion in the operator's container.
    expect(ran[0]?.workingDirectory).toBe(MACHINE_HOME);
    expect(ran[0]?.command).toContain('timeout --kill-after=5s 120s');
    expect(ran[0]?.command).toContain('ls');
    expect(result).toContain('exit 0');
    expect(result).toContain('a.txt');
  });

  it("starts the command in the bot's OWN area, not the machine home", async () => {
    // One machine per user (D-046), so `/home/bot` is where every sibling's
    // files are. A report built straight into the machine home is a report
    // the next bot reads without a clue whose it is — measured in the wild
    // as Exe presenting Nathan's competitive report as its own. The shell
    // opening on the bot's own area is what makes the workspace block's
    // instruction true by default rather than by obedience.
    const { context: ctx, ran } = context({
      run: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    await run('shell', ctx, { command: 'ls' });

    const script = ran[0]?.command ?? '';
    // The path appears single-quoted (shellQuote), and the whole bash script
    // is quoted AGAIN as bash -lc's one argument — so the assertion matches
    // the statement shape, not a particular quoting of the path.
    expect(script).toMatch(new RegExp(`mkdir -p [^ ]*${OWN}`));
    expect(script).toMatch(new RegExp(`cd [^ ]*${OWN}`));
    // The exec itself still opens on the machine home, which always exists —
    // the mkdir + cd inside the script is what survives a fresh volume.
    expect(ran[0]?.workingDirectory).toBe(MACHINE_HOME);
  });

  it('runs the command on the bot’s own SEAT, not the machine’s root display', async () => {
    // The measured defect: `shell` inherited the image's `DISPLAY=:1`, so a bot
    // asked to screenshot its screen photographed the machine's root desktop —
    // the one no client shows — while the operator watched its seat. The
    // command carries the seat's display AND its session bus: a GUI process
    // started against the machine's bus joins a session the desktop it was
    // told to draw on is not part of.
    const { context: ctx, ran } = context();
    await run('shell', ctx, { command: 'scrot ~/agents/x/s.png' });

    expect(ran[0]?.env).toEqual({
      DISPLAY: SEAT.display,
      DBUS_SESSION_BUS_ADDRESS: SEAT.dbusAddress,
    });
  });

  it('still runs a command when no seat can be resolved', async () => {
    // `ls`, `git` and `pnpm` have nothing to do with a display. A machine that
    // cannot hand over a desktop must not take the shell away with it.
    const { context: ctx, ran } = context({
      run: () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    });
    const entry = tools(null).find((candidate) => candidate.name === 'shell');
    if (entry === undefined) throw new Error('no shell tool');
    const built = entry.build(ctx) as Tool & {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };

    const result = await built.execute({ command: 'ls' }, {});

    expect(result).toContain('exit 0');
    expect(ran[0]?.env).toEqual({ DISPLAY: '', DBUS_SESSION_BUS_ADDRESS: '' });
  });

  it('says the command hit the limit rather than reporting exit 124', async () => {
    // `timeout`'s own exit code. "exit 124" on its own reads like the
    // command's, and the model's next move — run something shorter — depends
    // on knowing which it is.
    const { context: ctx } = context({
      run: () => ({ exitCode: 124, stdout: 'partial output', stderr: '' }),
    });

    const result = (await run('shell', ctx, { command: 'sleep 999' })) as string;
    expect(result).toContain('still running after 120s');
    expect(result).not.toContain('exit 124');
    // What it managed to produce is still shown: a command that printed for
    // two minutes and then hit the wall has told the model something.
    expect(result).toContain('partial output');
  });

  it('carries a command containing a quote through the wrapper intact', async () => {
    // The wrapper quotes a model-written string. A command with a single
    // quote in it would otherwise end that quoting and run the rest as the
    // WRAPPER's words.
    const { context: ctx, ran } = context({
      run: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    await run('shell', ctx, { command: `echo 'it'\''s fine'` });
    expect(ran[0]?.command).toContain(`echo`);
    // The whole thing is one quoted argument to `bash -lc`: the wrapper's own
    // closing quote is the last character of the command it sends.
    expect(ran[0]?.command.endsWith(`'`)).toBe(true);
  });

  it('treats a non-zero exit as a result, not a failure', async () => {
    // This is how a shell reports things. A model shown the code and the
    // stderr usually fixes the command; one shown an exception re-runs it.
    const { context: ctx } = context({
      run: () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    });

    const result = await run('shell', ctx, { command: 'git status' });

    expect(result).toContain('exit 128');
    expect(result).toContain('not a git repository');
  });

  it('bounds the command rather than letting it hold the turn open', async () => {
    const { context: ctx, ran } = context();
    await run('shell', ctx, { command: 'sleep 1' });
    expect((ran[0] as { abortSignal?: AbortSignal }).abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('turns a thrown sandbox error into something the model can read', async () => {
    const ctx = {
      ...context().context,
      session: async () => {
        throw new Error('no container is attached');
      },
    } as unknown as ToolContext;

    expect(await run('shell', ctx, { command: 'ls' })).toContain('no container is attached');
  });

  it('refuses an empty command instead of running a shell with nothing in it', async () => {
    const { context: ctx, ran } = context();
    expect(await run('shell', ctx, { command: '   ' })).toContain('a command is required');
    expect(ran).toHaveLength(0);
  });

  it('kills a cancelled command using a pgrep pattern that matches its own tag and excludes itself', async () => {
    // `taggedCommand` prefixes the bash script with `crewaid-shell:<id>`, and
    // `killByTag` sweeps for it via `pgrep -f` using bracket self-exclusion.
    // A mismatch between the two prefixes silently disables cancel cleanup and
    // leaves the command running until the 120s timeout expires.
    const controller = new AbortController();
    const { context: ctx, ran } = context({
      run: () => {
        if (!controller.signal.aborted) controller.abort();
        return { exitCode: 143, stdout: '', stderr: '' };
      },
    });

    await run('shell', ctx, { command: 'sleep 60' }, { abortSignal: controller.signal });
    await Promise.resolve();

    expect(ran.length).toBeGreaterThanOrEqual(2);
    const launched = ran[0]?.command ?? '';
    const cleanup = ran[1]?.command ?? '';
    const tagMatch = launched.match(/crewaid-shell:([0-9a-f-]+)/);
    expect(tagMatch).not.toBeNull();
    const id = tagMatch?.[1] ?? '';

    const patternMatch = cleanup.match(/pgrep -f '([^']+)'/);
    expect(patternMatch).not.toBeNull();
    const pattern = patternMatch?.[1] ?? '';
    expect(pattern).toBe(`[c]rewaid-shell:${id}`);

    const matcher = new RegExp(pattern);
    expect(matcher.test(`crewaid-shell:${id}`)).toBe(true);
    expect(matcher.test(cleanup)).toBe(false);
  });
});

describe('fs_read', () => {
  it('refuses binary file contents before they enter the chat event log', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13]);
    const { context: ctx } = context({ readTextFile: () => png.toString('utf8') });
    const result = await run('fs_read', ctx, { path: 'screenshots/screen.png' });

    expect(result).toContain('fs_read refused');
    expect(result).toContain('binary');
    expect(result).toContain('screenshot');
    expect(result).not.toContain('\u0000');
    expect(result).not.toContain('PNG');
  });

  it('detects binary content even when the null byte is beyond the output limit', async () => {
    const { context: ctx } = context({ readTextFile: () => 'x'.repeat(200_000) + '\u0000' });
    expect(await run('fs_read', ctx, { path: 'renamed.txt' })).toContain('fs_read refused');
  });

  it('reads inside the bot’s own area', async () => {
    const { context: ctx } = context({ readTextFile: () => 'the notes' });
    expect(await run('fs_read', ctx, { path: 'notes.md' })).toBe('the notes');
  });

  it('refuses a path outside the home before it touches the sandbox', async () => {
    let reads = 0;
    const { context: ctx } = context({
      readTextFile: () => {
        reads += 1;
        return 'root:x:0:0';
      },
    });

    const result = await run('fs_read', ctx, { path: '/etc/shadow' });

    expect(result).toContain('refused');
    // The point of checking in the tool: the sandbox is never asked.
    expect(reads).toBe(0);
  });

  it('says a file is missing rather than empty', async () => {
    // `readTextFile` answers `null` for "no such file". A model told the file
    // is empty stops looking; told it is absent, it checks the path.
    const { context: ctx } = context({ readTextFile: () => null });
    expect(await run('fs_read', ctx, { path: 'gone.md' })).toContain('does not exist');
  });

  it('bounds what one read can put in the context window', async () => {
    const { context: ctx } = context({ readTextFile: () => 'x'.repeat(200_000) });
    const result = (await run('fs_read', ctx, { path: 'big.log' })) as string;
    expect(result.length).toBeLessThan(20_000);
    expect(result).toContain('200,000 characters');
  });
});

describe('fs_write', () => {
  it('writes inside the bot’s own area and says where', async () => {
    const { context: ctx, wrote } = context();

    const result = await run('fs_write', ctx, { path: 'notes.md', content: 'hello' });

    expect(wrote[0]).toEqual({ path: `${OWN}/notes.md`, content: 'hello' });
    expect(result).toContain(`${OWN}/notes.md`);
  });

  it('refuses another bot’s area, and names the right one', async () => {
    const { context: ctx, wrote } = context();

    const result = (await run('fs_write', ctx, {
      path: `${MACHINE_HOME}/agents/someone-else/notes.md`,
      content: 'x',
    })) as string;

    expect(result).toContain('refused');
    expect(result).toContain(OWN);
    expect(wrote).toHaveLength(0);
  });

  it('refuses a write that would fill the machine’s shared volume', async () => {
    // A model writing a file this large has usually pasted something back to
    // itself, and the volume belongs to every tenant on the machine.
    const { context: ctx, wrote } = context();

    const result = (await run('fs_write', ctx, {
      path: 'huge.txt',
      content: 'x'.repeat(2 * 1024 * 1024),
    })) as string;

    expect(result).toContain('over the');
    expect(wrote).toHaveLength(0);
  });

  it('says the team area is the team’s, in the description a model reads', () => {
    expect(definition('fs_write').description).toContain('every other bot on this machine can');
  });
});

describe('screenshot', () => {
  it('returns the bot’s own screen as an image part the model can see', async () => {
    const png = Buffer.from('pretend png bytes');
    const { context: ctx } = context({ screenshot: () => png });

    const output = (await run('screenshot', ctx, {})) as { bytes: number; base64: string };

    // The executor keeps the full typed result for our own code — the seam
    // M5-BE-12 needs — and the projection is what the model gets.
    expect(output.bytes).toBe(png.byteLength);
    const projected = await (
      definition('screenshot') as unknown as {
        toModelOutput: (options: { output: unknown }) => {
          type: string;
          value: Array<{ type: string; mediaType?: string; data?: unknown }>;
        };
      }
    ).toModelOutput({ output, input: {}, toolCallId: 'screenshot-call' } as never);

    expect(projected.type).toBe('content');
    expect(projected.value[0]).toMatchObject({ type: 'file', mediaType: 'image/png' });
    // §6/M5: an image PART, not base64 buried in a JSON string no model sees.
    expect(JSON.stringify(projected)).toContain(png.toString('base64'));
  });

  it('tells the model to prefer the cheaper tool', async () => {
    // A screenshot costs far more context than the a11y tree and cannot be
    // acted on by selector, so the description has to steer.
    expect(definition('screenshot').description).toContain('browser_read');
  });
});

it('does not launch a command cancelled while its desktop was waking', async () => {
  const controller = new AbortController();
  const { context: ctx, ran } = context();
  const entry = computerTools({
    machines: {
      ensureSeatFor: async () => {
        controller.abort();
        return SEAT;
      },
    },
  }).find((candidate) => candidate.name === 'shell')!;
  const built = entry.build(ctx) as Tool & {
    execute: (input: unknown, options: unknown) => Promise<unknown>;
  };
  const result = await built.execute(
    { command: 'touch should-not-exist' },
    {
      abortSignal: controller.signal,
    },
  );
  expect(result).toContain('cancelled before the command started');
  expect(ran.some((call) => call.command.includes('touch should-not-exist'))).toBe(false);
});
