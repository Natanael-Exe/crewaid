import { describe, expect, it, vi } from 'vitest';
import {
  getShellShortcutAction,
  type ShellShortcutEvent,
} from '../src/renderer/components/layout/shortcuts';

function keyEvent(overrides: Partial<ShellShortcutEvent>): ShellShortcutEvent {
  return {
    key: 'k',
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

describe('shell shortcut resolution', () => {
  it('maps Cmd+K to focusing the bot search field', () => {
    expect(getShellShortcutAction(keyEvent({ key: 'k' }), 6)).toEqual({ type: 'focus-search' });
  });

  it('maps Cmd+1 through Cmd+9 to stable bot indexes', () => {
    expect(getShellShortcutAction(keyEvent({ key: '1' }), 9)).toEqual({
      type: 'select-bot',
      index: 0,
    });
    expect(getShellShortcutAction(keyEvent({ key: '9' }), 9)).toEqual({
      type: 'select-bot',
      index: 8,
    });
  });

  it('does not select an unassigned bot slot', () => {
    expect(getShellShortcutAction(keyEvent({ key: '6' }), 5)).toBeNull();
    expect(getShellShortcutAction(keyEvent({ key: '0' }), 9)).toBeNull();
  });

  it('requires the command modifier and rejects shifted/alternate chords', () => {
    expect(getShellShortcutAction(keyEvent({ metaKey: false }), 9)).toBeNull();
    expect(getShellShortcutAction(keyEvent({ key: '1', shiftKey: true }), 9)).toBeNull();
    expect(getShellShortcutAction(keyEvent({ key: '1', altKey: true }), 9)).toBeNull();
    expect(
      getShellShortcutAction(keyEvent({ key: '1', ctrlKey: true, metaKey: false }), 9),
    ).toEqual({
      type: 'select-bot',
      index: 0,
    });
  });

  it('does not steal a chord already handled by another listener or key repeat', () => {
    expect(getShellShortcutAction(keyEvent({ defaultPrevented: true }), 9)).toBeNull();
    expect(getShellShortcutAction(keyEvent({ repeat: true }), 9)).toBeNull();
  });
});
