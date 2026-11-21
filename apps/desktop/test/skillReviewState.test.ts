import { describe, expect, it } from 'vitest';
import type { Skill } from '@crewaid/shared';
import {
  approvedNotice,
  draftChanged,
  draftFromSkill,
  draftIssue,
  instructionIssue,
  revisedNotice,
  reviseFailureMessage,
  savedNotice,
  skillFailureMessage,
  skillParams,
  skillReviewPresentation,
  toUpdateBody,
} from '../src/renderer/skills/skillReviewState';

/**
 * The review surface's decisions (M3-FE-02, D-098), asserted where they are
 * made.
 *
 * The modal itself mounts into a portal `renderToStaticMarkup` has nowhere to
 * put, so every rule an operator could be surprised by — what a save sends,
 * when approve is offered, what a failure says — is a pure function first.
 */

const skill: Skill = {
  id: 'skl_review_01',
  botId: 'bot_review_01',
  name: 'open_example_site',
  description: 'Opens example.com and screenshots it.',
  steps: ['Open Chrome.', 'Go to example.com.'],
  paramsSchema: { type: 'object', properties: {} },
  script: 'export default async function run() {}',
  version: 1,
  status: 'DRAFT',
  sourceRecordingId: null,
  createdAt: new Date('2026-09-10T12:00:00.000Z'),
};

describe('skill draft (M3-FE-02)', () => {
  it('seeds from the stored skill', () => {
    expect(draftFromSkill(skill)).toEqual({
      description: skill.description,
      script: skill.script,
    });
  });

  it('refuses an empty script before the server would', () => {
    expect(draftIssue(draftFromSkill(skill))).toBeNull();
    expect(draftIssue({ description: 'x', script: '   \n ' })).toBe('The script cannot be empty.');
  });

  it('knows when the draft differs from the stored skill', () => {
    const clean = draftFromSkill(skill);
    expect(draftChanged(clean, skill)).toBe(false);
    expect(draftChanged({ ...clean, script: 'export default async () => 1;' }, skill)).toBe(true);
    expect(draftChanged({ ...clean, description: 'Better words.' }, skill)).toBe(true);
  });

  it('sends only the changed fields, and nothing when nothing changed', () => {
    const clean = draftFromSkill(skill);
    // An empty PATCH body is refused by the contract, and a full overwrite
    // would lose a concurrent edit the operator never touched.
    expect(toUpdateBody(clean, skill)).toBeNull();
    expect(toUpdateBody({ ...clean, script: 'export default async () => 2;' }, skill)).toEqual({
      script: 'export default async () => 2;',
    });
    expect(toUpdateBody({ ...clean, description: 'New words.' }, skill)).toEqual({
      description: 'New words.',
    });
    expect(
      toUpdateBody({ description: 'New words.', script: 'export default async () => 3;' }, skill),
    ).toEqual({ description: 'New words.', script: 'export default async () => 3;' });
  });

  it('never sends paramsSchema — this surface does not edit it', () => {
    const body = toUpdateBody(
      { ...draftFromSkill(skill), script: 'export default () => {};' },
      skill,
    );
    expect(body).not.toBeNull();
    expect(Object.keys(body ?? {})).toEqual(['script']);
  });
});

describe('skill review presentation (M3-FE-02)', () => {
  it('says a draft cannot run, and offers both the edit and the approval', () => {
    const view = skillReviewPresentation(skill);
    expect(view.statusLabel).toBe('Draft');
    expect(view.statusTone).toBe('warning');
    expect(view.statusNote).toMatch(/cannot run until it is approved/);
    expect(view.versionLabel).toBe('v1');
    expect(view.canEdit).toBe(true);
    expect(view.canApprove).toBe(true);
  });

  it('says an approved skill can run, with nothing left to approve', () => {
    const view = skillReviewPresentation({ ...skill, status: 'APPROVED', version: 2 });
    expect(view.statusLabel).toBe('Approved');
    expect(view.statusTone).toBe('success');
    expect(view.statusNote).toMatch(/can run/);
    expect(view.versionLabel).toBe('v2');
    expect(view.canApprove).toBe(false);
    expect(view.canEdit).toBe(true);
  });

  it('offers an archived skill the one gesture it has — an edit that re-drafts it', () => {
    // The contract's PATCH table allows a write on any status: saving an
    // archived row lands as a new DRAFT version, and that is the only way
    // back — an archived skill can be neither run nor approved (409).
    const view = skillReviewPresentation({ ...skill, status: 'ARCHIVED' });
    expect(view.statusLabel).toBe('Archived');
    expect(view.statusNote).toMatch(/new draft version/);
    expect(view.canEdit).toBe(true);
    expect(view.canApprove).toBe(false);
  });

  it('names the version a write produced, never a predicted one', () => {
    expect(savedNotice({ ...skill, version: 2 })).toBe('Saved as v2.');
    expect(approvedNotice()).toBe('Skill approved.');
  });
});

