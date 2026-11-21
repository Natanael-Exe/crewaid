import { describe, expect, it } from 'vitest';
import { readEdition } from '../src/common/edition.config.js';

describe('readEdition (D-152)', () => {
  it('reads each edition', () => {
    expect(readEdition({ CREWAID_EDITION: 'cloud' })).toBe('cloud');
    expect(readEdition({ CREWAID_EDITION: ' selfhosted ' })).toBe('selfhosted');
  });

  it('refuses to boot without one rather than picking a default', () => {
    expect(() => readEdition({})).toThrow(
      /CREWAID_EDITION must be "cloud" or "selfhosted", got ""/,
    );
    expect(() => readEdition({ CREWAID_EDITION: '' })).toThrow(/CREWAID_EDITION/);
  });

  it('refuses an unknown edition, including a near miss', () => {
    expect(() => readEdition({ CREWAID_EDITION: 'self-hosted' })).toThrow(/got "self-hosted"/);
    expect(() => readEdition({ CREWAID_EDITION: 'Cloud' })).toThrow(/got "Cloud"/);
  });
});
