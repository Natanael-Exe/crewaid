import { describe, expect, it } from 'vitest';

import {
  DEFAULT_IDLE_STOP_MS,
  DEFAULT_MAX_RUNNING,
  readIdleStopMs,
  readMaxRunning,
} from '../src/sandbox/sandbox.config.js';

/**
 * M2-BE-11 — the §7/§8 config, read the `auth.guard.ts` way (D-039 §11).
 *
 * These are one-line functions with a disproportionate failure mode. A ceiling
 * that parses as `NaN` admits every start, because `n >= NaN` is false — so a
 * typo in an environment variable silently removes host capacity admission and
 * nothing anywhere reports it. Failing at construction is what turns that into
 * a boot error an operator sees.
 */
describe('sandbox lifecycle configuration', () => {
  describe('SANDBOX_MAX_RUNNING', () => {
    it('defaults to §7.5’s sizing when unset or blank', () => {
      expect(readMaxRunning(undefined)).toBe(DEFAULT_MAX_RUNNING);
      expect(readMaxRunning('')).toBe(DEFAULT_MAX_RUNNING);
      expect(readMaxRunning('   ')).toBe(DEFAULT_MAX_RUNNING);
    });

    it('reads a configured ceiling', () => {
      expect(readMaxRunning('12')).toBe(12);
    });

    it('throws rather than admitting everything', () => {
      // The whole point: `12; rm -rf` and `six` both become NaN, and NaN
      // compares false against every count there is.
      expect(() => readMaxRunning('six')).toThrow('must be a number');
      expect(() => readMaxRunning('2.5')).toThrow('integer >= 1');
      expect(() => readMaxRunning('-1')).toThrow('integer >= 1');
    });

    it('has no disabled value', () => {
      // Deliberately unlike SANDBOX_IDLE_STOP_MS. A host with room for no
      // sandboxes cannot run the product, so `0` is a misconfiguration to
      // report at boot rather than a policy to honour at the first start.
      expect(() => readMaxRunning('0')).toThrow('integer >= 1');
    });
  });

  describe('SANDBOX_IDLE_STOP_MS', () => {
    it('defaults to thirty minutes', () => {
      expect(readIdleStopMs(undefined)).toBe(DEFAULT_IDLE_STOP_MS);
      expect(DEFAULT_IDLE_STOP_MS).toBe(1_800_000);
    });

    it('accepts 0 as disabled, matching SANDBOX_HEALTH_INTERVAL_MS', () => {
      expect(readIdleStopMs('0')).toBe(0);
    });

    it('throws on anything it cannot honour', () => {
      expect(() => readIdleStopMs('half an hour')).toThrow('must be a number');
      expect(() => readIdleStopMs('-1')).toThrow('integer >= 0');
    });
  });
});
