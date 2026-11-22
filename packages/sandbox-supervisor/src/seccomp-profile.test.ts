import { describe, expect, it } from 'vitest';
import { BROWSER_SANDBOX_SECCOMP } from '@crewaid/sandbox-core';
import { SANDBOX_LIMITS } from '@crewaid/sandbox-docker';
import { securityOptions } from './docker-engine.js';

describe('supervisor securityOptions (D-145)', () => {
  it("sends the profile's JSON with no-new-privileges, and nothing without either", () => {
    expect(securityOptions(SANDBOX_LIMITS)).toEqual({
      SecurityOpt: ['no-new-privileges:true', `seccomp=${JSON.stringify(BROWSER_SANDBOX_SECCOMP)}`],
    });
    expect(
      securityOptions({ ...SANDBOX_LIMITS, noNewPrivileges: false, allowBrowserSandbox: false }),
    ).toEqual({});
  });
});
