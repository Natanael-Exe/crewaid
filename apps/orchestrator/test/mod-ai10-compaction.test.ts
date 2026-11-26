/** D-195: what one call is sent of a long TanStack thread, and what is never touched. */
import { describe, expect, it } from 'vitest';
import type { ChatMiddlewareConfig, ModelMessage } from '@tanstack/ai';
import { estimateTokens, providerCompaction } from '../src/agent/execution/context-compaction.js';
import { ContextBudgetError, historyBudget } from '../src/models/context-budget.js';
import { normalizeModelError } from '../src/models/normalize-error.js';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${String(i)}`).join(' ');

/** A long mixed history: talk, tool calls with bulky output, an image, and a call still waiting. */
function history(exchanges: number): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (let i = 0; i < exchanges; i += 1) {
    messages.push({ role: 'user', content: `question ${String(i)} ${words(40)}` });
    messages.push({
      role: 'assistant',
      content: null,
      toolCalls: [
        { id: `c${String(i)}`, type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ],
    });
    messages.push({ role: 'tool', toolCallId: `c${String(i)}`, content: words(400) });
    messages.push({ role: 'assistant', content: `answer ${String(i)}` });
  }
  messages.push({
    role: 'user',
    content: [
      { type: 'text', content: 'look at this' },
      {
        type: 'image',
        source: { type: 'data', mimeType: 'image/png', value: 'A'.repeat(400_000) },
      },
    ],
  });
  messages.push({
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'pending', type: 'function', function: { name: 'send', arguments: '{}' } }],
  });
  return messages;
}

async function compact(messages: ModelMessage[], maxTokens: number) {
  const middleware = providerCompaction({ maxTokens });
  const config: ChatMiddlewareConfig = { messages, systemPrompts: [], tools: [] };
  const ctx = {
    phase: 'beforeModel',
    threadId: 't',
    emitCustomEvent: () => undefined,
    capability: () => undefined,
  };
  const out = (await middleware.onConfig?.(ctx as never, config)) as
    Partial<ChatMiddlewareConfig> | undefined;
  return out?.providerMessages ?? messages;
}

/** Every tool result follows its call, and every call before the last message has its result. */
function pairsIntact(messages: ModelMessage[]): boolean {
  const open = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool') {
      if (message.toolCallId === undefined || !open.has(message.toolCallId)) return false;
      open.delete(message.toolCallId);
    }
    for (const call of message.toolCalls ?? []) open.add(call.id);
    if (message.role === 'user' && open.size > 0 && index > 0) return false;
  }
  return true;
}

const total = (messages: ModelMessage[]) =>
  messages.reduce((sum, message) => sum + estimateTokens(message), 0);

describe('the history budget', () => {
  it('is half the window, never above the operator’s trim number', () => {
    expect(historyBudget(200_000, 100_000)).toBe(100_000);
    expect(historyBudget(32_000, 100_000)).toBe(16_000);
  });

  it('fails clearly for a model with no usable window', () => {
    for (const window of [0, -1, Number.NaN, 1.5])
      expect(() => historyBudget(window, 100_000)).toThrow(ContextBudgetError);
    const normalized = normalizeModelError(new ContextBudgetError(0));
    expect(normalized.code).toBe('INVALID_REQUEST');
    expect(normalized.detail).toContain('context window');
  });

  it('prices an image as an image, not as its bytes', () => {
    const image = history(0)[0]!;
    expect(estimateTokens(image)).toBeLessThan(2_000);
  });
});

describe('provider compaction', () => {
  it('leaves a history within budget alone', async () => {
    const short = history(1);
    expect(await compact(short, 100_000)).toBe(short);
  });

  it('brings a long history under budget without splitting a call from its result', async () => {
    const long = history(60);
    const canonical = JSON.stringify(long);
    const before = total(long);
    const sent = await compact(long, 8_000);

    expect(before).toBeGreaterThan(8_000 * 4);
    expect(total(sent)).toBeLessThanOrEqual(8_000);
    expect(pairsIntact(sent)).toBe(true);
    // The newest — the image and the call still waiting — are kept as they were.
    expect(sent.slice(-2)).toEqual(long.slice(-2));
    // The canonical history is not touched.
    expect(JSON.stringify(long)).toBe(canonical);
  });

  it('clears old tool output before it drops a single message', async () => {
    const long = history(12);
    const sent = await compact(long, total(long) - 1_000);
    expect(sent).toHaveLength(long.length);
    expect(
      sent.filter(
        (message) => message.role === 'tool' && String(message.content).includes('cleared'),
      ),
    ).not.toHaveLength(0);
    expect(pairsIntact(sent)).toBe(true);
  });

  it('is stable when applied again, as every later step does', async () => {
    const long = history(60);
    const once = await compact(long, 8_000);
    const twice = await compact(once, 8_000);
    expect(total(twice)).toBeLessThanOrEqual(8_000);
    expect(pairsIntact(twice)).toBe(true);
    expect(twice.slice(-2)).toEqual(long.slice(-2));
  });
});

/** Build one assistant tool-call + tool-result exchange for realistic coding transcripts. */
function toolExchange(
  id: string,
  name: string,
  args: Record<string, unknown>,
  result: string,
  assistantNote?: string,
): ModelMessage[] {
  const out: ModelMessage[] = [
    {
      role: 'assistant',
      content: null,
      toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
    { role: 'tool', toolCallId: id, content: result },
  ];
  if (assistantNote !== undefined) {
    out.push({ role: 'assistant', content: assistantNote });
  }
  return out;
}

/** Synthesize numbered file lines in the exact format emitted by `fs_read`. */
function numberedLines(start: number, count: number, width = 90): string {
  const pad = 'x'.repeat(width);
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(`${String(start + i)}\tconst line${String(start + i)} = "${pad}";`);
  }
  return lines.join('\n');
}

function findToolResult(messages: ReadonlyArray<ModelMessage>, toolCallId: string): string {
  const found = messages.find(
    (message) => message.role === 'tool' && message.toolCallId === toolCallId,
  );
  if (found === undefined) throw new Error(`missing tool result for ${toolCallId}`);
  return String(found.content);
}

describe('coding-aware compaction', () => {
  it('leaves a realistic coding transcript below the 100k budget completely untouched', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Refactor the auth middleware and add regression tests.' },
      ...toolExchange('r1', 'fs_read', { path: 'src/auth.ts' }, numberedLines(1, 140)),
      ...toolExchange(
        'e1',
        'fs_edit',
        { path: 'src/auth.ts', oldText: 'old', newText: 'new' },
        'edited /home/bot/agents/b1/src/auth.ts (1 replacement, lines 12–14, +3/-2)\n12\tconst ok = true;',
      ),
      ...toolExchange('r2', 'fs_read', { path: 'src/auth.ts' }, numberedLines(1, 140)),
    ];

    expect(total(messages)).toBeLessThan(100_000);
    expect(await compact(messages, 100_000)).toBe(messages);
  });

  it('Pass 1 clears superseded fs_read calls first and leaves distinct files verbatim once under budget', async () => {
    const bigFileA = numberedLines(1, 150, 100);
    const bigFileB = numberedLines(1, 150, 100);
    const slice1 = `${numberedLines(1, 80, 100)}\n[lines 1–80 of 200 — pass startLine/endLine to read more]`;
    const slice2 = `${numberedLines(81, 80, 100)}\n[lines 81–160 of 200]`;

    const messages: ModelMessage[] = [
      { role: 'user', content: 'Update router.ts and verify config.ts.' },
      // Superseded by later edit + re-read of src/router.ts
      ...toolExchange('read-router-old', 'fs_read', { path: 'src/router.ts' }, bigFileA),
      // Distinct file that is never re-read or edited — must stay verbatim if Pass 1 suffices
      ...toolExchange('read-config', 'fs_read', { path: 'src/config.ts' }, bigFileB),
      // Disjoint slices of src/parser.ts — slice1 is NOT superseded by slice2
      ...toolExchange(
        'read-parser-1',
        'fs_read',
        { path: 'src/parser.ts', startLine: 1, endLine: 80 },
        slice1,
      ),
      ...toolExchange(
        'read-parser-2',
        'fs_read',
        { path: 'src/parser.ts', startLine: 81, endLine: 160 },
        slice2,
      ),
      // Failed edit does NOT mark read-config stale, whereas successful edit marks router stale
      ...toolExchange(
        'edit-config-fail',
        'fs_edit',
        { path: 'src/config.ts', oldText: 'missing', newText: 'x' },
        'fs_edit failed: oldText was not found in /home/bot/agents/b1/src/config.ts.',
      ),
      ...toolExchange(
        'edit-router',
        'fs_edit',
        { path: 'src/router.ts', oldText: 'a', newText: 'b' },
        'edited /home/bot/agents/b1/src/router.ts (1 replacement, lines 10–12, +3/-2)\n10\treturn next();',
      ),
      ...toolExchange('read-router-new', 'fs_read', { path: 'src/router.ts' }, bigFileA),
      { role: 'assistant', content: 'Ready to run tests.' },
    ];

    const before = total(messages);
    // Budget requires shedding ~2,000 tokens — clearing read-router-old (~4,600 tokens) is enough.
    const budget = before - 2_000;
    const sent = await compact(messages, budget);

    expect(sent).toHaveLength(messages.length);
    expect(total(sent)).toBeLessThanOrEqual(budget);
    expect(pairsIntact(sent)).toBe(true);

    // Superseded read was cleared with path info.
    expect(findToolResult(sent, 'read-router-old')).toBe(
      '[earlier fs_read of src/router.ts cleared (re-read or edited later)]',
    );
    // Distinct file, disjoint slices, edit receipt, and latest read remain verbatim.
    expect(findToolResult(sent, 'read-config')).toBe(bigFileB);
    expect(findToolResult(sent, 'read-parser-1')).toBe(slice1);
    expect(findToolResult(sent, 'read-parser-2')).toBe(slice2);
    expect(findToolResult(sent, 'read-router-new')).toBe(bigFileA);
  });

  it('does not let a re-read or edit that threw clear the good read before it', async () => {
    const goodRead = numberedLines(1, 150, 100);
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Check the queue worker.' },
      ...toolExchange('read-ok', 'fs_read', { path: 'src/queue.ts' }, goodRead),
      // Genuinely superseded by read-cfg-new below: the right thing for Pass 1 to clear.
      ...toolExchange('read-cfg-old', 'fs_read', { path: 'src/cfg.ts' }, goodRead),
      // The forms a thrown error takes: the tool name, the quoted target, then "failed:".
      ...toolExchange(
        'read-threw',
        'fs_read',
        { path: 'src/queue.ts' },
        'fs_read "/home/bot/agents/b1/src/queue.ts" failed: sandbox s1: reading failed (exit 1)',
      ),
      ...toolExchange(
        'edit-threw',
        'fs_edit',
        { path: 'src/queue.ts', oldText: 'a', newText: 'b' },
        'fs_edit "/home/bot/agents/b1/src/queue.ts" failed: the bridge closed the stream',
      ),
      ...toolExchange('read-cfg-new', 'fs_read', { path: 'src/cfg.ts' }, goodRead),
      { role: 'assistant', content: 'Looking.' },
    ];

    // One cleared read is enough. Reading in order, a Pass 1 that took the
    // failures for fresh reads would clear read-ok and stop there.
    const sent = await compact(messages, total(messages) - 500);

    expect(findToolResult(sent, 'read-ok')).toBe(goodRead);
    expect(findToolResult(sent, 'read-cfg-old')).toBe(
      '[earlier fs_read of src/cfg.ts cleared (re-read or edited later)]',
    );
    expect(pairsIntact(sent)).toBe(true);
  });

  it('Pass 2 preserves short edit receipts verbatim, emits semantic stubs, and keeps failure tails', async () => {
    const editReceipt =
      'edited /home/bot/agents/b1/src/auth.ts (1 replacement, lines 42–45, +4/-2)\n' +
      '42\tif (!token) return null;\n43\treturn verify(token);';
    const writeReceipt = 'wrote 1,240 bytes to /home/bot/agents/b1/src/auth.test.ts';
    const stopReceipt = 'Stopped p1 · exited (code 143), reason: stopped';
    const failingShellOutput =
      `exit 1\nstdout:\n${'PASS test/unit.test.ts\n'.repeat(220)}` +
      'FAIL test/auth.test.ts > rejects expired JWT\n' +
      'AssertionError: expected 200 to be 401\n' +
      '    at src/auth.ts:43:12';
    const passingShellOutput = `exit 0\nstdout:\n${'PASS test/ok.test.ts\n'.repeat(220)}`;
    const failingProcessOutput =
      'p2 · exited (code 1)\n' +
      'offset: 0 -> nextOffset: 9200 (9200 bytes total)\n' +
      `output:\n${'compiling module...\n'.repeat(220)}` +
      'TS2322: Type "string" is not assignable to type "number" at src/auth.ts:19';

    const messages: ModelMessage[] = [
      { role: 'user', content: 'Fix auth bug and run full suite.' },
      // Older tool outputs (outside the last 12)
      ...toolExchange('old-read', 'fs_read', { path: 'src/legacy.ts', startLine: 1, endLine: 120 }, numberedLines(1, 120, 90)),
      ...toolExchange('old-grep', 'fs_grep', { pattern: 'verifyToken', path: 'src', glob: '*.ts' }, Array.from({ length: 120 }, (_, i) => `src/f${String(i)}.ts:12:verifyToken(req)`).join('\n')),
      ...toolExchange('old-glob', 'fs_glob', { pattern: '**/*.ts', path: 'src' }, Array.from({ length: 140 }, (_, i) => `/home/bot/agents/b1/src/mod${String(i)}.ts`).join('\n')),
      ...toolExchange('old-edit', 'fs_edit', { path: 'src/auth.ts', oldText: 'a', newText: 'b' }, editReceipt),
      ...toolExchange('old-write', 'fs_write', { path: 'src/auth.test.ts', content: 'test' }, writeReceipt),
      ...toolExchange('old-stop', 'process_stop', { processId: 'p1' }, stopReceipt),
      ...toolExchange('old-shell-fail', 'shell', { command: 'pnpm test test/auth.test.ts' }, failingShellOutput),
      ...toolExchange('old-shell-ok', 'shell', { command: 'pnpm lint' }, passingShellOutput),
      ...toolExchange('old-proc-fail', 'process_output', { processId: 'p2', offset: 0 }, failingProcessOutput),
    ];

    // Append 12 recent tool calls so all 9 above fall outside the 12-result protection window.
    const recentMessages: ModelMessage[] = [];
    for (let i = 0; i < 12; i += 1) {
      recentMessages.push(
        ...toolExchange(
          `recent-${String(i)}`,
          'fs_read',
          { path: `src/recent-${String(i)}.ts` },
          numberedLines(1, 18, 40),
        ),
      );
    }
    messages.push(...recentMessages);

    // Budget leaves room for the 12 recent results, the 3 preserved receipts, and semantic stubs
    // (forcing Pass 2 to clear all 6 bulky older outputs including old-proc-fail, without triggering Pass 3).
    const budget = total(recentMessages) + 950;
    const sent = await compact(messages, budget);

    expect(sent).toHaveLength(messages.length);
    expect(total(sent)).toBeLessThanOrEqual(budget);
    expect(pairsIntact(sent)).toBe(true);

    // Compact change receipts are preserved verbatim.
    expect(findToolResult(sent, 'old-edit')).toBe(editReceipt);
    expect(findToolResult(sent, 'old-write')).toBe(writeReceipt);
    expect(findToolResult(sent, 'old-stop')).toBe(stopReceipt);

    // Bulky older outputs become semantic stubs naming tool + target.
    expect(findToolResult(sent, 'old-read')).toContain('fs_read of src/legacy.ts (lines 1-120) cleared');
    expect(findToolResult(sent, 'old-grep')).toContain('fs_grep for "verifyToken" in src glob "*.ts" cleared');
    expect(findToolResult(sent, 'old-glob')).toContain('fs_glob for "**/*.ts" in src cleared');

    // Failed shell & process_output retain the trailing error lines; passing shell collapses to 1 line.
    const failShell = findToolResult(sent, 'old-shell-fail');
    expect(failShell).toContain('shell "pnpm test test/auth.test.ts" (exit 1,');
    expect(failShell).toContain('cleared; tail:\n');
    expect(failShell).toContain('AssertionError: expected 200 to be 401');

    const okShell = findToolResult(sent, 'old-shell-ok');
    expect(okShell).toContain('shell "pnpm lint" (exit 0,');
    expect(okShell).toContain('cleared]');
    expect(okShell).not.toContain('; tail:');

    const failProc = findToolResult(sent, 'old-proc-fail');
    expect(failProc).toContain('process_output p2 (exit 1,');
    expect(failProc).toContain('cleared; tail:\n');
    expect(failProc).toContain('TS2322: Type "string" is not assignable to type "number"');

    // All 12 most recent tool results stay verbatim.
    for (let i = 0; i < 12; i += 1) {
      expect(findToolResult(sent, `recent-${String(i)}`)).not.toContain('cleared');
    }
  });

  it('Pass 3 collapses failure tails, old edit receipts, and image tool results before evicting messages', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Debug UI and failing tests under a very tight window.' },
      // Multimodal screenshot tool result (1,600 tokens)
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'shot-1', type: 'function', function: { name: 'screenshot', arguments: '{}' } }],
      },
      {
        role: 'tool',
        toolCallId: 'shot-1',
        content: [
          {
            type: 'image',
            source: { type: 'data', mimeType: 'image/png', value: 'A'.repeat(20_000) },
          },
        ],
      },
      // Bracket-containing grep and failing shell to confirm stub detection + tail collapse
      ...toolExchange(
        'grep-brackets',
        'fs_grep',
        { pattern: '[a-z]+\\]', path: 'src' },
        Array.from({ length: 80 }, (_, i) => `src/f${String(i)}.ts:1:match]`).join('\n'),
      ),
      ...toolExchange(
        'shell-brackets',
        'shell',
        { command: 'if [ -f package.json ]; then pnpm test; fi' },
        `exit 1\nstdout:\n${'verbose output line\n'.repeat(160)}Error: boom at [handler]`,
      ),
      ...toolExchange(
        'edit-receipt',
        'fs_edit',
        { path: 'src/app.ts', oldText: 'old', newText: 'new' },
        `edited /home/bot/agents/b1/src/app.ts (1 replacement, lines 1–5, +5/-2)\n${numberedLines(1, 5, 70)}`,
      ),
    ];

    // Add 8 recent tool results (total 12 -> Pass 2 does nothing, Pass 3 handles slots 0..7 keeping last 4 verbatim).
    for (let i = 0; i < 8; i += 1) {
      messages.push(
        ...toolExchange(
          `tail-${String(i)}`,
          'fs_read',
          { path: `src/tail-${String(i)}.ts` },
          numberedLines(1, 20, 40),
        ),
      );
    }

    // Tight enough to force Pass 3b tail + receipt collapsing, while keeping all messages (no eviction).
    const recent4 = messages.slice(-8);
    const budget = total(recent4) + 420;
    const sent = await compact(messages, budget);

    expect(sent).toHaveLength(messages.length);
    expect(total(sent)).toBeLessThanOrEqual(budget);
    expect(pairsIntact(sent)).toBe(true);

    expect(findToolResult(sent, 'shot-1')).toBe('[earlier screenshot output cleared (1 image)]');
    expect(findToolResult(sent, 'grep-brackets')).toContain('fs_grep for "[a-z]+\\\\]" in src cleared');
    const shellStub = findToolResult(sent, 'shell-brackets');
    expect(shellStub).toContain('shell "if [ -f package.json ]; then pnpm test; fi" (exit 1,');
    expect(shellStub).toContain('cleared]');
    expect(shellStub).not.toContain('; tail:\n');
    expect(findToolResult(sent, 'edit-receipt')).toContain('fs_edit of src/app.ts cleared');

    // Last 4 tool results stay verbatim.
    for (let i = 4; i < 8; i += 1) {
      expect(findToolResult(sent, `tail-${String(i)}`)).not.toContain('cleared');
    }

    // Re-running compaction on the result is an exact no-op.
    expect(await compact(sent, budget)).toBe(sent);
  });

  it('compacts a realistic >100k-token coding transcript cleanly, escalates when tight, and stays idempotent', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Implement feature X across the orchestrator and fix failing tests.' },
    ];

    // 30 realistic coding steps (~125k–145k estimated tokens): repeated reads, edits, greps, failing/passing tests.
    for (let step = 0; step < 30; step += 1) {
      const file = `src/module-${String(step % 6)}.ts`;
      messages.push(
        ...toolExchange(
          `read-${String(step)}`,
          'fs_read',
          { path: file },
          numberedLines(1, 140, 95),
        ),
      );
      if (step % 3 === 0) {
        messages.push(
          ...toolExchange(
            `grep-${String(step)}`,
            'fs_grep',
            { pattern: `handler_${String(step)}`, path: 'src' },
            Array.from({ length: 80 }, (_, i) => `src/ref-${String(i)}.ts:${String(i + 1)}:handler_${String(step)}()`).join('\n'),
          ),
        );
      }
      if (step % 2 === 0) {
        messages.push(
          ...toolExchange(
            `edit-${String(step)}`,
            'fs_edit',
            { path: file, oldText: 'old', newText: 'new' },
            `edited /home/bot/agents/b1/${file} (1 replacement, lines 20–22, +3/-2)\n20\treturn handle(${String(step)});`,
          ),
        );
      }
      if (step % 5 === 4) {
        messages.push(
          ...toolExchange(
            `test-${String(step)}`,
            'shell',
            { command: 'pnpm test' },
            `exit 1\nstdout:\n${'running suite...\n'.repeat(240)}FAIL src/module-${String(step % 6)}.test.ts: boom at step ${String(step)}`,
            `Investigating test failure at step ${String(step)}.`,
          ),
        );
      }
    }

    const canonical = JSON.stringify(messages);
    const before = total(messages);
    expect(before).toBeGreaterThan(100_000);

    // 1. Default 100k budget: brings >100k transcript under 100k without evicting a single message.
    const compacted100k = await compact(messages, 100_000);
    expect(total(compacted100k)).toBeLessThanOrEqual(100_000);
    expect(compacted100k).toHaveLength(messages.length);
    expect(pairsIntact(compacted100k)).toBe(true);
    expect(JSON.stringify(messages)).toBe(canonical);

    // 2. Tighter 20k budget: exercises Pass 2 + Pass 3 escalation (still keeping tool pairs intact).
    const compacted20k = await compact(messages, 20_000);
    expect(total(compacted20k)).toBeLessThanOrEqual(20_000);
    expect(pairsIntact(compacted20k)).toBe(true);
    // Most recent tool result remains verbatim.
    expect(findToolResult(compacted20k, 'test-29')).toContain('boom at step 29');

    // 3. Idempotent when applied again and when appended with a new step.
    const reCompacted = await compact(compacted20k, 20_000);
    expect(reCompacted).toBe(compacted20k);

    const withNextStep: ModelMessage[] = [
      ...compacted20k,
      ...toolExchange('read-next', 'fs_read', { path: 'src/module-0.ts' }, numberedLines(1, 140, 95)),
    ];
    const incremental = await compact(withNextStep, 20_000);
    expect(total(incremental)).toBeLessThanOrEqual(20_000);
    expect(pairsIntact(incremental)).toBe(true);
    expect(findToolResult(incremental, 'read-next')).toContain('const line1');
  });
});
