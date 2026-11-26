import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolActivityPart, ToolCallPart } from '../src/renderer/components/tools/ToolCallPart';
import { renderPart, resolvePartRenderer } from '../src/renderer/components/PartRenderer';
import { foldToolParts, groupToolActivity } from '../src/renderer/components/tools/toolParts';
import type { AnyPart } from '../src/renderer/components/PartRenderer';

/**
 * M5-FE-01 — the row a tool call renders as, and D-215 — which rows the
 * transcript keeps in front of the operator.
 *
 * Before this, every tool part in the transcript rendered as
 * "[unsupported part type: tool-call]" — the registry's fallback, which the
 * first assertion here pins as no longer reachable for the four tool types.
 * After CC-80, every tool part rendered as a card; after D-215, cards are for
 * what the user keeps and routine actions are one quiet line.
 */

function render(part: AnyPart): string {
  return renderToStaticMarkup(<ToolCallPart part={part} />);
}

const call: AnyPart = {
  type: 'tool-call',
  toolCallId: 'tc-1',
  toolName: 'browser_navigate',
  input: { url: 'https://example.com' },
};

// Static markup escapes the angle brackets and quotes; assertions read them
// through these constants so the source shows the characters being tested.
const ESC = {
  lt: '&lt;',
  gt: '&gt;',
  quot: '&quot;',
};

function folded(parts: AnyPart[]): AnyPart {
  const row = foldToolParts(parts)[0];
  if (row === undefined) throw new Error('the fold produced no row');
  return row;
}

