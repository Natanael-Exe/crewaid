import { describe, expect, it } from 'vitest';
import {
  errorTextOf,
  foldToolParts,
  groupToolActivity,
  summarizeInput,
  summarizeOutput,
  truncateForDisplay,
  type FoldedToolPart,
} from '../src/renderer/components/tools/toolParts';
import type { AnyPart } from '../src/renderer/components/PartRenderer';

/**
 * M5-FE-01 — one action is several parts on the wire.
 *
 * The fixtures are the shapes measured out of `ai@7.0.89` through the
 * orchestrator's own runner, not shapes invented here: `input` is the parsed
 * object rather than the JSON string the provider sent, `tool-error.error` is
 * a string for a tool that did not exist and an Error for one that threw, and
 * the approval parts nest the call they are about.
 */

const call = (id: string, name: string, input: unknown): AnyPart => ({
  type: 'tool-call',
  toolCallId: id,
  toolName: name,
  input,
});
const result = (id: string, name: string, output: unknown): AnyPart => ({
  type: 'tool-result',
  toolCallId: id,
  toolName: name,
  input: {},
  output,
  dynamic: false,
});
const text = (value: string): AnyPart => ({ type: 'text', text: value });

function rows(parts: AnyPart[]): FoldedToolPart[] {
  return foldToolParts(parts).filter(
    (part): part is FoldedToolPart => part.type === 'tool-call',
  ) as FoldedToolPart[];
}

