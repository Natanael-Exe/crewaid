import { DOCKER_DEFAULT_SECCOMP } from './docker-default-seccomp.js';

/** A Docker seccomp profile, as the Engine API reads it from `SecurityOpt`. */
export interface SeccompProfile {
  readonly defaultAction: string;
  readonly defaultErrnoRet?: number;
  readonly archMap?: readonly {
    readonly architecture: string;
    readonly subArchitectures: readonly string[] | null;
  }[];
  readonly syscalls: readonly SeccompRule[];
}

export interface SeccompRule {
  readonly names: readonly string[];
  readonly action: string;
  readonly args?: readonly {
    readonly index: number;
    readonly value: number;
    readonly valueTwo?: number;
    readonly op: string;
  }[];
  readonly comment?: string;
  readonly includes?: SeccompFilter;
  readonly excludes?: SeccompFilter;
  readonly errnoRet?: number;
}

interface SeccompFilter {
  readonly caps?: readonly string[];
  readonly arches?: readonly string[];
  readonly minKernel?: string;
}

/** The only syscalls the browser profile adds to Docker's default. */
export const BROWSER_SANDBOX_SYSCALLS = Object.freeze(['chroot', 'clone', 'unshare'] as const);

/**
 * Docker's default profile, plus what Chrome's own sandbox needs.
 *
 * Chrome confines every renderer in fresh user, PID and network namespaces and
 * then chroots it into an empty directory. Docker's default profile allows
 * `clone` with namespace flags, `unshare` and `chroot` only to a container
 * holding `CAP_SYS_ADMIN` or `CAP_SYS_CHROOT`, which a sandbox never does, so
 * the zygote died and D-027 turned the sandbox off instead. Measured on the
 * Dokploy host (Ubuntu 24.04, Docker 28.5), these three are all it lacks: with
 * them Chrome starts without `--no-sandbox` and its renderers run in their own
 * user and PID namespaces.
 *
 * No capability is granted and `no-new-privileges` stays. The kernel still
 * checks each call: `chroot` needs `CAP_SYS_CHROOT` in the caller's user
 * namespace, which a process has only inside one it just created, so the
 * container's own root cannot be escaped with it. What does widen is the
 * kernel surface a user namespace reaches, which is D-145's trade.
 *
 * The masked `clone` rules are removed rather than left beside the
 * unconditional one, so exactly one rule decides `clone`.
 */
export function browserSandboxProfile(base: SeccompProfile): SeccompProfile {
  const isMaskedClone = (rule: SeccompRule): boolean =>
    rule.names.length === 1 && rule.names[0] === 'clone' && rule.args !== undefined;
  return {
    ...base,
    syscalls: [
      ...base.syscalls.filter((rule) => !isMaskedClone(rule)),
      { names: [...BROWSER_SANDBOX_SYSCALLS], action: 'SCMP_ACT_ALLOW' },
    ],
  };
}

export const BROWSER_SANDBOX_SECCOMP: SeccompProfile =
  browserSandboxProfile(DOCKER_DEFAULT_SECCOMP);
