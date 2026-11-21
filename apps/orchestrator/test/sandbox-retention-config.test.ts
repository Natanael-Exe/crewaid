import { describe, expect, it } from 'vitest';
import { readWorkspaceRetentionMs } from '../src/sandbox/sandbox.config.js';

describe('workspace retention configuration', () => {
  it('defaults to seven days and accepts positive whole days', () => {
    expect(readWorkspaceRetentionMs(undefined)).toBe(7 * 86_400_000);
    expect(readWorkspaceRetentionMs('14')).toBe(14 * 86_400_000);
  });
  it('rejects invalid or unsafe retention periods at boot', () => {
    for (const raw of ['0', '-1', '1.5', 'NaN', 'Infinity', '100000000000']) {
      expect(() => readWorkspaceRetentionMs(raw)).toThrow('SANDBOX_WORKSPACE_RETENTION_DAYS');
    }
  });
});
