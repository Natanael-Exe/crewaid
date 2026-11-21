import { describe, expect, it } from 'vitest';
import { skillTools, type AttachmentPort, type SkillRunPort } from '../src/agent/skill-tools.js';
import type { ToolContext } from '../src/agent/tool-registry.js';

/**
 * M5-BE-06 — `run_skill` and `attach_file`.
 *
 * The cases are about what the MODEL is told, because that is what decides
 * what it does next, and about the two scoping rules §6/M5 states: only
 * APPROVED, and only this bot's skills or the global ones.
 */

const CONTEXT: ToolContext = {
  userId: 'usr_1',
  botId: 'bot_1',
  attachmentHost: () => Promise.resolve('msg_draft'),
  trigger: { id: 'msg_trigger', chainId: null, hopCount: 0 },
  browser: async () => {
    throw new Error('not used');
  },
  session: async () => {
    throw new Error('no session in this test');
  },
};

/**
 * A fake reduced session, faithful to the two calls `attach_file` makes.
 *
 * It answers `stat` as well as the read, because the tool checks the SIZE
 * before it buffers anything — a fake that only implemented `readBinaryFile`
 * let the stat ship untested and then failed in CI with
 * "session.run is not a function", which is the fake being less complete than
 * the thing it stands for rather than the code being wrong.
 */
function fakeSession(
  options: { bytes?: Uint8Array | null; size?: number; statExit?: number } = {},
) {
  return async () =>
    ({
      run: async () => ({
        exitCode: options.statExit ?? 0,
        stdout: String(options.size ?? options.bytes?.length ?? 0),
        stderr: '',
      }),
      readBinaryFile: async () => options.bytes ?? null,
    }) as never;
}

function tools(overrides: {
  skills?: Partial<SkillRunPort>;
  attachments?: Partial<AttachmentPort>;
  context?: Partial<ToolContext>;
}) {
  const skills: SkillRunPort = {
    runForBot: async () => ({ status: 'SUCCEEDED', logs: null, error: null }),
    ...overrides.skills,
  };
  const attachments: AttachmentPort = {
    storeFromBot: async () => ({ id: 'att_1', filename: 'f.txt', sizeBytes: 3 }),
    ...overrides.attachments,
  };
  const built = skillTools({ skills, attachments });
  const context = { ...CONTEXT, ...overrides.context };
  return {
    entries: built,
    async call(name: string, input: unknown): Promise<string> {
      const entry = built.find((t) => t.name === name);
      if (entry === undefined) throw new Error(`no tool ${name}`);
      const execute = (entry.build(context) as { execute?: unknown }).execute as (
        input: unknown,
        options: unknown,
      ) => Promise<string>;
      return execute(input, { toolCallId: 'c1', messages: [], context: undefined });
    },
  };
}

describe('M5-BE-06 the skill tools', () => {
  it('registers exactly the §6/M5 names as built-ins', () => {
    const { entries } = tools({});

    // `send_message` was the third of these while it was a stub. M7-BE-01
    // made it real and moved it to the module that owns its delivery queue,
    // so this list is now two — see `send-message-tool.test.ts`.
    expect(entries.map((t) => t.name)).toEqual(['run_skill', 'attach_file']);
    expect(entries.every((t) => t.behavior.origin.kind === 'builtin')).toBe(true);
  });
});

describe('M5-BE-06 run_skill', () => {
  it('passes the calling bot and principal, never anything from the model', async () => {
    // The model supplies a NAME. Which skills that name can reach is decided
    // by the turn, not by the argument — that is what keeps one bot's private
    // skill out of another's reach.
    const seen: unknown[] = [];
    const { call } = tools({
      skills: {
        runForBot: async (userId, botId, name, params) => {
          seen.push({ userId, botId, name, params });
          return { status: 'SUCCEEDED', logs: 'done', error: null };
        },
      },
    });

    await call('run_skill', { name: 'summarize', params: { q: 1 } });

    expect(seen).toEqual([
      { userId: 'usr_1', botId: 'bot_1', name: 'summarize', params: { q: 1 } },
    ]);
  });

  it('defaults missing params to an empty object rather than undefined', async () => {
    const seen: unknown[] = [];
    const { call } = tools({
      skills: {
        runForBot: async (_u, _b, _n, params) => {
          seen.push(params);
          return { status: 'SUCCEEDED', logs: null, error: null };
        },
      },
    });

    await call('run_skill', { name: 'ping' });

    expect(seen).toEqual([{}]);
  });

  it('tells the model why a draft skill did not run, instead of throwing', async () => {
    // §6/M3: "A DRAFT skill cannot be run. Only APPROVED." The model can pick
    // a different skill when told; it cannot when the turn dies.
    const { call } = tools({
      skills: {
        runForBot: async () => {
          throw new Error('skill "draft_one" is DRAFT — only an APPROVED skill can be run');
        },
      },
    });

    const result = await call('run_skill', { name: 'draft_one' });

    expect(result).toContain('run_skill failed');
    expect(result).toContain('only an APPROVED skill can be run');
  });

  it('reports a failed run with its reason, which is the useful half', async () => {
    const { call } = tools({
      skills: {
        runForBot: async () => ({ status: 'FAILED', logs: 'step 1 ok', error: 'bad param q' }),
      },
    });

    const result = await call('run_skill', { name: 'summarize' });

    expect(result).toContain('bad param q');
    expect(result).toContain('step 1 ok');
  });

  it('truncates a long log rather than persisting it whole', async () => {
    // A tool result goes into the transcript verbatim; a skill that printed a
    // megabyte would put a megabyte in every later step's context.
    const { call } = tools({
      skills: {
        runForBot: async () => ({ status: 'SUCCEEDED', logs: 'x'.repeat(20_000), error: null }),
      },
    });

    const result = await call('run_skill', { name: 'noisy' });

    expect(result.length).toBeLessThan(5_000);
    expect(result).toContain('truncated');
  });
});

