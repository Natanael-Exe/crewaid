import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { Skill } from '@crewaid/shared';
import { SkillReviewBody } from '../src/renderer/skills/SkillReviewBody';
import {
  draftFromSkill,
  type SkillDraft,
  type SkillReviewLoad,
} from '../src/renderer/skills/skillReviewState';

/**
 * The review surface's visible half (M3-FE-02, D-098).
 *
 * Asserted through `renderToStaticMarkup` on the body rather than through the
 * modal: React Aria mounts the dialog into a portal the suite has nowhere to
 * put, so a test driven through the modal would assert against an empty string
 * and pass whatever the body contained (the same reason `BotFields` is its own
 * module).
 */

const skill: Skill = {
  id: 'skl_review_01',
  botId: 'bot_review_01',
  name: 'open_example_site',
  description: 'Opens example.com and screenshots it.',
  paramsSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  steps: ['Open Chrome.', 'Go to example.com.', 'Take a screenshot.'],
  script: 'export default async function run(ctx) { await ctx.click(10, 20); }',
  version: 1,
  status: 'DRAFT',
  sourceRecordingId: null,
  createdAt: new Date('2026-09-10T12:00:00.000Z'),
};

const CLEAN_DRAFT: SkillDraft = draftFromSkill(skill);

function render(overrides: Partial<Parameters<typeof SkillReviewBody>[0]> = {}): string {
  const load: SkillReviewLoad = { status: 'ready', skill };
  return renderToStaticMarkup(
    <I18nProvider>
      <SkillReviewBody
        load={load}
        mode="view"
        draft={CLEAN_DRAFT}
        instruction=""
        busy={null}
        notice={null}
        failure={null}
        onEdit={() => undefined}
        onCancelEdit={() => undefined}
        onDraftChange={() => undefined}
        onInstructionChange={() => undefined}
        onSave={() => undefined}
        onRevise={() => undefined}
        onApprove={() => undefined}
        onRetry={() => undefined}
        onClose={() => undefined}
        {...overrides}
      />
    </I18nProvider>,
  );
}

/** The opening tag of one action button, whatever attribute order it renders in. */
function actionTag(html: string, action: string): string {
  return html.match(new RegExp(`<button[^>]*data-skill-action="${action}"[^>]*>`))?.[0] ?? '';
}

describe('SkillReviewBody — loading and failure (M3-FE-02)', () => {
  it('says it is loading, with the close affordance already there', () => {
    const html = render({ load: { status: 'loading' }, draft: null });
    expect(html).toContain('data-skill-review="loading"');
    expect(html).toContain('Loading skill…');
    expect(actionTag(html, 'close')).not.toBe('');
  });

  it('normalizes a failed read and offers exactly one retry', () => {
    const html = render({
      load: {
        status: 'error',
        failure: { code: 'NETWORK', message: 'Could not reach the server.' },
      },
      draft: null,
    });
    expect(html).toContain('data-skill-review="error"');
    expect(html).toContain('The server could not be reached. Check your connection and try again.');
    expect(html).not.toContain('Could not reach the server.');
    expect(actionTag(html, 'retry')).not.toBe('');
    expect(actionTag(html, 'approve')).toBe('');
  });
});

describe('SkillReviewBody — viewing a draft (M3-FE-02, D-098)', () => {
  it('opens on what the skill does: identity, standing, summary and parameters', () => {
    const html = render();
    expect(html).toContain('data-skill-review="ready"');
    expect(html).toContain('open_example_site');
    expect(html).toContain('data-skill-status="DRAFT"');
    expect(html).toContain('Draft');
    expect(html).toContain('data-skill-version="1"');
    expect(html).toContain('v1');
    expect(html).toContain('This draft cannot run until it is approved.');

    // D-098: the compiler's summary is the default view of what this skill is.
    expect(html).toContain('data-skill-steps');
    expect(html).toContain('Open Chrome.');
    expect(html).toContain('Take a screenshot.');

    // The parameters read as the form they are, not as JSON Schema.
    expect(html).toContain('data-skill-parameters');
    expect(html).toContain('url');
    expect(html).toContain('string');
  });

  it('keeps the source and the raw schema, behind the developer view', () => {
    const html = render();
    // The disclosure is the only place the machine halves render now; they
    // stay in the document when it is closed, which is what lets this suite
    // hold the content without a click.
    expect(html).toContain('data-skill-developer');
    expect(html).toContain('Developer view');
    expect(html).toContain('data-skill-source');
    expect(html).toContain('ctx.click(10, 20)');
    expect(html).toContain('data-skill-params');
    expect(html).toContain('&quot;url&quot;');
    // ...and the raw source is NOT the thing the surface opens on: the summary
    // reaches the document before it.
    expect(html.indexOf('data-skill-steps')).toBeLessThan(html.indexOf('data-skill-source'));
  });

  it('offers Edit and Approve on a draft — and a save button is nowhere yet', () => {
    const html = render();
    expect(actionTag(html, 'edit')).not.toBe('');
    expect(actionTag(html, 'approve')).not.toBe('');
    expect(actionTag(html, 'save')).toBe('');
    expect(actionTag(html, 'revise')).toBe('');
  });

  it('keeps an approved skill editable but not approvable', () => {
    const html = render({
      load: { status: 'ready', skill: { ...skill, status: 'APPROVED', version: 2 } },
    });
    expect(html).toContain('data-skill-status="APPROVED"');
    expect(html).toContain('Approved — this skill can run.');
    expect(html).toContain('v2');
    expect(actionTag(html, 'edit')).not.toBe('');
    expect(actionTag(html, 'approve')).toBe('');
  });

  it('offers an archived skill an edit — the save re-drafts it — and no approval', () => {
    const html = render({ load: { status: 'ready', skill: { ...skill, status: 'ARCHIVED' } } });
    expect(html).toContain('data-skill-status="ARCHIVED"');
    expect(html).toContain('Archived skills cannot run. Editing saves a new draft version.');
    expect(actionTag(html, 'edit')).not.toBe('');
    expect(actionTag(html, 'approve')).toBe('');
  });

  it('says so when the skill has no description, no summary and no parameters', () => {
    const html = render({
      load: {
        status: 'ready',
        skill: { ...skill, description: '', steps: [], paramsSchema: {} },
      },
    });
    expect(html).toContain('No description.');
    // Three different silences, and the sentences must not blur them: a skill
    // the bot authored had no trace to summarize (D-098), which is not the
    // same fact as a task that takes no arguments.
    expect(html).toContain('No step summary for this skill.');
    expect(html).toContain('No parameters.');
  });
});

