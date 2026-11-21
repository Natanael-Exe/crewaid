import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_TOTAL_MB,
  DEFAULT_MIN_FREE_MB,
  DEFAULT_REAP_INTERVAL_MS,
  readArtifactMaxTotalBytes,
  readMinFreeBytes,
  readReapIntervalMs,
  readReapOnBoot,
} from '../src/attachments/attachments.config.js';

const MEBIBYTE = 1024 * 1024;

describe('artifact lifecycle configuration', () => {
  it('uses documented defaults for missing values', () => {
    expect(readArtifactMaxTotalBytes(undefined)).toBe(DEFAULT_MAX_TOTAL_MB * MEBIBYTE);
    expect(readMinFreeBytes('')).toBe(DEFAULT_MIN_FREE_MB * MEBIBYTE);
    expect(readReapIntervalMs('   ')).toBe(DEFAULT_REAP_INTERVAL_MS);
    expect(readReapOnBoot(undefined)).toBe(true);
  });

  it('reads explicit values including disabled optional policies', () => {
    expect(readArtifactMaxTotalBytes('12')).toBe(12 * MEBIBYTE);
    expect(readMinFreeBytes('0')).toBe(0);
    expect(readReapIntervalMs('0')).toBe(0);
    expect(readReapOnBoot('false')).toBe(false);
  });

  it('rejects malformed and unsafe numeric values', () => {
    expect(() => readArtifactMaxTotalBytes('many')).toThrow('must be a number');
    expect(() => readArtifactMaxTotalBytes('0')).toThrow('safe integer >= 1');
    expect(() => readArtifactMaxTotalBytes('1.5')).toThrow('safe integer >= 1');
    expect(() => readArtifactMaxTotalBytes(String(Number.MAX_SAFE_INTEGER))).toThrow(
      'safe integer >= 1',
    );
    expect(() => readMinFreeBytes('-1')).toThrow('safe integer >= 0');
    expect(() => readReapIntervalMs('-1')).toThrow('integer >= 0');
  });

  it('accepts only explicit boolean spellings', () => {
    expect(readReapOnBoot('true')).toBe(true);
    expect(() => readReapOnBoot('TRUE')).toThrow("must be 'true' or 'false'");
  });
});