describe('ToolCallPart', () => {
  it('is what the registry resolves for every tool part type', () => {
    for (const type of ['tool-call', 'tool-result', 'tool-error', 'tool-output-denied']) {
      expect(resolvePartRenderer(type), type).toBe(ToolCallPart);
    }
    expect(renderToStaticMarkup(<>{renderPart(call)}</>)).not.toContain('unsupported part type');
  });

  it('renders a routine action as one quiet line, its arguments in the details', () => {
    const html = render(folded([call]));
    expect(html).toContain('data-tool-line');
    expect(html).not.toContain('data-tool-card=');
    expect(html).toContain('browser_navigate');
    expect(html).toContain('https://example.com');
  });

  it('carries the status in words as well as in a marker', () => {
    // The glyph is aria-hidden decoration and colour is not a state, so the
    // row says what happened in text a screen reader reaches.
    const html = render(folded([call]));
    expect(html).toContain('Running');
    expect(html).toContain('aria-hidden');
    expect(html).toContain('data-tool-status="running"');
  });

  it('settles into a result, which stays in the details', () => {
    const html = render(
      folded([
        call,
        {
          type: 'tool-result',
          toolCallId: 'tc-1',
          toolName: 'browser_navigate',
          input: {},
          output: 'Example Domain',
          dynamic: false,
        },
      ]),
    );
    expect(html).toContain('data-tool-status="ok"');
    expect(html).toContain('Example Domain');
  });

  it('keeps a read-only connected-app call out of the cards', () => {
    const html = render(
      folded([
        { ...call, toolName: 'gmail__GMAIL_FETCH_EMAILS', input: { query: 'is:unread' } },
        {
          type: 'tool-result',
          toolCallId: 'tc-1',
          output: JSON.stringify({ resultSizeEstimate: 4, messages: [] }),
          dynamic: false,
        },
      ]),
    );
    expect(html).toContain('data-tool-line');
    expect(html).not.toContain('data-tool-card=');
    // The raw payload is machinery: one disclosure away, never on the face.
    expect(html.indexOf('data-slot="disclosure"')).toBeLessThan(html.indexOf('resultSizeEstimate'));
  });

  it('shows what the user keeps as a card, and the payload never on its face', () => {
    const html = render(
      folded([
        {
          ...call,
          toolName: 'gmail__GMAIL_SEND_EMAIL',
          input: {
            recipient_email: 'Alex <alex@example.test>',
            subject: 'Hosting proposal',
            body: 'Hello Alex',
          },
        },
        {
          type: 'tool-result',
          toolCallId: 'tc-1',
          output: JSON.stringify({ draft_id: 'draft-9' }),
          dynamic: false,
        },
      ]),
    );
    expect(html).toContain('data-tool-card="email"');
    expect(html).toContain('Hosting proposal');
    expect(html).toContain('Email sent');
    // A successful action's raw result is machinery, not message (D-215).
    expect(html).not.toContain('data-result-status');
    expect(html.indexOf('data-slot="disclosure"')).toBeLessThan(html.indexOf('draft-9'));
  });

  it('shows a failure as the failure text, never as [object Object]', () => {
    const html = render(
      folded([
        { type: 'tool-call', toolCallId: 'tc-2', toolName: 'shell', input: { command: 'ls' } },
        {
          type: 'tool-error',
          toolCallId: 'tc-2',
          toolName: 'shell',
          input: {},
          error: { message: 'the container is not running' },
          dynamic: false,
        },
      ]),
    );
    expect(html).toContain('data-tool-status="error"');
    expect(html).toContain('the container is not running');
    expect(html).not.toContain('object Object');
  });

  it('says a human declined it, and why', () => {
    const html = render(
      folded([
        {
          type: 'tool-call',
          toolCallId: 'tc-3',
          toolName: 'shell',
          input: { command: 'rm -rf /' },
        },
        {
          type: 'tool-approval-request',
          approvalId: 'ap-1',
          toolCall: { type: 'tool-call', toolCallId: 'tc-3', toolName: 'shell', input: {} },
        },
        {
          type: 'tool-approval-response',
          approvalId: 'ap-1',
          approved: false,
          reason: 'not on this machine',
          toolCall: { type: 'tool-call', toolCallId: 'tc-3', toolName: 'shell', input: {} },
        },
      ]),
    );
    expect(html).toContain('data-tool-status="denied"');
    expect(html).toContain('not on this machine');
    expect(html).toContain('You declined this.');
  });

  it('offers the full arguments and result behind a collapsed disclosure line', () => {
    const html = render(
      folded([
        call,
        {
          type: 'tool-result',
          toolCallId: 'tc-1',
          toolName: 'browser_navigate',
          input: {},
          output: { ok: true, title: 'Example Domain' },
          dynamic: false,
        },
      ]),
    );
    // HeroUI Disclosure: collapsed by default, keeping its payload inspectable on demand.
    expect(html).toContain('data-slot="disclosure"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`${ESC.quot}title${ESC.quot}: ${ESC.quot}Example Domain${ESC.quot}`);
  });

  it('bounds a huge result instead of putting it all in the transcript', () => {
    const html = render(
      folded([
        { type: 'tool-call', toolCallId: 'tc-4', toolName: 'browser_read', input: {} },
        {
          type: 'tool-result',
          toolCallId: 'tc-4',
          toolName: 'browser_read',
          input: {},
          output: 'y'.repeat(200_000),
          dynamic: false,
        },
      ]),
    );
    // §6/M5's 100 KB cap is on what reaches the MODEL. The persisted part is
    // the full one, so a transcript that rendered it verbatim would put a
    // 200 KB string in the DOM for one row.
    expect(html.length).toBeLessThan(20_000);
    expect(html).toContain('200,000 characters');
  });

  it('renders an outcome whose call is not on this page', () => {
    // A history page that begins mid-turn hands the renderer the result
    // directly, with no fold to pair it.
    const html = render({
      type: 'tool-result',
      toolCallId: 'tc-9',
      toolName: 'browser_read',
      input: {},
      output: 'page text',
      dynamic: false,
    });
    expect(html).toContain('browser_read');
    expect(html).toContain('page text');
    expect(html).toContain('data-tool-status="ok"');
  });

  it('does not break on a part with nothing in it', () => {
    expect(() => render({ type: 'tool-call' })).not.toThrow();
    expect(render({ type: 'tool-call' })).toContain('tool');
  });
});

describe('ToolActivityPart', () => {
  function activity(parts: AnyPart[]): AnyPart {
    const grouped = groupToolActivity(foldToolParts(parts));
    const part = grouped.find((candidate) => candidate.type === 'tool-activity');
    if (part === undefined) throw new Error('the activity group was not produced');
    return part;
  }

  /** One settled call+result pair, with its own id so the fold keeps both. */
  function turn(id: string, name: string, input: unknown, output: unknown): AnyPart[] {
    return [
      { type: 'tool-call', toolCallId: id, toolName: name, input },
      { type: 'tool-result', toolCallId: id, toolName: name, input: {}, output, dynamic: false },
    ];
  }

  const routineTurns = [
    ...turn(
      't1',
      'gmail__GMAIL_FETCH_EMAILS',
      { query: 'is:unread' },
      JSON.stringify({ resultSizeEstimate: 4, messages: [] }),
    ),
    ...turn('t2', 'browser_read', {}, 'page text'),
  ];

  it('keeps deliverables as cards and omits routine rows (including fs_write) when work is hidden', () => {
    const html = renderToStaticMarkup(
      <ToolActivityPart
        part={activity([
          ...routineTurns,
          ...turn('t4', 'fs_write', { path: '/home/bot/agents/a/patch.py', content: 'x' }, 'wrote'),
          ...turn(
            't3',
            'preview_email',
            { to: 'Alex', subject: 'Proposal', body: 'Hello' },
            'shown',
          ),
        ])}
        context={{ showWork: false }}
      />,
    );
    expect(resolvePartRenderer('tool-activity')).toBe(ToolActivityPart);
    expect(html).toContain('data-tool-activity="true"');
    expect(html).toContain('Proposal');
    expect(html).not.toContain('browser_read');
    expect(html).not.toContain('Fetch emails');
    expect(html).not.toContain('patch.py');
    expect(html).not.toContain('data-tool-line');
  });

  it('opens the action log while the reply streams when work is shown', () => {
    const live = renderToStaticMarkup(
      <ToolActivityPart
        part={activity(routineTurns)}
        context={{ showWork: true, streaming: true }}
      />,
    );
    expect(live).toMatch(/data-slot="chat-tool-group-trigger"[^>]*aria-expanded="true"/);
  });

  it('keeps the routine log one collapsed disclosure away when settled and work is shown', () => {
    const html = renderToStaticMarkup(
      <ToolActivityPart part={activity(routineTurns)} context={{ showWork: true }} />,
    );
    expect(html).toContain('data-tool-line');
    expect(html).toContain('2 actions');
    expect(html).toContain('Fetch emails');
    expect(html).toMatch(/data-slot="chat-tool-group-trigger"[^>]*aria-expanded="false"/);
  });

  it('surfaces a failure of something the user keeps, in words', () => {
    const html = renderToStaticMarkup(
      <ToolActivityPart
        part={activity([
          {
            ...call,
            toolName: 'gmail__GMAIL_SEND_EMAIL',
            input: { recipient_email: 'alex@example.test', subject: 'Proposal' },
          },
          {
            type: 'tool-error',
            toolCallId: 'tc-1',
            toolName: 'gmail__GMAIL_SEND_EMAIL',
            error: { message: 'the provider refused the send' },
            dynamic: false,
          },
        ])}
        context={{ showWork: false }}
      />,
    );
    expect(html).toContain('What went wrong');
    expect(html).toContain('the provider refused the send');
    // The face comes before the details: the failure is the message.
    expect(html.indexOf('data-tool-call')).toBeLessThan(html.indexOf('data-slot="disclosure"'));
    expect(html).not.toContain('Finished with 1 issue');
    expect(html).toContain('data-tool-activity-status="issue"');
  });

  it('hides a routine failure with the work, and renders a single routine action as one thin collapsible line when work is shown', () => {
    const failed = activity([
      {
        type: 'tool-call',
        toolCallId: 'tc-2',
        toolName: 'shell',
        input: { command: 'ls' },
      },
      {
        type: 'tool-error',
        toolCallId: 'tc-2',
        toolName: 'shell',
        input: {},
        error: { message: 'the container is not running' },
        dynamic: false,
      },
    ]);
    expect(
      renderToStaticMarkup(<ToolActivityPart part={failed} context={{ showWork: false }} />),
    ).toBe('');
    const shown = renderToStaticMarkup(
      <ToolActivityPart part={failed} context={{ showWork: true }} />,
    );
    expect(shown).toContain('data-tool-line');
    expect(shown).toContain('Run a command');
    expect(shown).toContain('the container is not running');
    expect(shown).toContain('data-tool-activity-status="issue"');
    expect(shown).toContain('aria-expanded="false"');
  });
});

describe('recoverable tool cards', () => {
  it('does not keep a missing result running after the turn ends or an approval is abandoned', () => {
    for (const status of ['running', 'awaiting-approval'] as const) {
      const html = renderToStaticMarkup(
        <ToolCallPart part={{ ...call, status }} context={{ streaming: false }} />,
      );
      expect(html).toContain('data-tool-status="incomplete"');
      expect(html).toContain('Not completed');
      expect(html).not.toContain('animate-spin');
    }
    const html = renderToStaticMarkup(
      <ToolCallPart
        part={{ ...call, status: 'awaiting-approval' }}
        context={{ streaming: false, pendingToolCalls: new Set(['tc-1']) }}
      />,
    );
    expect(html).toContain('Needs approval');
  });

  it('uses the adapter failure outcome even when the tool transport succeeded', () => {
    for (const [toolName, output] of [
      ['shell', 'exit 1\nstderr:\nPermission denied'],
      ['shell', 'shell "ls" failed: computer unavailable'],
      ['browser_navigate', 'navigate failed: browser unavailable'],
      ['gmail__GMAIL_FETCH_EMAILS', 'The tool reported an error.\nConnection expired'],
      ['unknown', { isError: true, content: [{ type: 'text', text: 'failed' }] }],
    ] as const) {
      expect(
        render({ type: 'tool-call', toolCallId: 'x', toolName, input: {}, status: 'ok', output }),
      ).toContain('data-tool-status="error"');
    }
    expect(
      render({
        type: 'tool-call',
        toolCallId: 'x',
        toolName: 'unknown',
        input: {},
        status: 'ok',
        output: 'An article about failed businesses',
      }),
    ).toContain('data-tool-status="ok"');
  });

  it('unwraps a connected-app action and keeps its result escaped in the details', () => {
    const part = folded([
      {
        ...call,
        toolName: 'use_plugin_tool',
        input: { tool: 'gmail__GMAIL_FETCH_EMAILS', arguments: { query: 'is:unread' } },
      },
      {
        type: 'tool-result',
        toolCallId: 'tc-1',
        output: JSON.stringify({
          resultSizeEstimate: 4,
          messages: [
            {
              subject: 'Project update',
              sender: 'Alex',
              snippet: '<img src="https://evil.example/track" />',
            },
          ],
        }),
      },
    ]);
    const html = renderToStaticMarkup(
      <ToolCallPart
        part={part}
        context={{ toolLabels: new Map([['gmail__GMAIL_FETCH_EMAILS', 'Read emails']]) }}
      />,
    );
    expect(html).toContain('data-tool-line');
    expect(html).toContain('Read emails');
    expect(html).toContain('Project update');
    expect(html).toContain(`${ESC.lt}img`);
    // The row's own mark is a bundled data URI; nothing may load from a host.
    expect(html).not.toMatch(/<img src="(?!data:)/);
    expect(html).not.toContain('use_plugin_tool');
  });

  it('shows a bounded file preview, and never labels a rejected write as written', () => {
    const part = {
      type: 'tool-call',
      toolCallId: 'file',
      toolName: 'fs_write',
      status: 'ok',
      input: {
        path: '/home/bot/update.md',
        content: '<script>evil()</script>' + 'x'.repeat(100_000),
      },
      output: 'wrote 100 bytes',
    };
    const html = render(part);
    expect(html).toContain('File written');
    expect(html).toContain(`${ESC.lt}script${ESC.gt}`);
    expect(html).not.toContain('<script>');
    expect(html.length).toBeLessThan(15_000);
    const failed = render({ ...part, output: 'fs_write refused: invalid path' });
    expect(failed).toContain('Failed');
    expect(failed).not.toContain('File written');
  });

  it('renders fs_write and attach_file as thin muted lines with internal paths hidden behind a hoverable path hint', () => {
    const internalPath = '/home/bot/agents/cmww0x3xr0007zq3bw7scat2i/update.md';
    const html = render({
      type: 'tool-call',
      toolCallId: 'file',
      toolName: 'fs_write',
      status: 'ok',
      input: { path: internalPath, content: '# Plan' },
      output: 'wrote 7 bytes',
    });
    expect(html).toContain('data-tool-line');
    expect(html).not.toContain('data-tool-card=');
    expect(html).toContain('Write a file');
    expect(html).toContain('update.md');
    expect(html).toContain('data-internal-path-hint="true"');
    expect(html).toContain(`data-path="${internalPath}"`);
    expect(html).toContain('>path<');
    // The expanded details hold the file contents behind the collapsed disclosure.
    expect(html.indexOf('data-slot="disclosure"')).toBeLessThan(html.indexOf('Plan'));

    const attached = render({
      type: 'tool-call',
      toolCallId: 'attach-1',
      toolName: 'attach_file',
      status: 'ok',
      input: { path: internalPath },
      output: 'attached',
    });
    expect(attached).toContain('data-tool-line');
    expect(attached).not.toContain('data-tool-card=');
    expect(attached).toContain('data-internal-path-hint="true"');
  });

  it('renders fs_edit as a quiet line with diff preview and never labels a failed edit as edited', () => {
    const internalPath = '/home/bot/agents/cmww0x3xr0007zq3bw7scat2i/app.ts';
    const part = {
      type: 'tool-call',
      toolCallId: 'edit-1',
      toolName: 'fs_edit',
      status: 'ok',
      input: { path: internalPath, oldText: 'const x = 1;', newText: 'const x = 2;' },
      output: `edited ${internalPath} (1 replacement, lines 1–1, +1/-1)`,
    };
    const html = render(part);
    expect(html).toContain('data-tool-line');
    expect(html).toContain('Edit a file');
    expect(html).toContain('app.ts');
    expect(html).toContain('File edited');
    expect(html).toContain('- const x = 1;');
    expect(html).toContain('+ const x = 2;');

    const failed = render({ ...part, output: 'fs_edit failed: oldText was not found' });
    expect(failed).toContain('Failed');
    expect(failed).not.toContain('File edited');
  });

  it('renders process_start as a quiet computer line and marks cancelled runs incomplete', () => {
    const part = {
      type: 'tool-call',
      toolCallId: 'proc-1',
      toolName: 'process_start',
      status: 'ok',
      input: { command: 'pnpm dev', maxDurationSec: 900 },
      output: 'Started background process proc-123 (running)\ntime limit: 15m',
    };
    const html = render(part);
    expect(html).toContain('data-tool-line');
    expect(html).toContain('Start background process');
    expect(html).toContain('time limit: 15m');

    const cancelled = render({
      ...part,
      output: 'process_start: the turn was cancelled before the process started.',
    });
    expect(cancelled).toContain('data-tool-status="incomplete"');
  });
});
