import { describe, expect, it, vi } from 'vitest';
import { localTimezone } from '../src/renderer/routines/routinesState';
import { en, EN_PARTS } from '../src/renderer/i18n/messages/en';

/**
 * D-234: the English catalog every other language is translated from. The
 * merge in `en.ts` spreads its parts, so a key two parts define would keep
 * only the later message and the earlier screen would quietly read the other
 * one's words — the check that it cannot is here, not in a reviewer's eye.
 */
const entries = Object.entries(en) as [string, string | Record<string, string>][];
const texts = (message: string | Record<string, string>) =>
  typeof message === 'string' ? [message] : Object.values(message);

describe('D-234 — the English catalog', () => {
  it('keeps technical identifiers outside the catalog', () => {
    expect(entries.flatMap(([, message]) => texts(message))).not.toContain(
      'America/Port-au-Prince',
    );
    expect(entries.flatMap(([, message]) => texts(message))).not.toContain('http://localhost:3000');
    const format = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new Error('unavailable');
    });
    try {
      expect(localTimezone()).toBe('America/Port-au-Prince');
    } finally {
      format.mockRestore();
    }
  });
  it('defines each key in exactly one part', () => {
    const owners = new Map<string, string[]>();
    for (const [part, messages] of Object.entries(EN_PARTS)) {
      for (const key of Object.keys(messages)) owners.set(key, [...(owners.get(key) ?? []), part]);
    }
    const twice = [...owners].filter(([, parts]) => parts.length > 1);
    expect(twice).toEqual([]);
    expect(owners.size).toBe(entries.length);
  });

  it('holds whole messages: none empty, none a fragment with space at its edge', () => {
    const bad = entries.filter(([, message]) =>
      texts(message).some((text) => text.trim() === '' || text !== text.trim()),
    );
    expect(bad.map(([key]) => key)).toEqual([]);
  });

  it('writes each plural with the categories English uses, and always `other`', () => {
    const english = new Set(new Intl.PluralRules('en').resolvedOptions().pluralCategories);
    for (const [key, message] of entries) {
      if (typeof message === 'string') continue;
      expect(Object.keys(message), key).toContain('other');
      for (const category of Object.keys(message)) {
        expect(english.has(category as Intl.LDMLPluralRule), `${key}.${category}`).toBe(true);
      }
    }
  });
});
