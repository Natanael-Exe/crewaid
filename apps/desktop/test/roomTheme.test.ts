import { describe, expect, it } from 'vitest';
import { botAccentTokens, contrastRatio, mixColor } from '../src/renderer/styles/botAccent';
import { enteringMessageIds, rememberMessages } from '../src/renderer/styles/messageEntrance';
import { parseThemePreference } from '../src/renderer/styles/themePreference';
import type { TranscriptMessage } from '../src/renderer/state/viewTypes';

const message = (
  id: string,
  createdAt: number,
  author: TranscriptMessage['author'] = 'BOT',
): TranscriptMessage => ({ id, createdAt, author, parts: [], timeLabel: '' });

describe('selected bot palette', () => {
  it.each(['#7B5CE0', '#2FA59A', '#3563E9', '#4c6ef5', '#F2B233', '#ffffff', '#000000', '#777777'])(
    'preserves %s and provides readable ink in both themes',
    (color) => {
      const tokens = botAccentTokens(color);
      expect(tokens['--accent']).toBe(color);
      expect(contrastRatio(color, tokens['--accent-foreground']!)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(tokens['--accent-control']!, tokens['--accent-control-foreground']!),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(mixColor(color, '#FFFFFF', 0.08), tokens['--bot-accent-ink-light']!),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(mixColor(color, '#101430', 0.26), tokens['--bot-accent-ink-dark']!),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );
  it('rejects invalid stored colors instead of injecting CSS', () => {
    expect(botAccentTokens('red; background: url(x)')['--accent']).toBe('#000000');
    expect(botAccentTokens(undefined)['--accent']).toBe('#000000');
  });
});

describe('live bubble entrances', () => {
  const existing = [message('old', 10), message('tail', 20)];
  const previous = rememberMessages('quill', existing);
  it('does not animate hydration, bot switches or older history pages', () => {
    expect(enteringMessageIds(null, 'quill', existing, true)).toEqual([]);
    expect(enteringMessageIds(previous, 'scout', existing, true)).toEqual([]);
    expect(enteringMessageIds(previous, 'quill', [message('older', 1), ...existing], true)).toEqual(
      [],
    );
    expect(enteringMessageIds(previous, 'quill', [...existing, message('new', 30)], false)).toEqual(
      [],
    );
  });
  it('enters each new live message once and ignores stream updates and system notices', () => {
    const messages = [
      ...existing,
      message('user', 30, 'USER'),
      message('bot', 31),
      message('notice', 32, 'SYSTEM'),
    ];
    expect(enteringMessageIds(previous, 'quill', messages, true)).toEqual(['user', 'bot']);
    expect(
      enteringMessageIds(
        rememberMessages('quill', messages),
        'quill',
        messages.map((row) => ({ ...row, parts: [{ type: 'text', text: 'stream updated' }] })),
        true,
      ),
    ).toEqual([]);
  });
});

it('defaults unknown appearance settings to the system preference', () => {
  expect(parseThemePreference('dark')).toBe('dark');
  expect(parseThemePreference('light')).toBe('light');
  for (const value of [null, undefined, 'system', 'invalid'])
    expect(parseThemePreference(value)).toBe('system');
});
