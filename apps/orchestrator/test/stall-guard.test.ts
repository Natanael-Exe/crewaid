import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '@tanstack/ai';
import {
  STALL_REPEAT_BLOCK,
  STALL_REPEAT_WARN,
  STALL_TOOL_FAILURE_BLOCK,
  scanForStall,
  stallBlockCopy,
  stallNoticeCopy,
  stallToolFailureBlockCopy,
  stallWarnCopy,
} from '../src/agent/execution/stall-guard.js';

/**
 * The progress watch, pinned as fixtures. The scan is a pure function over
 * the canonical messages, so every threshold and every escape hatch — a page
 * that really scrolled, a result that really changed — is a fixture here. What
 * needs a run (that the notice reaches the next call's provider copy, and that
 * the block ends the loop after its one closing call) lives in the backend,
 * which owns the policy around this verdict.
 */

function user(text: string): ModelMessage {
  return { role: 'user', content: text };
}

function call(id: string, name: string, args: string): ModelMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{ id, type: 'function', function: { name, arguments: args } }],
  };
}

function result(id: string, content: string): ModelMessage {
  return { role: 'tool', toolCallId: id, content };
}

/** One tool exchange, as the canonical thread holds it: the call, then its result. */
function exchange(index: number, name: string, args: object, resultText: string): ModelMessage[] {
  return [
    call(`c${String(index)}`, name, JSON.stringify(args)),
    result(`c${String(index)}`, resultText),
  ];
}

