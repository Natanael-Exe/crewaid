import { describe, expect, it } from 'vitest';
import type { ToolDefinition as Tool } from '../src/agent/tool-contract.js';
import { codingTools } from '../src/agent/coding-tools.js';
import type { ToolContext } from '../src/agent/tool-registry.js';
import { MACHINE_HOME } from '../src/agent/workspace-paths.js';

const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';
const OWN = `${MACHINE_HOME}/agents/${BOT}`;

type Ran = {
  command: string;
  workingDirectory?: string | undefined;
  env?: Record<string, string> | undefined;
};

function context(
  overrides: {
    groupId?: string | null;
    run?: (options: Ran) => { exitCode: number; stdout: string; stderr: string };
    readTextFile?: (options: { path: string }) => string | null;
    writeTextFile?: (options: { path: string; content: string }) => void;
  } = {},
): { context: ToolContext; ran: Ran[]; wrote: Array<{ path: string; content: string }> } {
  const ran: Ran[] = [];
  const wrote: Array<{ path: string; content: string }> = [];
  const session = {
    run: async (options: Ran) => {
      ran.push(options);
      return overrides.run?.(options) ?? { exitCode: 0, stdout: '', stderr: '' };
    },
    readTextFile: async (options: { path: string }) =>
      overrides.readTextFile === undefined ? 'file contents' : overrides.readTextFile(options),
    writeTextFile: async (options: { path: string; content: string }) => {
      wrote.push(options);
      overrides.writeTextFile?.(options);
    },
  };
  return {
    ran,
    wrote,
    context: {
      userId: 'user-under-test',
      botId: BOT,
      groupId: overrides.groupId ?? null,
      attachmentHost: () => Promise.resolve('message-under-test'),
      session: async () => session,
    } as unknown as ToolContext,
  };
}

