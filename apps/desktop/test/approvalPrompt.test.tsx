import { approvalBinding } from './approvalBinding';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import {
  ApprovalPrompt,
  ApprovalPromptList,
} from '../src/renderer/components/tools/ApprovalPrompt';
import type { PendingApproval } from '../src/renderer/state/chatReducer';
import {
  ToolApprovalAnswerSchema,
  ToolApprovalRequestSchema,
  type Bot,
  type ToolApprovalRequest,
} from '@crewaid/shared';
import { Transcript } from '../src/renderer/components/Transcript';

const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';

/**
 * M5-FE-02 — the question a suspended turn is waiting on.
 *
 * The only control in the app whose absence is a hang rather than a missing
 * feature: a rule that says `ask` ends the agent stream with the call
 * unexecuted (D-051), and nothing moves until the question is answered.
 *
 * The question now reaches the operator as the run's own bound interrupt and
 * the answer goes back by resolving it, so the contract the buttons have to
 * satisfy is the interrupt's payload and response schemas rather than a §4.2
 * frame. The prompt itself is unchanged — same `PendingApproval` prop, same
 * `onRespond(toolCallId, approved, editedArgs)` — which is the point: what an
 * operator reads and presses did not move when the transport under it did.
 */

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
}

const shell: PendingApproval = {
  binding: approvalBinding('shell'),
  toolCallId: 'tc-1',
  turnId: 'clx1a2b3c4d5e6f7g8h9i0j1',
  toolName: 'shell',
  args: { command: 'rm -rf /home/bot/work' },
};

