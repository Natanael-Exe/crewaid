import { describe, expect, it } from 'vitest';
import { shouldSubmitOnEnter } from '../src/renderer/components/composer/autoGrow';
import {
  botSwitched,
  canSend,
  completed,
  draftChanged,
  send,
  stop,
  type ComposerState,
} from '../src/renderer/components/composer/composerState';

/**
 * M1-FE-07 unit tests — the composer state machine and the IME-safe Enter
 * predicate. Pure functions, no React rendering required.
 */

describe('shouldSubmitOnEnter', () => {
  it('submits on plain Enter', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false })).toBe(true);
  });

  it('does NOT submit on Shift+Enter (newline)', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: true })).toBe(false);
  });

  it('does NOT submit on other keys', () => {
    expect(shouldSubmitOnEnter({ key: 'a', shiftKey: false })).toBe(false);
  });

  it('does NOT submit while an IME composition is in flight (isComposing)', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
  });

  it('does NOT submit on Chromium keyCode 229 (IME confirm)', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBe(false);
  });

  it('submits a normal Enter that carries keyCode 229 leftovers? No — never', () => {
    // 229 means the event belongs to the IME; it must never submit.
    expect(
      shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, keyCode: 229, isComposing: false }),
    ).toBe(false);
  });
});

describe('composer state machine', () => {
  const idleEmpty: ComposerState = { mode: 'idle', draft: '' };
  const idleText: ComposerState = { mode: 'idle', draft: 'hello' };
  const active: ComposerState = { mode: 'active', draft: '' };

  it('canSend only when idle with non-whitespace draft', () => {
    expect(canSend(idleText)).toBe(true);
    expect(canSend(idleEmpty)).toBe(false);
    expect(canSend({ mode: 'idle', draft: '   ' })).toBe(false);
    expect(canSend(active)).toBe(false);
  });

  it('send transitions idle→active, clears the draft, and consumes the text', () => {
    const next = send(idleText);
    expect(next).toEqual({ mode: 'active', draft: '' });
  });

  it('send is null when the draft is empty or mode is active', () => {
    expect(send(idleEmpty)).toBeNull();
    expect(send(active)).toBeNull();
  });

  it('stop returns to idle from active', () => {
    expect(stop(active)).toEqual({ mode: 'idle', draft: '' });
  });

  it('stop is a no-op when already idle', () => {
    expect(stop(idleText)).toBe(idleText);
  });

  it('completed mirrors stop for self-finished turns', () => {
    expect(completed(active)).toEqual({ mode: 'idle', draft: '' });
    expect(completed(idleText)).toBe(idleText);
  });

  it('draftChanged preserves mode', () => {
    expect(draftChanged(idleEmpty, 'abc')).toEqual({ mode: 'idle', draft: 'abc' });
    expect(draftChanged(active, 'x')).toEqual({ mode: 'active', draft: 'x' });
  });

  it('botSwitched syncs mode with the incoming bot generation state', () => {
    expect(botSwitched(idleEmpty, true)).toEqual({ mode: 'active', draft: '' });
    expect(botSwitched(active, false)).toEqual({ mode: 'idle', draft: '' });
    expect(botSwitched(idleText, false)).toBe(idleText);
    expect(botSwitched(active, true)).toBe(active);
  });

  it('full round trip: type → send → stop lands back in idle with empty draft', () => {
    let s = idleEmpty;
    s = draftChanged(s, 'draft the follow-up');
    expect(canSend(s)).toBe(true);
    s = send(s)!;
    expect(s.mode).toBe('active');
    s = stop(s);
    expect(s).toEqual({ mode: 'idle', draft: '' });
  });
});
