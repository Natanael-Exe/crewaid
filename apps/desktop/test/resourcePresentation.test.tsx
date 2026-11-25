import { approvalBinding } from './approvalBinding';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  resourcePreview,
  safeResourceUrl,
} from '../src/renderer/components/tools/resourcePresentation';
import { ToolCallPart, ToolActivityPart } from '../src/renderer/components/tools/ToolCallPart';
import { ApprovalPrompt } from '../src/renderer/components/tools/ApprovalPrompt';
import { hasVisibleTranscriptContent } from '../src/renderer/state/transcriptRows';
import type { PendingApproval } from '../src/renderer/state/chatReducer';

const input = {
  recipient_email: 'Alex <alex@example.test>',
  subject: 'Hosting proposal',
  body: '<img src="https://evil.example/track">Hello Alex',
  is_html: true,
};
describe('resource previews', () => {
  it('distinguishes a preview, a saved draft and sending, without optimistic receipts', () => {
    expect(
      resourcePreview('preview_email', { ...input, to: input.recipient_email }, 'shown', 'ok')
        ?.receipt,
    ).toBe('Preview only · Not saved or sent');
    expect(
      resourcePreview('gmail__GMAIL_CREATE_EMAIL_DRAFT', input, { draft_id: 'draft-1' }, 'ok')
        ?.receipt,
    ).toBe('Draft saved · Not sent');
    expect(
      resourcePreview('gmail__GMAIL_SEND_EMAIL', input, { id: 'email-1' }, 'ok')?.receipt,
    ).toBe('Email sent');
    for (const status of ['running', 'error', 'denied', 'incomplete', 'awaiting-approval'] as const)
      expect(
        resourcePreview('gmail__GMAIL_SEND_EMAIL', input, undefined, status)?.receipt,
      ).toBeUndefined();
    expect(resourcePreview('gmail__GMAIL_CREATE_LABEL', input, {}, 'ok')).toBeUndefined();
    // Reads are routine work (D-215): an email a bot fetched is not a card.
    for (const name of [
      'gmail__GMAIL_GET_DRAFT',
      'gmail__GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
      'docs__GOOGLEDOCS_GET_DOCUMENT_BY_ID',
    ])
      expect(resourcePreview(name, { id: 'x' }, { subject: 'Read' }, 'ok')).toBeUndefined();
  });
  it('renders email source as inert text and retains the captured draft in an approval', () => {
    const approval: PendingApproval = {
      toolCallId: 'send-1',
      toolName: 'gmail__GMAIL_SEND_EMAIL',
      args: input,
      binding: approvalBinding('gmail__GMAIL_SEND_EMAIL'),
      turnId: 'turn-1',
    };
    const html = renderToStaticMarkup(
      <ApprovalPrompt approval={approval} botName="Quill" onRespond={() => undefined} />,
    );
    expect(html).toContain('data-resource-preview="email"');
    expect(html).toContain('Hosting proposal');
    expect(html).toContain('&lt;img');
    // The row's own mark is a bundled data URI; nothing may load from a host.
    expect(html).not.toMatch(/<img src="(?!data:)/);
    expect(html).not.toContain('Email sent');
    expect(html).toContain('Approve gmail__GMAIL_SEND_EMAIL');
  });
  it('does not open arbitrary output links or a location from a failed create', () => {
    for (const url of [
      'javascript:alert(1)',
      'https://evil.example/a',
      'https://docs.google.com.evil.example/document/d/a',
      'https://evil@docs.google.com/document/d/a',
      'https://docs.google.com/spreadsheets/d/a',
    ])
      expect(safeResourceUrl(url, 'document')).toBeUndefined();
    expect(safeResourceUrl('https://docs.google.com/document/d/a/edit', 'document')).toBe(
      'https://docs.google.com/document/d/a/edit',
    );
    expect(
      resourcePreview(
        'docs__GOOGLEDOCS_CREATE_DOCUMENT',
        { title: 'Notes' },
        { documentUrl: 'https://docs.google.com/document/d/a/edit' },
        'error',
      )?.url,
    ).toBeUndefined();
  });
  it('leaves unknown or malformed provider responses available in bounded details', () => {
    const html = renderToStaticMarkup(
      <ToolCallPart
        part={{
          type: 'tool-call',
          toolCallId: 'x',
          toolName: 'app__unknown',
          input: {},
          status: 'ok',
          output: '{partial',
        }}
      />,
    );
    expect(html).toContain('{partial');
    expect(html).toContain('data-slot="disclosure"');
    expect(html).toContain('aria-expanded="false"');
  });
  it('keeps useful outputs visible with routine work hidden and omits routine rows', () => {
    const part = {
      type: 'tool-activity',
      calls: [
        {
          type: 'tool-call',
          toolCallId: 'p',
          toolName: 'preview_email',
          input: { to: 'Alex', subject: 'Proposal', body: 'Hello' },
          status: 'ok',
          output: 'shown',
        },
        {
          type: 'tool-call',
          toolCallId: 'b',
          toolName: 'browser_read',
          input: {},
          status: 'ok',
          output: 'page',
        },
        {
          type: 'tool-call',
          toolCallId: 'r',
          toolName: 'gmail__GMAIL_FETCH_EMAILS',
          input: {},
          status: 'ok',
          output: '{}',
        },
      ],
    };
    expect(
      hasVisibleTranscriptContent(
        { id: 'x', author: 'BOT', parts: [part], timeLabel: '', stopReason: null },
        false,
      ),
    ).toBe(true);
    const html = renderToStaticMarkup(
      <ToolActivityPart part={part} context={{ showWork: false }} />,
    );
    expect(html).toContain('Proposal');
    expect(html).toContain('data-tool-card="email"');
    expect(html).not.toContain('browser_read');
    expect(html).not.toContain('GMAIL_FETCH_EMAILS');
  });

  it('renders a retried action once, with a count badge and the final outcome', () => {
    // The retry differs in the body — the wording a schema refusal provoked —
    // but the artifact is the same email to the same recipient, and one card
    // is what the operator reads (D-215).
    const part = {
      type: 'tool-activity',
      calls: [0, 1].map((attempt) => ({
        type: 'tool-call',
        toolCallId: `draft-${attempt}`,
        toolName: 'gmail__GMAIL_CREATE_EMAIL_DRAFT',
        input: {
          to: 'Alex <alex@example.test>',
          subject: 'Hosting proposal',
          body: attempt === 0 ? 'Hello Alex' : 'Hi Alex, hello again',
        },
        status: 'ok',
        output: { draft_id: `draft-${attempt}` },
      })),
    };
    const html = renderToStaticMarkup(
      <ToolActivityPart part={part} context={{ showWork: false }} />,
    );
    expect(html).toContain('Hosting proposal');
    expect(html.match(/data-tool-card="email"/g)).toHaveLength(1);
    expect(html).toContain('×2');
    // The last run's outcome is the artifact's final state.
    expect(html).toContain('draft-1');
    expect(html).not.toContain('draft-0');
  });
});
