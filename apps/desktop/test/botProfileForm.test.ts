import { describe, expect, it } from 'vitest';
import {
  AVATAR_COLORS,
  draftChanged,
  draftFromBot,
  draftIssue,
  NEW_BOT_DRAFT,
  toCreateBody,
  toUpdateBody,
  writeFailureMessage,
  type BotDraft,
} from '../src/renderer/bots/botProfileForm';

const stored: BotDraft = {
  name: 'Quill',
  role: 'Outbound Writer',
  systemPrompt: 'You are an outbound writer.',
  avatarColor: '#8d6e4e',
  avatarShape: null,
};

function draft(overrides: Partial<BotDraft> = {}): BotDraft {
  return { ...stored, ...overrides };
}

describe('draftIssue', () => {
  it('accepts a filled draft', () => {
    expect(draftIssue(stored)).toBeNull();
  });

  it('requires a name, including one that is only whitespace', () => {
    expect(draftIssue(draft({ name: '' }))).toBe('Name is required.');
    expect(draftIssue(draft({ name: '   ' }))).toBe('Name is required.');
  });

  /**
   * `role` is required by CreateBotBodySchema. The reference app labels the
   * same field "(optional)", so this is the one place the UI must diverge from
   * it — copying the label would move a validation error from the form to the
   * server, after the operator pressed Create.
   */
  it('requires a label, because the column is not nullable', () => {
    expect(draftIssue(draft({ role: '' }))).toBe('Label is required.');
  });

  it('accepts an empty description — a bot with no system prompt is legal', () => {
    expect(draftIssue(draft({ systemPrompt: '' }))).toBeNull();
  });

  it('enforces the contract lengths before the server has to', () => {
    expect(draftIssue(draft({ name: 'x'.repeat(65) }))).toContain('64');
    expect(draftIssue(draft({ role: 'x'.repeat(129) }))).toContain('128');
  });

  it('rejects a colour that is not #RRGGBB', () => {
    expect(draftIssue(draft({ avatarColor: 'red' }))).toBe('Pick an avatar colour.');
    expect(draftIssue(draft({ avatarColor: '#abc' }))).toBe('Pick an avatar colour.');
  });

  it('ships a valid default draft, so "+" opens a form that only needs names', () => {
    expect(draftIssue({ ...NEW_BOT_DRAFT, name: 'a', role: 'b' })).toBeNull();
    expect(AVATAR_COLORS).toContain(NEW_BOT_DRAFT.avatarColor);
  });
});

describe('draftChanged', () => {
  it('is false for an untouched draft', () => {
    expect(draftChanged(stored, stored)).toBe(false);
  });

  it('ignores whitespace the save would trim anyway', () => {
    // Otherwise Save enables on a trailing space and then PATCHes nothing.
    expect(draftChanged(draft({ name: 'Quill  ' }), stored)).toBe(false);
  });

  it('notices each field', () => {
    expect(draftChanged(draft({ name: 'Nib' }), stored)).toBe(true);
    expect(draftChanged(draft({ role: 'Editor' }), stored)).toBe(true);
    expect(draftChanged(draft({ systemPrompt: 'new' }), stored)).toBe(true);
    expect(draftChanged(draft({ avatarColor: '#4c6ef5' }), stored)).toBe(true);
    expect(draftChanged(draft({ avatarShape: 'cloud' }), stored)).toBe(true);
  });
});

describe('toUpdateBody', () => {
  /**
   * A full-overwrite PATCH would clobber a field another window changed while
   * this form sat open, even one the operator never typed in.
   */
  it('sends only what changed', () => {
    expect(toUpdateBody(draft({ name: 'Nib' }), stored)).toEqual({ name: 'Nib' });
  });

  it('trims what it sends', () => {
    expect(toUpdateBody(draft({ name: '  Nib  ' }), stored)).toEqual({ name: 'Nib' });
  });

  it('preserves the description verbatim — leading space in a prompt is content', () => {
    const body = toUpdateBody(draft({ systemPrompt: '  keep me  ' }), stored);
    expect(body).toEqual({ systemPrompt: '  keep me  ' });
  });

  it('is empty when nothing changed, which is what the Save guard relies on', () => {
    expect(toUpdateBody(stored, stored)).toEqual({});
  });

  it('sends a chosen mascot shape', () => {
    expect(toUpdateBody(draft({ avatarShape: 'cloud' }), stored)).toEqual({ avatarShape: 'cloud' });
  });

  /**
   * `UpdateBotBody.avatarShape` has no null, so "back to derived" is not
   * expressible over §4.1. Sending `null` anyway would be rejected by the
   * body schema — a save that fails for a field the operator cannot see.
   */
  it('omits a cleared shape rather than sending a null the contract refuses', () => {
    const chosen = { ...stored, avatarShape: 'cloud' } as const;
    expect(toUpdateBody({ ...chosen, avatarShape: null }, chosen)).toEqual({});
  });
});

describe('toCreateBody', () => {
  it('carries the required fields, trimmed where the server trims', () => {
    expect(toCreateBody(draft({ name: ' Quill ', role: ' Writer ' }))).toEqual({
      name: 'Quill',
      role: 'Writer',
      systemPrompt: stored.systemPrompt,
      avatarColor: stored.avatarColor,
    });
  });

  /**
   * Omitted, not null: a bot created without a pick keeps the name-derived
   * mascot, so its avatar follows a later rename instead of freezing at
   * whatever the name happened to be on the day it was made.
   */
  it('omits the shape when none was picked, and includes it when one was', () => {
    expect(toCreateBody(draft())).not.toHaveProperty('avatarShape');
    expect(toCreateBody(draft({ avatarShape: 'shield' }))).toMatchObject({
      avatarShape: 'shield',
    });
  });
});

describe('draftFromBot', () => {
  it('takes only the editable columns', () => {
    expect(draftFromBot({ ...stored, name: 'Quill', role: 'Outbound Writer' })).toEqual(stored);
  });
});

describe('writeFailureMessage', () => {
  it('tells the operator where to fix a configuration problem', () => {
    expect(writeFailureMessage({ code: 'UNAUTHORIZED', message: 'x' })).toContain('Settings');
    expect(writeFailureMessage({ code: 'CONFIGURATION', message: 'x' })).toContain('Settings');
  });

  it('reads a 404 as a deletion, which is what it means for a single user', () => {
    expect(writeFailureMessage({ code: 'NOT_FOUND', message: 'x' })).toContain('no longer exists');
  });

  it('falls back to the normalized message rather than inventing copy', () => {
    expect(writeFailureMessage({ code: 'UNKNOWN', message: 'Something went wrong.' })).toBe(
      'Something went wrong.',
    );
  });
});