describe('SkillReviewBody — editing (M3-FE-02, D-098)', () => {
  const edited: SkillDraft = { ...CLEAN_DRAFT, script: 'export default async () => 42;' };

  it('offers the plain-language change as the primary, and the raw fields as the developer path', () => {
    const html = render({ mode: 'edit', draft: edited });
    expect(html).toContain('data-skill-instruction');
    expect(html).toContain('What should change?');
    // The primary is the AI path, and the raw editor is inside the same
    // disclosure the source lives in.
    expect(actionTag(html, 'revise')).not.toBe('');
    expect(html).toContain('data-skill-script-editor');
    expect(html).toContain('data-skill-description-editor');
    expect(actionTag(html, 'cancel')).not.toBe('');
    expect(actionTag(html, 'save')).not.toBe('');
    expect(actionTag(html, 'edit')).toBe('');
    expect(actionTag(html, 'approve')).toBe('');
  });

  it('keeps the AI update disabled until there is something to say', () => {
    const empty = render({ mode: 'edit', draft: CLEAN_DRAFT });
    expect(actionTag(empty, 'revise')).toContain('disabled');

    const instructed = render({
      mode: 'edit',
      draft: CLEAN_DRAFT,
      instruction: 'Use Firefox instead of Chrome.',
    });
    expect(actionTag(instructed, 'revise')).not.toContain('disabled');

    // Whitespace is not an instruction.
    const blank = render({ mode: 'edit', draft: CLEAN_DRAFT, instruction: '   ' });
    expect(actionTag(blank, 'revise')).toContain('disabled');

    const overlong = render({ mode: 'edit', draft: CLEAN_DRAFT, instruction: 'x'.repeat(2001) });
    expect(overlong).toContain('maxLength="2000"');
    expect(overlong).toContain('Keep the change under 2,000 characters.');
    expect(actionTag(overlong, 'revise')).toContain('disabled');
  });

  it('cannot close or cancel while a write is being adopted', () => {
    const html = render({ mode: 'edit', draft: CLEAN_DRAFT, busy: 'revising' });
    expect(actionTag(html, 'close')).toContain('disabled');
    expect(actionTag(html, 'cancel')).toContain('disabled');
  });

  it('keeps the raw save disabled until something actually changed', () => {
    const unchanged = render({ mode: 'edit', draft: CLEAN_DRAFT });
    expect(actionTag(unchanged, 'save')).toContain('disabled');

    const changed = render({ mode: 'edit', draft: edited });
    expect(actionTag(changed, 'save')).not.toContain('disabled');
  });

  it('refuses an empty script in the editor and says why', () => {
    const html = render({ mode: 'edit', draft: { ...CLEAN_DRAFT, script: '   ' } });
    expect(html).toContain('The script cannot be empty.');
    expect(actionTag(html, 'save')).toContain('disabled');
  });

  it('keeps the editor mounted while a save is out', () => {
    const html = render({ mode: 'edit', draft: edited, busy: 'saving' });
    expect(html).toContain('Saving…');
    expect(actionTag(html, 'save')).toContain('disabled');
    expect(actionTag(html, 'cancel')).toContain('disabled');
    expect(actionTag(html, 'close')).toContain('disabled');
  });

  it('shows the AI update running, with the write presses locked until it lands', () => {
    const html = render({
      mode: 'edit',
      draft: CLEAN_DRAFT,
      instruction: 'Use Firefox instead of Chrome.',
      busy: 'revising',
    });
    expect(html).toContain('Updating…');
    expect(actionTag(html, 'revise')).toContain('disabled');
    expect(actionTag(html, 'save')).toContain('disabled');
    expect(actionTag(html, 'cancel')).toContain('disabled');
    expect(actionTag(html, 'close')).toContain('disabled');
  });

  it('locks the approval while one is out', () => {
    const html = render({ busy: 'approving' });
    expect(html).toContain('Approving…');
    expect(actionTag(html, 'approve')).toContain('disabled');
  });
});

describe('SkillReviewBody — outcome lines (M3-FE-02)', () => {
  it('carries the saved-version notice the caller computed', () => {
    const html = render({ notice: 'Saved as v2.' });
    expect(html).toContain('Saved as v2.');
    expect(html).toContain('role="status"');
  });

  it('carries a compressed revise failure, never a raw body', () => {
    const html = render({
      failure:
        'The compiler could not apply that change. Try wording it differently, or edit the source directly.',
    });
    expect(html).toContain('The compiler could not apply that change.');
    expect(html).toContain('role="alert"');
  });

  it('carries a normalized failure, never a raw body', () => {
    const html = render({ failure: 'The orchestrator refused these values.' });
    expect(html).toContain('The orchestrator refused these values.');
    expect(html).toContain('role="alert"');
  });
});