describe('scanForStall', () => {
  it('a turn with varied work is not a stall', () => {
    const messages: ModelMessage[] = [
      user('read the page and summarize'),
      ...exchange(1, 'browser_navigate', { url: 'https://example.com' }, '{"ok":true}'),
      ...exchange(2, 'capture_screen', { amount: 3 }, 'screen-a'),
      ...exchange(3, 'capture_screen', { amount: 3 }, 'screen-b-longer'),
      ...exchange(4, 'browser_read', { selector: 'h1' }, '{"text":"Example"}'),
    ];
    expect(scanForStall(messages)).toEqual({ worst: 'none' });
  });

  it('the same scroll that moves the page is not a stall — the result changed', () => {
    const messages: ModelMessage[] = [user('read the page')];
    for (let index = 1; index <= STALL_REPEAT_BLOCK + 2; index++) {
      messages.push(
        ...exchange(
          index,
          'capture_screen',
          { amount: 3 },
          `x${String(index)}`.padEnd(index * 50, 'y'),
        ),
      );
    }
    expect(scanForStall(messages)).toEqual({ worst: 'none' });
  });

  it('three identical exchanges warn', () => {
    const messages: ModelMessage[] = [user('task')];
    for (let index = 1; index <= STALL_REPEAT_WARN; index++) {
      messages.push(...exchange(index, 'capture_screen', {}, 'same-screen-bytes'));
    }
    expect(scanForStall(messages)).toEqual({
      worst: 'warn',
      tool: 'capture_screen',
      repeats: STALL_REPEAT_WARN,
      why: 'same-result',
    });
  });

  it('five identical exchanges block', () => {
    const messages: ModelMessage[] = [user('task')];
    for (let index = 1; index <= STALL_REPEAT_BLOCK; index++) {
      messages.push(...exchange(index, 'capture_screen', { amount: 3 }, 'unchanged-screen'));
    }
    expect(scanForStall(messages)).toEqual({
      worst: 'block',
      tool: 'capture_screen',
      repeats: STALL_REPEAT_BLOCK,
      why: 'same-result',
    });
  });

  it('successful action acknowledgements do not establish a stall', () => {
    const messages: ModelMessage[] = [user('read a long page')];
    for (let index = 1; index <= 10; index++) {
      messages.push(
        ...exchange(index, 'mouse_scroll', { direction: 'down', amount: 3 }, 'Scrolled down 3.'),
      );
      messages.push(...exchange(index + 100, 'capture_screen', {}, `page-${index}`));
    }
    expect(scanForStall(messages)).toEqual({ worst: 'none' });
  });

  it('compares complete arguments beyond a shared 200-character prefix', () => {
    const messages: ModelMessage[] = [user('read files')];
    for (let index = 1; index <= 5; index++)
      messages.push(
        ...exchange(index, 'capture_screen', { path: 'x'.repeat(220) + index }, 'same'),
      );
    expect(scanForStall(messages)).toEqual({ worst: 'none' });
  });

  it('compares complete equal-length screenshots with the same header', () => {
    const messages: ModelMessage[] = [user('read the page')];
    for (let index = 1; index <= 5; index++)
      messages.push(...exchange(index, 'capture_screen', {}, 'header'.repeat(40) + index));
    expect(scanForStall(messages)).toEqual({ worst: 'none' });
  });

  it('identical capture pixels still count when evidence paths change', () => {
    const messages: ModelMessage[] = [user('observe')];
    for (let index = 1; index <= 5; index++)
      messages.push(
        ...exchange(
          index,
          'capture_screen',
          {},
          JSON.stringify({ base64: 'same-png', path: `screen-${index}.png` }),
        ),
      );
    expect(scanForStall(messages)).toMatchObject({ worst: 'block', repeats: 5 });
  });

  it('a changed observation resets its repeat streak', () => {
    const messages: ModelMessage[] = [user('watch the page')];
    for (let index = 1; index <= 7; index++)
      messages.push(...exchange(index, 'capture_screen', {}, index % 2 ? 'first' : 'second'));
    expect(scanForStall(messages)).toEqual({ worst: 'none' });
  });

  it('success resets a tool failure streak', () => {
    const messages: ModelMessage[] = [user('perform actions')];
    for (let index = 1; index <= 12; index++)
      messages.push(
        ...exchange(
          index,
          'mouse_click',
          { x: index, y: 1 },
          index % 3 ? 'mouse_click failed: offline' : 'Clicked left.',
        ),
      );
    expect(scanForStall(messages)).toEqual({ worst: 'none' });
  });

  it('does not read successful test summaries as failing tools', () => {
    const messages: ModelMessage[] = [user('test packages')];
    for (let index = 1; index <= 8; index++)
      messages.push(
        ...exchange(
          index,
          'shell',
          { command: `test package-${index}` },
          'Tests: 0 failed, 10 passed',
        ),
      );
    expect(scanForStall(messages)).toEqual({ worst: 'none' });
  });

  it('argument key order cannot defeat the signature', () => {
    const messages: ModelMessage[] = [
      user('task'),
      ...exchange(1, 'capture_screen', { amount: 3, x: 1 }, 'unchanged'),
      ...exchange(2, 'capture_screen', { x: 1, amount: 3 }, 'unchanged'),
      ...exchange(3, 'capture_screen', { x: 1, amount: 3 }, 'unchanged'),
    ];
    expect(scanForStall(messages)).toMatchObject({ worst: 'warn', repeats: 3 });
  });

  it('a tool that keeps failing under any arguments blocks at the failure bound', () => {
    const messages: ModelMessage[] = [user('task')];
    for (let index = 1; index < STALL_TOOL_FAILURE_BLOCK; index++) {
      messages.push(
        ...exchange(index, 'run_skill', { id: `s${String(index)}` }, 'run_skill failed: offline'),
      );
    }
    expect(scanForStall(messages)).toEqual({ worst: 'none' });
    messages.push(
      ...exchange(
        STALL_TOOL_FAILURE_BLOCK,
        'run_skill',
        { id: 's-final' },
        'run_skill failed: offline',
      ),
    );
    expect(scanForStall(messages)).toEqual({
      worst: 'block',
      tool: 'run_skill',
      repeats: STALL_TOOL_FAILURE_BLOCK,
      why: 'same-tool-failures',
    });
  });

  it('a refusal storm counts as the same tool failing', () => {
    const refusal =
      '{"error":"OBSERVATION_REQUIRED: This screen may have changed since you last looked."}';
    const messages: ModelMessage[] = [user('task')];
    for (let index = 1; index < STALL_TOOL_FAILURE_BLOCK; index++) {
      messages.push(...exchange(index, 'browser_click', { ref: `r${String(index)}` }, refusal));
    }
    // Varying arguments, identical refusals: under the failure bound, quiet.
    expect(scanForStall(messages)).toEqual({ worst: 'none' });
    messages.push(
      ...exchange(STALL_TOOL_FAILURE_BLOCK, 'browser_click', { ref: 'r-final' }, refusal),
    );
    expect(scanForStall(messages)).toEqual({
      worst: 'block',
      tool: 'browser_click',
      repeats: STALL_TOOL_FAILURE_BLOCK,
      why: 'same-tool-failures',
    });
  });

  it("an earlier instruction's exchanges do not count", () => {
    const messages: ModelMessage[] = [
      user('first task'),
      ...exchange(1, 'capture_screen', { amount: 3 }, 'unchanged'),
      ...exchange(2, 'capture_screen', { amount: 3 }, 'unchanged'),
      ...exchange(3, 'capture_screen', { amount: 3 }, 'unchanged'),
      ...exchange(4, 'capture_screen', { amount: 3 }, 'unchanged'),
      user('new instruction'),
      ...exchange(5, 'browser_read', { selector: 'h1' }, '{"text":"fresh"}'),
    ];
    expect(scanForStall(messages)).toEqual({ worst: 'none' });
  });

  it('the window bounds how far back the scan reads', () => {
    const messages: ModelMessage[] = [user('task')];
    for (let index = 1; index <= 4; index++) {
      messages.push(...exchange(index, 'capture_screen', { amount: 3 }, 'unchanged-screen'));
    }
    messages.push(...exchange(5, 'browser_read', { selector: 'p' }, '{"text":"x"}'));
    // The last two exchanges only: one identical scroll, one different call.
    expect(scanForStall(messages, 2)).toEqual({ worst: 'none' });
    // The full window: four identical scrolls — a warning, not yet the block.
    expect(scanForStall(messages)).toEqual({
      worst: 'warn',
      tool: 'capture_screen',
      repeats: 4,
      why: 'same-result',
    });
  });
});

describe('stall copy', () => {
  it('the model warning redirects instead of stopping', () => {
    const copy = stallWarnCopy(3);
    expect(copy).toContain('3 times');
    expect(copy).toContain('Change approach');
  });

  it('the model block ends the tool work and asks for the answer', () => {
    const copy = stallBlockCopy(5);
    expect(copy).toContain('5 times');
    expect(copy).toContain('Do not call that tool again');
    expect(copy).toContain('final answer');
  });

  it('the tool-failure block names the tool', () => {
    const copy = stallToolFailureBlockCopy('run_skill', 8);
    expect(copy).toContain('run_skill');
    expect(copy).toContain('8 times');
  });

  it('the operator notice says what happened, not the machinery', () => {
    expect(stallNoticeCopy({ repeats: 5, why: 'same-result', tool: 'capture_screen' })).toContain(
      'repeated the same action 5 times without progress',
    );
    expect(stallNoticeCopy({ repeats: 8, why: 'same-tool-failures', tool: 'run_skill' })).toContain(
      'the run_skill tool failed 8 times in a row',
    );
  });
});
