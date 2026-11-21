import { describe, expect, it } from 'vitest';
import { ProviderKindSchema } from '@crewaid/shared';
import { capabilityLabels, contextWindowLabel } from '../src/renderer/settings/modelSettings';
import { providerDisplayName } from '../src/renderer/components/composer/modelPickerState';

describe('providerDisplayName', () => {
  /**
   * Replaces the old `providerEnvKey` coverage test, which asserted that every
   * provider in the contract had an environment variable named for it. D-083
   * removed the environment fallback entirely, so that claim is not merely
   * untested now — it is false, and a pane making it would send an operator to
   * edit a file that no longer has any effect.
   *
   * The property worth keeping is the same shape: a kind added to the contract
   * without a label here renders a heading with a hole in it.
   */
  it('labels every provider kind in the contract, including custom', () => {
    for (const kind of ProviderKindSchema.options) {
      expect(providerDisplayName(kind), `${kind} has no display name`).not.toBe('');
    }
    expect(providerDisplayName('custom')).toBe('Custom');
  });
});

describe('contextWindowLabel', () => {
  it('rounds to the unit people compare models in', () => {
    expect(contextWindowLabel(200_000)).toBe('200K context');
    expect(contextWindowLabel(400_000)).toBe('400K context');
    expect(contextWindowLabel(1_000_000)).toBe('1M context');
    expect(contextWindowLabel(1_500_000)).toBe('1.5M context');
  });

  it('does not pretend a small window is thousands', () => {
    expect(contextWindowLabel(512)).toBe('512 context');
  });
});

describe('capabilityLabels', () => {
  it('lists only what the model has', () => {
    expect(capabilityLabels({ tools: true, vision: false, reasoning: true })).toEqual([
      'Tools',
      'Reasoning',
    ]);
    expect(capabilityLabels({ tools: false, vision: false, reasoning: false })).toEqual([]);
  });
});