describe('ApprovalPrompt', () => {
  it('shows the approved Git destination and bounded change summary as escaped text', () => {
    const html = render(
      <ApprovalPrompt
        approval={{
          ...shell,
          binding: {
            ...shell.binding,
            effect: 'commit',
            commit: {
              account: 'account',
              destinations: ['https://github.com/owner/repo'],
              contentRevision: 'c'.repeat(64),
              review: {
                repository: 'owner/repo',
                branch: 'fix',
                commit: 'a'.repeat(40),
                files: ['<script>evil</script>'],
                summary: '1 file changed',
              },
            },
          },
        }}
        botName="Warden"
        onRespond={() => undefined}
      />,
    );
    expect(html).toContain('owner/repo');
    expect(html).toContain('1 file changed');
    expect(html).toContain('&lt;script&gt;evil&lt;/script&gt;');
    expect(html).not.toContain('<script>evil');
  });
  it('explains the named-login window and keeps editing limited to call approvals', () => {
    const html = render(
      <ApprovalPrompt
        approval={{
          ...shell,
          binding: {
            ...shell.binding,
            scope: 'identity-turn',
            seat: { identity: 'company-google', browserGeneration: 2 },
          },
        }}
        botName="Warden"
        onRespond={() => undefined}
      />,
    );
    expect(html).toContain('company-google');
    expect(html).toContain('Those actions may change the account.');
    expect(html).not.toContain('Edit arguments before approving');
  });
  it('sends edited arguments without accepting any client policy fields', () => {
    // The edited command is the operator's to change; the binding is the
    // server's answer about what the call is allowed to be, so an answer
    // carrying one would be a client voting on its own policy.
    expect(
      ToolApprovalAnswerSchema.safeParse({ approved: true, editedArgs: { command: 'pwd' } }),
    ).toMatchObject({ success: true, data: { editedArgs: { command: 'pwd' } } });
    expect(
      ToolApprovalAnswerSchema.safeParse({ approved: true, binding: shell.binding }).success,
    ).toBe(false);
  });

  it('asks in words, in the first person, and keeps the tool name in the detail', () => {
    const html = render(
      <ApprovalPrompt approval={shell} botName="Warden" onRespond={() => undefined} />,
    );

    // `Warden wants to run shell` names a function and leaves the reader to
    // work out what agreeing to it means. The bot is the one asking, and the
    // decision is about the act.
    expect(html).toContain('Can I run this on my computer?');
    expect(html).not.toContain('wants to run');
    // The command, not an elision of it: this is the one screen where someone
    // is deciding whether to let something run, and for `shell` the command IS
    // the question.
    expect(html).toContain('rm -rf /home/bot/work');
    // Still reachable — one disclosure away, not gone.
    expect(html).toContain('shell');
    expect(html).toContain('Details');
  });

  it('names the act for the tools a person would not recognise by name', () => {
    const cases: Array<[string, unknown, string]> = [
      ['attach_file', { path: '/home/bot/report/kreova.md' }, 'Can I attach a file to this chat?'],
      ['browser_navigate', { url: 'https://kreova.co/pricing' }, 'Can I open kreova.co?'],
      ['remember', { fact: 'The report is done' }, 'Can I make a note of this?'],
      // A tool this build has never heard of — an M6 MCP tool, a compiled
      // skill — is still asked about as an act, not as a signature.
      ['gmail__send_draft', {}, 'Can I use my gmail send draft tool?'],
    ];
    for (const [toolName, args, question] of cases) {
      const html = render(
        <ApprovalPrompt
          approval={{ ...shell, toolName, args: args as PendingApproval['args'] }}
          botName="Warden"
          onRespond={() => undefined}
        />,
      );
      expect(html, toolName).toContain(question);
    }
  });

  it('offers both answers, named for the tool they answer about', () => {
    const html = render(
      <ApprovalPrompt approval={shell} botName="Warden" onRespond={() => undefined} />,
    );

    expect(html).toContain('Approve');
    expect(html).toContain('Decline');
    // A step can ask about several calls at once, so "Approve" alone would
    // tell a screen-reader user nothing about which one.
    expect(html).toContain('aria-label="Approve shell"');
    expect(html).toContain('aria-label="Decline shell"');
  });

  it('puts the safe answer first in the DOM', () => {
    // The prompt appears mid-reply under a transcript that is still moving.
    // The keyboard's first stop should not be the irreversible one.
    const html = render(
      <ApprovalPrompt approval={shell} botName="Warden" onRespond={() => undefined} />,
    );
    expect(html.indexOf('Decline shell')).toBeLessThan(html.indexOf('Approve shell'));
  });

  it('stays on screen once answered, without live controls', () => {
    const html = render(
      <ApprovalPrompt
        approval={{ ...shell, answered: 'approved' }}
        botName="Warden"
        onRespond={() => undefined}
      />,
    );

    // The turn resumes asynchronously — the tool still has to run and the
    // model still has to answer — so a row that vanished on click would leave
    // the operator unsure whether their answer landed.
    expect(html).toContain('Approval sent to Warden.');
    expect(html).toContain('data-approval-answered="approved"');
    expect(html).not.toContain('aria-label="Approve shell"');
    expect(html).not.toContain('aria-label="Decline shell"');
  });

  it('says so when the answer was no', () => {
    const html = render(
      <ApprovalPrompt
        approval={{ ...shell, answered: 'declined' }}
        botName="Warden"
        onRespond={() => undefined}
      />,
    );
    expect(html).toContain('Left it alone');
    expect(html).toContain('data-approval-answered="declined"');
  });

  it('shows every pending call, not just the first', () => {
    // One step can produce several calls that need approval, and M5-BE-09
    // asks about all of them concurrently: resuming needs every answer, so a
    // question the operator cannot see is a turn that never continues.
    const html = render(
      <ApprovalPromptList
        approvals={[shell, { ...shell, toolCallId: 'tc-2', toolName: 'fs_write' }]}
        botName="Warden"
        onRespond={() => undefined}
      />,
    );
    expect(html).toContain('data-approval-prompt="tc-1"');
    expect(html).toContain('data-approval-prompt="tc-2"');
    expect(html).toContain('fs_write');
  });

  it('puts the whole save_skill script on the face of the card — the card IS the review', () => {
    // save_skill lands APPROVED and run_skill never asks again, so the bytes
    // an operator scrolls here are the bytes that get stored: the tail of a
    // long script must not sit behind a truncated disclosure and still be
    // approved by a click on this card.
    // The probe line avoids angle brackets: JSX text is HTML-escaped in the
    // rendered markup, and this test asserts on what a person sees, not on
    // React's escaping of it.
    const script =
      'export default async function (ctx) {\n' +
      '  // forty lines of procedure the operator has to be able to read\n'.repeat(40) +
      '  await ctx.waitFor(function () { return true; }, 1000);\n' +
      '}\n';
    const html = render(
      <ApprovalPrompt
        approval={{ ...shell, toolName: 'save_skill', args: { name: 'apply_coupon', script } }}
        botName="Warden"
        onRespond={() => undefined}
      />,
    );

    expect(html).toContain('Can I save the skill apply_coupon?');
    expect(html).toContain('data-approval-script');
    // The LAST line — the part any truncation would hide first.
    expect(html).toContain('return true; }, 1000)');
  });

  it('shows no script block for the tools whose args are not code under review', () => {
    const html = render(
      <ApprovalPrompt approval={shell} botName="Warden" onRespond={() => undefined} />,
    );
    expect(html).not.toContain('data-approval-script');
  });

  it('bounds arguments a tool could make enormous', () => {
    const html = render(
      <ApprovalPrompt
        approval={{ ...shell, toolName: 'fs_write', args: { content: 'z'.repeat(200_000) } }}
        botName="Warden"
        onRespond={() => undefined}
      />,
    );
    expect(html.length).toBeLessThan(20_000);
  });

  it('renders a tool that takes no arguments at all', () => {
    const html = render(
      <ApprovalPrompt
        approval={{ ...shell, toolName: 'screenshot', args: {} }}
        botName="Warden"
        onRespond={() => undefined}
      />,
    );
    expect(html).toContain('screenshot');
    expect(html).toContain('aria-label="Approve screenshot"');
  });

  it('displays Workspace root for "." and the relative path for subdirectories in local_code_task', () => {
    const rootHtml = render(
      <ApprovalPrompt
        approval={{
          ...shell,
          toolName: 'local_code_task',
          args: { connectorId: 'c1', goal: 'List files', harness: 'claude-code' },
          binding: {
            ...shell.binding,
            effect: 'commit',
            commit: {
              account: 'crewaid-public',
              destinations: ['c1:.'],
              contentRevision: 'a'.repeat(64),
            },
          },
        }}
        botName="Warden"
        onRespond={() => undefined}
      />,
    );
    expect(rootHtml).toContain('crewaid-public');
    expect(rootHtml).toContain('Workspace root');

    const subHtml = render(
      <ApprovalPrompt
        approval={{
          ...shell,
          toolName: 'local_code_task',
          args: {
            connectorId: 'c1',
            goal: 'Run tests',
            relativeCwd: 'apps/orchestrator',
            harness: 'claude-code',
          },
          binding: {
            ...shell.binding,
            effect: 'commit',
            commit: {
              account: 'crewaid-public',
              destinations: ['c1:apps/orchestrator'],
              contentRevision: 'b'.repeat(64),
            },
          },
        }}
        botName="Warden"
        onRespond={() => undefined}
      />,
    );
    expect(subHtml).toContain('apps/orchestrator');
    expect(subHtml).not.toContain('Workspace root');
  });
});

