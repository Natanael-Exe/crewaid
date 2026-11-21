import { describe, expect, it } from 'vitest';
import type { ToolDefinition as Tool } from '../src/agent/tool-contract.js';

import { BOARD_PATH, boardTools } from '../src/agent/board-tools.js';
import type { ToolContext } from '../src/agent/tool-registry.js';

/**
 * M5-BE-20 — the shared task board (§6/M5's tool registry, board note).
 *
 * Asserted by what the MODEL is told and by what reaches the FILE, because
 * those are the two things that decide what happens next: a refusal the model
 * cannot act on is a bot that stops, and a write that re-emits text it never
 * read is a bot that reverts its sibling.
 *
 * The board is one file on a shared machine, so every case here is really
 * about the same question — what happens when two bots touch it — and the
 * fake below is deliberately a real string rather than a recorded call: an
 * update has to be applied to the board that is THERE, not to the one this
 * bot last saw.
 */
const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';

function context(initial: string | null): {
  context: ToolContext;
  board: () => string | null;
  /** Everything written, so a case can prove a tool wrote nothing at all. */
  writes: number;
} {
  let board = initial;
  let writes = 0;
  const session = {
    readTextFile: async ({ path }: { path: string }) => {
      if (path !== BOARD_PATH) throw new Error(`unexpected read of ${path}`);
      return board;
    },
    writeTextFile: async ({ path, content }: { path: string; content: string }) => {
      if (path !== BOARD_PATH) throw new Error(`unexpected write to ${path}`);
      writes += 1;
      board = content;
    },
  };
  return {
    board: () => board,
    get writes() {
      return writes;
    },
    context: {
      userId: 'user-under-test',
      botId: BOT,
      attachmentHost: () => Promise.resolve('message-under-test'),
      session: async () => session,
    } as unknown as ToolContext,
  };
}

