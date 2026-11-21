import { describe, expect, it } from 'vitest';
import { DOCKER_DEFAULT_SECCOMP } from './docker-default-seccomp.js';
import { SANDBOX_LIMITS } from '@crewaid/sandbox-docker';
import { securityOptions } from './docker-engine.js';
import {
  BROWSER_SANDBOX_SECCOMP,
  BROWSER_SANDBOX_SYSCALLS,
  browserSandboxProfile,
  type SeccompRule,
} from './seccomp-profile.js';

const allowed = (rules: readonly SeccompRule[], name: string): SeccompRule[] =>
  rules.filter((rule) => rule.names.includes(name) && rule.action === 'SCMP_ACT_ALLOW');

describe('the browser sandbox seccomp profile (D-145)', () => {
  it("gates Chrome's syscalls on a capability in Docker's own default", () => {
    // The premise of the whole change: without these rules Chrome's zygote dies.
    for (const name of BROWSER_SANDBOX_SYSCALLS) {
      const ungated = allowed(DOCKER_DEFAULT_SECCOMP.syscalls, name).filter(
        (rule) => rule.includes?.caps === undefined && rule.args === undefined,
      );
      expect(ungated, name).toEqual([]);
    }
  });

  it('adds exactly chroot, clone and unshare, unconditionally', () => {
    const added = BROWSER_SANDBOX_SECCOMP.syscalls.at(-1);
    expect(added).toEqual({ names: ['chroot', 'clone', 'unshare'], action: 'SCMP_ACT_ALLOW' });
    expect(allowed(BROWSER_SANDBOX_SECCOMP.syscalls, 'clone').filter((rule) => rule.args)).toEqual(
      [],
    );
  });

  it("keeps every other rule of Docker's default untouched", () => {
    const maskedClone = (rule: SeccompRule): boolean =>
      rule.names.length === 1 && rule.names[0] === 'clone' && rule.args !== undefined;
    expect(BROWSER_SANDBOX_SECCOMP.defaultAction).toBe(DOCKER_DEFAULT_SECCOMP.defaultAction);
    expect(BROWSER_SANDBOX_SECCOMP.archMap).toEqual(DOCKER_DEFAULT_SECCOMP.archMap);
    expect(BROWSER_SANDBOX_SECCOMP.syscalls.slice(0, -1)).toEqual(
      DOCKER_DEFAULT_SECCOMP.syscalls.filter((rule) => !maskedClone(rule)),
    );
    // Nothing a capability gates besides the three is opened: mount, setns,
    // bpf and friends stay behind their capability.
    for (const name of ['mount', 'setns', 'bpf', 'init_module', 'open_by_handle_at']) {
      const rules = allowed(BROWSER_SANDBOX_SECCOMP.syscalls, name);
      expect(rules.length, name).toBeGreaterThan(0);
      expect(
        rules.every((rule) => rule.includes?.caps !== undefined),
        name,
      ).toBe(true);
    }
  });

  it('does not mutate the profile it extends', () => {
    const before = JSON.stringify(DOCKER_DEFAULT_SECCOMP);
    browserSandboxProfile(DOCKER_DEFAULT_SECCOMP);
    expect(JSON.stringify(DOCKER_DEFAULT_SECCOMP)).toBe(before);
  });

  it("sends the profile's JSON with no-new-privileges, and nothing without either", () => {
    expect(securityOptions(SANDBOX_LIMITS)).toEqual({
      SecurityOpt: ['no-new-privileges:true', `seccomp=${JSON.stringify(BROWSER_SANDBOX_SECCOMP)}`],
    });
    expect(
      securityOptions({ ...SANDBOX_LIMITS, noNewPrivileges: false, allowBrowserSandbox: false }),
    ).toEqual({});
  });
});