/**
 * What a press actually sends. Asserted against the shared schemas rather
 * than eyeballed, because a resolution that fails the interrupt's response
 * schema is refused where it is raised: a wrong or missing field is not an
 * error the operator sees, it is a button that does nothing while the turn
 * waits.
 */
describe('the answer a button sends', () => {
  const question: ToolApprovalRequest = {
    proposalId: 'pr-1',
    toolCallId: 'tc-1',
    botId: BOT,
    runId: 'clx1a2b3c4d5e6f7g8h9i0j1',
    definitionName: 'shell',
    toolName: 'shell',
    args: { command: 'rm -rf /home/bot/work' },
    binding: approvalBinding('shell'),
  };

  it('is an answer the interrupt contract accepts', () => {
    const parsed = ToolApprovalAnswerSchema.safeParse({ approved: true });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('carries the answer both ways, and refuses to carry neither', () => {
    expect(ToolApprovalAnswerSchema.safeParse({ approved: true }).success).toBe(true);
    expect(ToolApprovalAnswerSchema.safeParse({ approved: false }).success).toBe(true);
    // A press that resolved the question with no answer in it would release
    // the turn without saying what to do — the one outcome worse than a hang.
    expect(ToolApprovalAnswerSchema.safeParse({}).success).toBe(false);
  });

  it('names the tool call on the question, and carries no id on the answer', () => {
    // The QUESTION is keyed on `toolCallId` — the prompt is rendered and
    // reported against it — and the ANSWER needs no key at all, because it
    // resolves the interrupt that asked. Either way `approvalId` never leaves
    // the orchestrator (M5-BE-09), so an answer that named one would be
    // answering a question nothing is keyed on.
    expect(ToolApprovalRequestSchema.safeParse(question).success).toBe(true);
    const { toolCallId: _dropped, ...unkeyed } = question;
    expect(ToolApprovalRequestSchema.safeParse(unkeyed).success).toBe(false);
    expect(ToolApprovalRequestSchema.safeParse({ ...question, approvalId: 'ap-1' }).success).toBe(
      false,
    );

    expect(ToolApprovalAnswerSchema.safeParse({ approved: true, approvalId: 'ap-1' }).success).toBe(
      false,
    );
    expect(ToolApprovalAnswerSchema.safeParse({ approved: true, toolCallId: 'tc-1' }).success).toBe(
      false,
    );
  });
});

/**
 * The last mile: the prompt has to reach the surface an operator is looking
 * at. Every other case here can pass while `Transcript` renders none of them,
 * which is the state this task started from.
 */
describe('the transcript shows a pending approval', () => {
  const bot: Bot = {
    id: BOT,
    userId: 'usr_crewaid_singleton_v1',
    name: 'Warden',
    role: 'Pipeline',
    avatarColor: '#8B6F47',
    systemPrompt: '',
    modelId: 'default',
    status: 'IDLE',
    autoReviewRules: [],
    hiddenFromSidebar: false,
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    updatedAt: new Date('2026-09-01T12:00:00.000Z'),
  };

  function transcript(approvals?: readonly PendingApproval[]): string {
    return renderToStaticMarkup(
      <I18nProvider>
        <Transcript
          bot={bot}
          connection={{ status: 'connected', attempt: 0, retryDelayMs: null }}
          messages={[]}
          pending={[]}
          approvals={approvals}
          onApprovalRespond={() => undefined}
          onSend={() => undefined}
          onStop={() => undefined}
          onFiles={() => undefined}
          onRemovePending={() => undefined}
          onRetryPending={() => undefined}
        />
      </I18nProvider>,
    );
  }

  it('renders the prompt inline, named for the bot that asked', () => {
    const html = transcript([shell]);
    expect(html).toContain('data-approval-prompt="tc-1"');
    expect(html).toContain('Warden');
    expect(html).toContain('aria-label="Approve shell"');
  });

  it('shows nothing when nothing is waiting', () => {
    expect(transcript()).not.toContain('data-approval-prompt');
    expect(transcript([])).not.toContain('data-approval-prompt');
  });
});