function run(name: string, ctx: ToolContext, input: unknown): Promise<string> {
  const entry = boardTools().find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no tool named ${name}`);
  const built = entry.build(ctx) as Tool & {
    execute: (input: unknown, options: unknown) => Promise<string>;
  };
  return built.execute(input, {});
}

describe('M5-BE-20 the shared task board', () => {
  it('registers three tools on the machine-wide board path', () => {
    expect(boardTools().map((entry) => entry.name)).toEqual([
      'board_read',
      'board_add',
      'board_update',
    ]);
    // The shared area, not the bot's own: a board under `agents/<botId>` is a
    // board only one bot can see, which is the opposite of the point.
    expect(BOARD_PATH).toBe('/home/bot/shared/BOARD.md');
  });

  it('tells the model how to start a board that does not exist yet', async () => {
    const fake = context(null);
    const answer = await run('board_read', fake.context, {});
    // "does not exist" and not "failed": an empty board is the ordinary state
    // of a new machine, and a model told it failed stops instead of starting.
    expect(answer).toContain('does not exist yet');
    expect(answer).toContain('board_add');
    expect(fake.writes).toBe(0);
  });

  it('returns the board verbatim, parsing nothing', async () => {
    // Three shapes on one board, because the tools are supposed to be
    // unopinionated about schema: a heading, a checklist and a table row.
    const board = '# Sprint\n\n- [ ] Draft the copy\n\n| id | owner |\n| 7 | mira |\n';
    const answer = await run('board_read', context(board).context, {});
    expect(answer).toBe(board);
  });

  it('appends without re-emitting what it did not write', async () => {
    const fake = context('- [ ] Draft the copy\n');
    const answer = await run('board_add', fake.context, { entry: '- [ ] Price the plan' });

    expect(answer).toContain('Price the plan');
    expect(fake.board()).toBe('- [ ] Draft the copy\n- [ ] Price the plan\n');
  });

  it('starts the board when there is none, and normalises the join', async () => {
    const fresh = context(null);
    await run('board_add', fresh.context, { entry: '- [ ] First thing' });
    expect(fresh.board()).toBe('- [ ] First thing\n');

    // A board somebody left with no trailing newline, and one left with
    // several: both join to exactly one, so appending twice cannot drift.
    const ragged = context('- [ ] First thing');
    await run('board_add', ragged.context, { entry: '- [ ] Second' });
    expect(ragged.board()).toBe('- [ ] First thing\n- [ ] Second\n');

    const padded = context('- [ ] First thing\n\n\n');
    await run('board_add', padded.context, { entry: '- [ ] Second' });
    expect(padded.board()).toBe('- [ ] First thing\n- [ ] Second\n');
  });

  it('refuses an empty entry rather than writing a blank line', async () => {
    const fake = context('- [ ] Draft the copy\n');
    expect(await run('board_add', fake.context, { entry: '   ' })).toContain('refused');
    expect(fake.writes).toBe(0);
  });

  it('replaces one exact entry and leaves the rest alone', async () => {
    const fake = context('- [ ] Draft the copy\n- [ ] Price the plan\n');
    const answer = await run('board_update', fake.context, {
      find: '- [ ] Draft the copy',
      replace: '- [x] Draft the copy',
    });

    expect(answer).toContain('Updated');
    expect(fake.board()).toBe('- [x] Draft the copy\n- [ ] Price the plan\n');
  });

  it('removes an entry when the replacement is empty', async () => {
    const fake = context('- [ ] Draft the copy\n- [ ] Price the plan\n');
    const answer = await run('board_update', fake.context, {
      find: '- [ ] Draft the copy\n',
      replace: '',
    });

    expect(answer).toContain('Removed');
    expect(fake.board()).toBe('- [ ] Price the plan\n');
  });

  it('refuses an ambiguous match instead of taking the first one', async () => {
    // The failure this tool exists for. Two entries share a word, and
    // "replace the first" is how a bot ticks off somebody else's task.
    const fake = context('- [ ] Review the copy\n- [ ] Review the plan\n');
    const answer = await run('board_update', fake.context, {
      find: '- [ ] Review',
      replace: '- [x] Review',
    });

    expect(answer).toContain('more than once');
    expect(answer).toContain('surrounding');
    expect(fake.writes).toBe(0);
    expect(fake.board()).toBe('- [ ] Review the copy\n- [ ] Review the plan\n');
  });

  it('says a sibling may have moved it when the text is gone', async () => {
    // What a lost update looks like from inside: this bot read the board, a
    // sibling ticked the entry off, and this bot's `find` no longer matches.
    // The refusal is the feature — `fs_write` would have written the whole
    // board back and un-ticked it.
    const fake = context('- [x] Draft the copy\n');
    const answer = await run('board_update', fake.context, {
      find: '- [ ] Draft the copy',
      replace: '- [x] Draft the copy',
    });

    expect(answer).toContain('another bot');
    expect(answer).toContain('board_read');
    expect(fake.writes).toBe(0);
  });

  it('bounds the board rather than letting it grow into the context window', async () => {
    const fake = context(`${'x'.repeat(31_990)}\n`);
    const answer = await run('board_add', fake.context, { entry: '- [ ] One more' });

    expect(answer).toContain('refused');
    expect(answer).toContain('board_update');
    expect(fake.writes).toBe(0);
  });

  it('hands a broken machine back as a result, not an exception', async () => {
    const broken = {
      userId: 'user-under-test',
      botId: BOT,
      attachmentHost: () => Promise.resolve('message-under-test'),
      session: async () => {
        throw new Error('no container is attached to session cmu3');
      },
    } as unknown as ToolContext;

    // Every built-in has this polarity: the model reads the failure and can
    // say so, instead of the turn dying on an exception it never saw.
    expect(await run('board_read', broken, {})).toContain('board_read failed');
    expect(await run('board_add', broken, { entry: '- [ ] x' })).toContain('board_add failed');
    expect(await run('board_update', broken, { find: 'a', replace: 'b' })).toContain(
      'board_update failed',
    );
  });
});