describe('foldToolParts', () => {
  it('makes one row out of a call and its result', () => {
    const folded = foldToolParts([
      text('Let me look.'),
      call('tc-1', 'browser_navigate', { url: 'https://example.com' }),
      result('tc-1', 'browser_navigate', { ok: true }),
      text('The heading is Example Domain.'),
    ]);

    expect(folded.map((part) => part.type)).toEqual(['text', 'tool-call', 'text']);
    expect(folded[1]).toMatchObject({ status: 'ok', toolName: 'browser_navigate' });
  });

  it('keeps the row where the CALL was, not where the result landed', () => {
    // M5-BE-09 means a result can settle a whole agent round later, after the
    // bot has already said something else. Printing it where it arrived would
    // put the answer after a sentence written before the question.
    const folded = foldToolParts([
      call('tc-1', 'shell', { command: 'ls' }),
      text('running that now'),
      result('tc-1', 'shell', 'a.txt'),
    ]);

    expect(folded.map((part) => part.type)).toEqual(['tool-call', 'text']);
    expect(folded[0]).toMatchObject({ status: 'ok', output: 'a.txt' });
  });

  it('leaves a call with no outcome running', () => {
    // The in-flight case: the call frame has arrived and the result has not.
    expect(rows([call('tc-1', 'browser_read', {})])[0]).toMatchObject({ status: 'running' });
  });

  it('reads a tool that threw and a tool that never existed', () => {
    const threw = rows([
      call('tc-1', 'shell', { command: 'ls' }),
      {
        type: 'tool-error',
        toolCallId: 'tc-1',
        toolName: 'shell',
        input: {},
        error: { message: 'the container is not running' },
        dynamic: false,
      },
    ]);
    expect(threw[0]).toMatchObject({ status: 'error', detail: 'the container is not running' });

    // An unregistered tool settles on the CALL part, which carries
    // `invalid: true` and its own error and produces no separate outcome.
    const invalid = rows([
      {
        type: 'tool-call',
        toolCallId: 'tc-2',
        toolName: 'no_such_tool',
        input: {},
        dynamic: false,
        invalid: true,
        error: 'No such tool: no_such_tool',
      },
    ]);
    expect(invalid[0]).toMatchObject({ status: 'error', detail: 'No such tool: no_such_tool' });
  });

  it('carries the approval exchange as status, not as extra rows', () => {
    const folded = foldToolParts([
      call('tc-1', 'shell', { command: 'rm -rf /' }),
      {
        type: 'tool-approval-request',
        approvalId: 'ap-1',
        toolCall: { type: 'tool-call', toolCallId: 'tc-1', toolName: 'shell', input: {} },
      },
      {
        type: 'tool-approval-response',
        approvalId: 'ap-1',
        approved: false,
        reason: 'absolutely not',
        toolCall: { type: 'tool-call', toolCallId: 'tc-1', toolName: 'shell', input: {} },
      },
    ]);

    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ status: 'denied', detail: 'absolutely not', asked: true });
  });

  it('leaves a call waiting while nobody has answered', () => {
    const folded = rows([
      call('tc-1', 'shell', { command: 'rm -rf /' }),
      {
        type: 'tool-approval-request',
        approvalId: 'ap-1',
        toolCall: { type: 'tool-call', toolCallId: 'tc-1', toolName: 'shell', input: {} },
      },
    ]);
    expect(folded[0]).toMatchObject({ status: 'awaiting-approval', asked: true });
  });

  it('reads an approved call as running until its outcome lands, whatever the part order', () => {
    const request = {
      type: 'tool-approval-request',
      approvalId: 'ap-1',
      toolCall: { type: 'tool-call', toolCallId: 'tc-1', toolName: 'shell', input: {} },
    };
    const yes = {
      type: 'tool-approval-response',
      approvalId: 'ap-1',
      approved: true,
      toolCall: { type: 'tool-call', toolCallId: 'tc-1', toolName: 'shell', input: {} },
    };
    // The operator has answered, so nothing on the row may still ask them to.
    for (const parts of [
      [call('tc-1', 'shell', { command: 'ls' }), request, yes],
      [call('tc-1', 'shell', { command: 'ls' }), yes, request],
    ]) {
      expect(rows(parts)[0]).toMatchObject({ status: 'running', asked: true });
    }
  });

  it('lets the outcome win over the question it answered', () => {
    // The resumed round settles an approved call with a plain `tool-result`
    // and no response part, so a row left on `awaiting-approval` would be a
    // prompt for a question already answered.
    const folded = rows([
      call('tc-1', 'shell', { command: 'ls' }),
      {
        type: 'tool-approval-request',
        approvalId: 'ap-1',
        toolCall: { type: 'tool-call', toolCallId: 'tc-1', toolName: 'shell', input: {} },
      },
      result('tc-1', 'shell', 'a.txt'),
    ]);
    expect(folded[0]).toMatchObject({ status: 'ok', asked: true });
  });

  it('settles on the outcome even when it is listed before the question', () => {
    // The precedence is structural, not a consequence of the order the parts
    // happen to arrive in. They do arrive in order today, which is what would
    // make the weaker version look correct right up until something reordered
    // them — and M5-BE-09's resumed round already contributes its outcome to
    // the FRONT of that round's parts.
    const folded = rows([
      call('tc-1', 'shell', { command: 'ls' }),
      result('tc-1', 'shell', 'a.txt'),
      {
        type: 'tool-approval-request',
        approvalId: 'ap-1',
        toolCall: { type: 'tool-call', toolCallId: 'tc-1', toolName: 'shell', input: {} },
      },
    ]);
    expect(folded[0]).toMatchObject({ status: 'ok', asked: true });
  });

  it('reads an operator refusal that arrives as tool-output-denied', () => {
    const folded = rows([
      call('tc-1', 'shell', { command: 'rm -rf /' }),
      { type: 'tool-output-denied', toolCallId: 'tc-1', toolName: 'shell' },
    ]);
    expect(folded[0]).toMatchObject({ status: 'denied' });
  });

  it('leaves an orphan outcome alone rather than dropping it', () => {
    // A history page that begins mid-turn: the call is on the page before.
    // Dropping the result would be worse than showing it on its own.
    const folded = foldToolParts([result('tc-9', 'browser_read', 'page text'), text('done')]);
    expect(folded.map((part) => part.type)).toEqual(['tool-result', 'text']);
  });

  it('folds several calls in one step without mixing them up', () => {
    const folded = rows([
      call('tc-1', 'browser_navigate', { url: 'https://example.com' }),
      call('tc-2', 'browser_read', {}),
      result('tc-2', 'browser_read', 'Example Domain'),
      result('tc-1', 'browser_navigate', { ok: true }),
    ]);

    expect(folded.map((row) => row.toolName)).toEqual(['browser_navigate', 'browser_read']);
    expect(folded[0]).toMatchObject({ status: 'ok', output: { ok: true } });
    expect(folded[1]).toMatchObject({ status: 'ok', output: 'Example Domain' });
  });

  it('is a projection: it never touches the parts it was given', () => {
    const parts = [call('tc-1', 'shell', { command: 'ls' }), result('tc-1', 'shell', 'a.txt')];
    const before = JSON.stringify(parts);
    foldToolParts(parts);
    expect(JSON.stringify(parts)).toBe(before);
  });

  it('passes anything that is not a tool part straight through', () => {
    const parts = [text('hi'), { type: 'reasoning', text: 'thinking' } as AnyPart];
    expect(foldToolParts(parts)).toEqual(parts);
  });
});

