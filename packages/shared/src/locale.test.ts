import { describe, expect, it } from 'vitest';
import {
  isKnownTimezone,
  isRtlLocale,
  matchSupportedLocale,
  resolveLocale,
  resolveTimezone,
  SUPPORTED_LOCALES,
} from './locale.js';

describe('matchSupportedLocale', () => {
  it('drops the region a computer reports', () => {
    expect(matchSupportedLocale(['fr-HT'])).toBe('fr');
    expect(matchSupportedLocale(['pt-PT'])).toBe('pt');
    expect(matchSupportedLocale(['es-419'])).toBe('es');
  });

  it('takes the first preferred language it has, skipping the ones it does not', () => {
    expect(matchSupportedLocale(['is-IS', 'de-CH', 'fr'])).toBe('de');
  });

  it('reads the Chinese script from the region when the tag does not name it', () => {
    expect(matchSupportedLocale(['zh-TW'])).toBe('zh-Hant');
    expect(matchSupportedLocale(['zh-HK'])).toBe('zh-Hant');
    expect(matchSupportedLocale(['zh-CN'])).toBe('zh-Hans');
    expect(matchSupportedLocale(['zh'])).toBe('zh-Hans');
    expect(matchSupportedLocale(['zh-Hant-CN'])).toBe('zh-Hant');
  });

  it('reads every Norwegian tag as Bokmål', () => {
    expect(matchSupportedLocale(['no'])).toBe('nb');
    expect(matchSupportedLocale(['nn-NO'])).toBe('nb');
    expect(matchSupportedLocale(['nb-NO'])).toBe('nb');
  });

  it('answers null when nothing matches, and survives a malformed tag', () => {
    expect(matchSupportedLocale(['is', 'not a tag!'])).toBeNull();
    expect(matchSupportedLocale([])).toBeNull();
  });

  it('matches every supported code to itself', () => {
    for (const locale of SUPPORTED_LOCALES) expect(matchSupportedLocale([locale])).toBe(locale);
  });
});

describe('resolution', () => {
  it('prefers the choice, then the computer, then English', () => {
    expect(resolveLocale('fr', 'de')).toBe('fr');
    expect(resolveLocale(null, 'de')).toBe('de');
    expect(resolveLocale(null, null)).toBe('en');
  });

  it('invents no timezone', () => {
    expect(resolveTimezone('Europe/Paris', 'UTC')).toBe('Europe/Paris');
    expect(resolveTimezone(null, 'UTC')).toBe('UTC');
    expect(resolveTimezone(null, null)).toBeNull();
  });

  it('knows which languages are written right to left', () => {
    expect(SUPPORTED_LOCALES.filter(isRtlLocale)).toEqual(['ar', 'he', 'ur']);
  });

  it('knows the zones the runtime knows', () => {
    expect(isKnownTimezone('UTC')).toBe(true);
    expect(isKnownTimezone('America/Port-au-Prince')).toBe(true);
    expect(isKnownTimezone('Mars/Olympus_Mons')).toBe(false);
  });
});