describe('skill failure copy (M3-FE-02)', () => {
  it('maps the codes an operator can act on', () => {
    expect(skillFailureMessage({ code: 'NETWORK', message: 'x' })).toMatch(/could not be reached/);
    expect(skillFailureMessage({ code: 'CONFIGURATION', message: 'x' })).toMatch(/Settings/);
    expect(skillFailureMessage({ code: 'UNAUTHORIZED', message: 'x' })).toMatch(/Sign in again/);
    expect(skillFailureMessage({ code: 'NOT_FOUND', message: 'Not found.' })).toBe(
      'This skill no longer exists.',
    );
    expect(skillFailureMessage({ code: 'CONFLICT', message: 'x' })).toMatch(
      /changed on the server/,
    );
    expect(skillFailureMessage({ code: 'CONTRACT', message: 'x' })).toMatch(/Updating the app/);
  });

  it('falls back to the normalized message for everything else', () => {
    expect(
      skillFailureMessage({ code: 'UNKNOWN', message: 'Something went wrong. Try again.' }),
    ).toBe('Something went wrong. Try again.');
  });
});

describe('the plain-language change (D-098)', () => {
  it('refuses empty and overlong instructions', () => {
    expect(instructionIssue('')).toBe('Say what should change.');
    // Whitespace is not an instruction; `ReviseSkillBodySchema` trims before it
    // measures, so the button and the server agree on what is empty.
    expect(instructionIssue('   ')).toBe('Say what should change.');
    expect(instructionIssue('Use Firefox.')).toBeNull();
    expect(instructionIssue('x'.repeat(2001))).toBe('Keep the change under 2,000 characters.');
  });

  it('names the version a revise produced', () => {
    expect(revisedNotice({ ...skill, version: 3 })).toBe('Updated as v3.');
  });

  it('says a refused change is about the CHANGE, with a way forward', () => {
    // The server answers a refused revise with 400 and a sentence for this
    // surface, but the transport does not forward bodies — so the copy here is
    // all the operator gets, and it names both ways on.
    expect(reviseFailureMessage({ code: 'INVALID_REQUEST', message: 'x' })).toMatch(
      /wording it differently/,
    );
    expect(reviseFailureMessage({ code: 'UNKNOWN', message: 'x' })).toMatch(
      /edit the source directly/,
    );
    // Everything else keeps the mapping that already says the right thing.
    expect(reviseFailureMessage({ code: 'NETWORK', message: 'x' })).toBe(
      skillFailureMessage({ code: 'NETWORK', message: 'x' }),
    );
  });
});

describe('skillParams (D-098)', () => {
  it('reads name, type, description and required out of the schema', () => {
    const params = skillParams({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        limit: { type: 'integer', description: '' },
      },
      required: ['query'],
    });
    expect(params).toEqual([
      { name: 'query', type: 'string', description: 'What to search for.', required: true },
      { name: 'limit', type: 'integer', description: '', required: false },
    ]);
  });

  it('survives a column it did not author', () => {
    // The wire type is the loose `JsonSchemaObjectSchema`, and `save_skill` can
    // write any object: a malformed entry costs that row's detail, not the panel.
    expect(skillParams({})).toEqual([]);
    expect(skillParams(null)).toEqual([]);
    expect(skillParams('nope')).toEqual([]);
    expect(skillParams({ properties: [] })).toEqual([]);
    expect(skillParams({ properties: { q: 'not-an-object' } })).toEqual([
      { name: 'q', type: null, description: null, required: false },
    ]);
    // `required` may be absent or hold non-strings; neither invents a mark.
    expect(skillParams({ properties: { q: { type: 'string' } }, required: [7] })).toEqual([
      { name: 'q', type: 'string', description: null, required: false },
    ]);
  });
});