function run(
  name: string,
  ctx: ToolContext,
  input: unknown,
  options: unknown = {},
): Promise<unknown> {
  const entry = codingTools().find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no tool named ${name}`);
  const built = entry.build(ctx) as Tool & {
    execute: (input: unknown, options: unknown) => Promise<unknown>;
  };
  return built.execute(input, options);
}

describe('coding tools registration', () => {
  it('registers fs_edit as contained and fs_grep/fs_glob as read-only built-ins', () => {
    const byName = new Map(codingTools().map((entry) => [entry.name, entry]));
    expect([...byName.keys()].sort()).toEqual(['fs_edit', 'fs_glob', 'fs_grep']);
    expect(byName.get('fs_edit')?.behavior.effect).toBe('draft');
    expect(byName.get('fs_grep')?.behavior.effect).toBe('read');
    expect(byName.get('fs_glob')?.behavior.effect).toBe('read');
  });
});

describe('fs_edit', () => {
  it('applies a unique surgical edit and returns line context', async () => {
    const { context: ctx, wrote } = context({
      readTextFile: () => 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
    });

    const result = (await run('fs_edit', ctx, {
      path: 'app.ts',
      oldText: 'const b = 2;',
      newText: 'const b = 20;\nconst b2 = 21;',
    })) as string;

    expect(wrote).toEqual([
      {
        path: `${OWN}/app.ts`,
        content: 'const a = 1;\nconst b = 20;\nconst b2 = 21;\nconst c = 3;\n',
      },
    ]);
    expect(result).toContain(`edited ${OWN}/app.ts`);
    expect(result).toContain('2\tconst b = 20;');
    expect(result).toContain('3\tconst b2 = 21;');
  });

  it('matches across CRLF files and preserves CRLF endings on write', async () => {
    const { context: ctx, wrote } = context({
      readTextFile: () => 'line1\r\nline2\r\nline3\r\n',
    });

    const result = (await run('fs_edit', ctx, {
      path: 'win.txt',
      oldText: 'line1\nline2',
      newText: 'LINE1\nLINE2',
    })) as string;

    expect(result).toContain('edited');
    expect(wrote[0]?.content).toBe('LINE1\r\nLINE2\r\nline3\r\n');
  });

  it('hints when oldText looks like copied line-number prefixes from fs_read', async () => {
    const { context: ctx, wrote } = context({
      readTextFile: () => 'alpha\nbeta\ngamma\n',
    });

    const result = (await run('fs_edit', ctx, {
      path: 'sample.txt',
      oldText: '2\tbeta',
      newText: 'BETA',
    })) as string;

    expect(result).toContain('fs_edit failed');
    expect(result).toContain('line-number prefixes');
    expect(wrote).toHaveLength(0);
  });

  it('refuses ambiguous multi-match edits unless replaceAll is true', async () => {
    const { context: ctx, wrote } = context({
      readTextFile: () => 'foo\nbar\nfoo\nbaz\nfoo\n',
    });

    const refused = (await run('fs_edit', ctx, {
      path: 'dup.txt',
      oldText: 'foo',
      newText: 'qux',
    })) as string;
    expect(refused).toContain('matched 3 locations');
    expect(refused).toContain('lines 1, 3, 5');
    expect(wrote).toHaveLength(0);

    const applied = (await run('fs_edit', ctx, {
      path: 'dup.txt',
      oldText: 'foo',
      newText: 'qux',
      replaceAll: true,
    })) as string;
    expect(applied).toContain('3 replacements');
    expect(wrote[0]?.content).toBe('qux\nbar\nqux\nbaz\nqux\n');
  });

  it('writes $ sequences in newText literally when replacing every occurrence', async () => {
    const { context: ctx, wrote } = context({
      readTextFile: () => 'echo PID\nlog PID\n',
    });

    await run('fs_edit', ctx, {
      path: 'run.sh',
      oldText: 'PID',
      newText: "$$ $& $'",
      replaceAll: true,
    });

    expect(wrote[0]?.content).toBe("echo $$ $& $'\nlog $$ $& $'\n");
  });

  it('leaves a mostly-LF file with one stray CRLF in its own line endings', async () => {
    const { context: ctx, wrote } = context({
      readTextFile: () => 'one\r\ntwo\nthree\n',
    });

    await run('fs_edit', ctx, { path: 'mixed.txt', oldText: 'three', newText: 'THREE' });

    expect(wrote[0]?.content).toBe('one\r\ntwo\nTHREE\n');
  });

  it('refuses missing, binary, outside-workspace, and oversized files', async () => {
    const missing = context({ readTextFile: () => null });
    expect(
      await run('fs_edit', missing.context, { path: 'nope.ts', oldText: 'a', newText: 'b' }),
    ).toContain('does not exist');

    const binary = context({ readTextFile: () => 'abc\u0000def' });
    expect(
      await run('fs_edit', binary.context, { path: 'bin.dat', oldText: 'abc', newText: 'xyz' }),
    ).toContain('fs_edit refused');

    const outside = context();
    expect(
      await run('fs_edit', outside.context, { path: '/etc/hosts', oldText: 'a', newText: 'b' }),
    ).toContain('fs_edit refused');

    const huge = context({ readTextFile: () => 'x' });
    expect(
      await run('fs_edit', huge.context, {
        path: 'big.txt',
        oldText: 'x',
        newText: 'y'.repeat(1024 * 1024 + 10),
      }),
    ).toContain('exceeds');
  });
});

describe('fs_grep', () => {
  it('passes pattern and glob via env, enables --hidden and column/filesize caps, and caps total matches', async () => {
    const lines = [
      `${OWN}/a.ts:1:const x = "hit";`,
      `${MACHINE_HOME}/agents/other-bot/secret.ts:1:const x = "hit";`,
      `${MACHINE_HOME}/.chrome/Default/Cookies:1:hit`,
      `${OWN}/b.ts:4:const y = "hit";`,
      `${OWN}/c.ts:9:const z = "hit";`,
    ].join('\n');
    const { context: ctx, ran } = context({
      run: () => ({ exitCode: 0, stdout: lines, stderr: '' }),
    });

    const result = (await run('fs_grep', ctx, {
      pattern: 'hit"; rm -rf /',
      glob: '*.ts',
      maxMatches: 2,
    })) as string;

    const call = ran[0];
    expect(call?.command).not.toContain('rm -rf');
    expect(call?.command).toContain('--hidden');
    expect(call?.command).toContain('--max-columns=300');
    expect(call?.command).toContain('--max-filesize=2M');
    expect(call?.env?.['CREWAID_PATTERN']).toBe('hit"; rm -rf /');
    expect(call?.env?.['CREWAID_GLOB']).toBe('*.ts');

    // Sibling bot and .chrome hits are dropped by post-filter; total cap keeps a.ts + b.ts and cuts c.ts.
    expect(result).toContain(`${OWN}/a.ts:1:`);
    expect(result).toContain(`${OWN}/b.ts:4:`);
    expect(result).not.toContain('other-bot');
    expect(result).not.toContain('.chrome');
    expect(result).not.toContain(`${OWN}/c.ts:9:`);
    expect(result).toContain('truncated at 2 matches');
  });

  it('caps the lines leaving the container and reports a search error from stderr', async () => {
    const { context: ctx, ran } = context({
      run: () => ({ exitCode: 0, stdout: '', stderr: 'regex parse error: unclosed group' }),
    });

    const result = await run('fs_grep', ctx, { pattern: '(oops', maxMatches: 10 });

    expect(ran[0]?.command).toContain('| head -n "$CREWAID_MAX_LINES"');
    expect(ran[0]?.env?.['CREWAID_MAX_LINES']).toBe('21');
    // One past the limit per file, so one file with many hits still reads as truncated.
    expect(ran[0]?.env?.['CREWAID_MAX_PER_FILE']).toBe('11');
    expect(result).toBe('fs_grep failed: regex parse error: unclosed group');
  });

  it('pre-excludes machine dirs and sibling agents when searching /home/bot', async () => {
    const { context: ctx, ran } = context({
      run: () => ({ exitCode: 1, stdout: '', stderr: '' }),
    });

    const result = await run('fs_grep', ctx, { pattern: 'needle', path: MACHINE_HOME });
    expect(result).toBe('fs_grep: no matches found.');
    expect(ran[0]?.command).toContain("'.chrome'");
    expect(ran[0]?.command).toContain("'agents'");
    expect(ran[0]?.env?.['CREWAID_OWN_DIR']).toBe(OWN);
  });

  it('refuses paths outside the workspace before running anything', async () => {
    const { context: ctx, ran } = context();
    expect(await run('fs_grep', ctx, { pattern: 'root', path: '/etc' })).toContain(
      'fs_grep refused',
    );
    expect(ran).toHaveLength(0);
  });
});

describe('fs_glob', () => {
  it('passes pattern via env, enables --hidden and --full-path for slash globs, and filters disallowed paths', async () => {
    const stdout = [
      `${OWN}/.github/workflows/ci.yml`,
      `${MACHINE_HOME}/agents/other-bot/leak.yml`,
      `${OWN}/src/a.yml`,
      `${OWN}/src/b.yml`,
    ].join('\n');
    const { context: ctx, ran } = context({
      run: () => ({ exitCode: 0, stdout, stderr: '' }),
    });

    const result = (await run('fs_glob', ctx, {
      pattern: '.github/**/*.yml',
      maxResults: 2,
    })) as string;

    expect(ran[0]?.command).toContain('--hidden');
    expect(ran[0]?.command).toContain('--full-path');
    expect(ran[0]?.env?.['CREWAID_PATTERN']).toBe('**/.github/**/*.yml');
    expect(result).toContain(`${OWN}/.github/workflows/ci.yml`);
    expect(result).not.toContain('other-bot');
    expect(result).toContain('showing 2 of 3 files');
  });

  it('reports the full match count the container counted past its cap', async () => {
    const stdout = [`${OWN}/a.md`, `${OWN}/b.md`, `${OWN}/c.md`, '#TOTAL 57'].join('\n');
    const { context: ctx, ran } = context({
      run: () => ({ exitCode: 0, stdout, stderr: '' }),
    });

    const result = (await run('fs_glob', ctx, { pattern: '*.md', maxResults: 1 })) as string;

    expect(ran[0]?.env?.['CREWAID_MAX_LINES']).toBe('3');
    expect(ran[0]?.command).toContain('LC_ALL=C sort');
    expect(result).toBe(`${OWN}/a.md\n[showing 1 of 57 files — narrow path or pattern to see more]`);
  });

  it('returns empty without executing when searching /home/bot/groups outside any group', async () => {
    const { context: ctx, ran } = context({ groupId: null });
    expect(await run('fs_glob', ctx, { pattern: '*.md', path: `${MACHINE_HOME}/groups` })).toBe(
      'fs_glob: no matching files found.',
    );
    expect(ran).toHaveLength(0);
  });
});