describe('M5-BE-06 attach_file', () => {
  it('claims the reply being composed, so the card lands on it', async () => {
    const seen: unknown[] = [];
    const filings: unknown[] = [];
    const { call } = tools({
      attachments: {
        storeFromBot: async (input) => {
          seen.push({ userId: input.userId, messageId: input.messageId, filename: input.filename });
          filings.push(input.filing);
          return { id: 'att_1', filename: input.filename, sizeBytes: input.bytes.length };
        },
      },
      context: {
        session: fakeSession({ bytes: new Uint8Array([1, 2, 3]) }),
      },
    });

    const result = await call('attach_file', { path: '/home/bot/report.pdf', note: 'the numbers' });

    expect(seen).toEqual([{ userId: 'usr_1', messageId: 'msg_draft', filename: 'report.pdf' }]);
    // D-136: filed as a deliverable, from where the turn's work came and
    // where in the workspace the file was.
    expect(filings).toEqual([
      {
        triggerMessageId: 'msg_trigger',
        sourcePath: '/home/bot/report.pdf',
        summary: 'the numbers',
      },
    ]);
    expect(result).toContain('report.pdf');
    expect(result).toContain('the numbers');
  });

  it('names the path when there is no file there', async () => {
    // The session answers null rather than throwing, and a model that
    // mistyped a path needs to know which path.
    const { call } = tools({
      context: {
        // stat exits non-zero for a path that is not there, which is how the
        // tool learns before it reads anything.
        session: fakeSession({ statExit: 1 }),
      },
    });

    const result = await call('attach_file', { path: '/home/bot/missing.txt' });

    expect(result).toBe('attach_file failed: no file at /home/bot/missing.txt');
  });

  it('reports a store refusal as a result', async () => {
    const { call } = tools({
      attachments: {
        storeFromBot: async () => {
          throw new Error('notes.xyz has no attachable type (.xyz)');
        },
      },
      context: {
        session: fakeSession({ bytes: new Uint8Array([1]) }),
      },
    });

    expect(await call('attach_file', { path: '/home/bot/notes.xyz' })).toContain(
      'no attachable type',
    );
  });
});

describe('M5-BE-06 attach_file refuses before it buffers', () => {
  it('rejects an oversized file on the stat, not after reading it', async () => {
    // The 25 MiB cap lives in AttachmentsService.store, which sees a Buffer —
    // so without this check the orchestrator allocates the whole file to
    // produce a refusal. §7.3 makes the sandbox untrusted and D-039 gives it
    // no fixed-size disk, so the size is whatever a skill chose to write.
    let read = false;
    const { call } = tools({
      context: {
        session: async () =>
          ({
            run: async () => ({ exitCode: 0, stdout: String(100 * 1024 * 1024), stderr: '' }),
            readBinaryFile: async () => {
              read = true;
              return new Uint8Array(1);
            },
          }) as never,
      },
    });

    const result = await call('attach_file', { path: '/home/bot/huge.pdf' });

    expect(result).toContain('over the');
    expect(result).toContain('attachment limit');
    // The point of the fix: nothing was buffered to say no.
    expect(read).toBe(false);
  });

  it('quotes a path so it cannot break out of the stat command', async () => {
    // `run()` takes a shell string and the path comes from the MODEL.
    const commands: string[] = [];
    const { call } = tools({
      context: {
        session: async () =>
          ({
            run: async (options: { command: string }) => {
              commands.push(options.command);
              return { exitCode: 1, stdout: '', stderr: '' };
            },
            readBinaryFile: async () => null,
          }) as never,
      },
    });

    await call('attach_file', { path: "/tmp/x'; rm -rf /; echo '" });

    // Every metacharacter stays inside the quotes; the only unquoted region
    // is the escaped quote itself.
    expect(commands[0]).toBe(`stat -c %s '/tmp/x'\\''; rm -rf /; echo '\\'''`);
  });
});