describe('groupToolActivity', () => {
  it('replaces several action rows with one disclosure at the first action', () => {
    const grouped = groupToolActivity(
      foldToolParts([
        text('Starting.'),
        call('tc-1', 'browser_navigate', { url: 'https://example.com' }),
        result('tc-1', 'browser_navigate', 'opened'),
        text('Checking the page.'),
        call('tc-2', 'browser_read', {}),
        result('tc-2', 'browser_read', 'Example Domain'),
        text('Done.'),
      ]),
    );

    expect(grouped.map((part) => part.type)).toEqual(['text', 'tool-activity', 'text', 'text']);
    expect(grouped[1]).toMatchObject({
      calls: [
        { toolName: 'browser_navigate', status: 'ok' },
        { toolName: 'browser_read', status: 'ok' },
      ],
    });
  });

  it('leaves replies without complete action rows unchanged', () => {
    const parts = [text('Hello'), { type: 'reasoning', text: 'thinking' } as AnyPart];
    expect(groupToolActivity(parts)).toEqual(parts);
  });
});

describe('one-line summaries', () => {
  it('reads a single-argument tool as its bare value', () => {
    expect(summarizeInput({ url: 'https://example.com' })).toBe('https://example.com');
    expect(summarizeInput({ command: 'ls -la' })).toBe('ls -la');
  });

  it('keeps the keys when there is more than one', () => {
    expect(summarizeInput({ selector: '#go', text: 'hello' })).toBe('selector=#go text=hello');
  });

  it('says nothing for a tool that takes nothing', () => {
    expect(summarizeInput({})).toBe('');
    expect(summarizeInput(undefined)).toBe('');
  });

  it('shows the first line of a result and marks the rest as elided', () => {
    expect(summarizeOutput('Example Domain\nThis domain is for use in examples.')).toBe(
      'Example Domain …',
    );
    expect(summarizeOutput('one line')).toBe('one line');
  });

  it('bounds what a row can put on screen, and says how much it cut', () => {
    // §6/M5 caps a tool result at 100 KB before it reaches the MODEL; nothing
    // caps what reaches the transcript, and a `browser_read` of a real page is
    // the whole accessibility tree.
    const huge = 'x'.repeat(100_000);
    const line = summarizeOutput(huge, 120);
    expect(line.length).toBeLessThan(200);
    expect(line).toContain('100,000 characters');
  });

  it('never throws on a value JSON cannot express', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => summarizeOutput(cyclic)).not.toThrow();
    expect(() => summarizeInput(cyclic)).not.toThrow();
  });

  it('leaves a short value alone', () => {
    expect(truncateForDisplay('short', 120)).toBe('short');
  });
});

describe('errorTextOf', () => {
  it('reads both shapes the SDK produces, and invents nothing for a third', () => {
    expect(errorTextOf('No such tool: nope')).toBe('No such tool: nope');
    expect(errorTextOf(new Error('the container is not running'))).toBe(
      'the container is not running',
    );
    // `String({})` would put "[object Object]" in the transcript.
    expect(errorTextOf({})).toBe('The tool failed.');
    expect(errorTextOf(undefined)).toBe('The tool failed.');
  });
});

describe('D-113 a plugin call is shown as the plugin tool, not the door', () => {
  it('names the tool the call will run and hands over its own arguments', () => {
    const [row] = rows([
      call('c1', 'use_plugin_tool', {
        tool: 'github__create_issue',
        arguments: { title: 'a bug', repo: 'crewaid' },
      }),
      result('c1', 'use_plugin_tool', 'opened #12'),
    ]);

    // The name of the thing acting on the operator's account, which is what
    // §6/M6 wants a transcript to show — not "use_plugin_tool", the name of a
    // mechanism this build invented.
    expect(row?.toolName).toBe('github__create_issue');
    expect(row?.input).toEqual({ title: 'a bug', repo: 'crewaid' });
    expect(row?.status).toBe('ok');
  });

  it('is the same pair the approval prompt showed, so one call reads one way', () => {
    // `pendingApprovalsIn` recovers name and arguments from this same payload
    // on the orchestrator side. A transcript that named the door would
    // describe one call two ways across two surfaces.
    const [row] = rows([
      call('c2', 'use_plugin_tool', {
        tool: 'github__create_issue',
        arguments: { title: 'a bug' },
      }),
    ]);

    expect(row?.toolName).toBe('github__create_issue');
  });

  it('falls back to the door rather than dropping a call it cannot read', () => {
    const [row] = rows([call('c3', 'use_plugin_tool', { nothing: 'recognisable' })]);

    expect(row?.toolName).toBe('use_plugin_tool');
    expect(row?.input).toEqual({ nothing: 'recognisable' });
  });

  it('leaves every other tool exactly as it was', () => {
    const [row] = rows([call('c4', 'shell', { command: 'ls' })]);

    expect(row?.toolName).toBe('shell');
    expect(row?.input).toEqual({ command: 'ls' });
  });
});
