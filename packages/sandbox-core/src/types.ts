import type { GitProcessRunner } from './git-process.js';
/**
 * The single re-export point for `@ai-sdk/harness` types.
 *
 * ⚠️ THE CHURN FIREWALL. Every sandbox provider, and everything downstream of
 * one, imports harness types from HERE, never from `@ai-sdk/harness` directly, so an
 * upstream rename is a one-file fix rather than a repo-wide sweep. These types
 * carry `Experimental_` and `harness-sandbox-v1` markers and are expected to
 * move (PRD §2.5; DECISIONS.md "Upstream caveat · harness optional members").
 * `eslint.config.mjs` names this exact path as the only allowed importer;
 * `tools/guard-probes/m2be02-harness-direct.probe.ts` proves the ban fires.
 *
 * This file lands before anything downstream names a harness type, because a
 * firewall built after the first direct import is a firewall with a hole in it.
 *
 * Verified against @ai-sdk/harness@1.0.98 (read from the installed .d.ts)
 *
 * On `HarnessV1NetworkSandboxSession`:
 * REQUIRED id, defaultWorkingDirectory, ports, getPortEndpoint,
 * getPortUrl (DEPRECATED), stop, destroy, restricted
 * OPTIONAL setNetworkPolicy?, setPorts?, setRequestTransformations?,
 * addRequestTransformations?
 *
 * On `HarnessV1SandboxProvider`:
 * REQUIRED specificationVersion, providerId, createSession
 * OPTIONAL resumeSession?
 *
 * Three consequences for M2, each confirmed against the real types rather than
 * assumed from the PRD. `types.test.ts` asserts all three at compile time, so
 * an upstream change that invalidates one fails the build here instead of
 * surfacing as a runtime fault in the sandbox path:
 *
 * 1. NETWORK POLICY. `setNetworkPolicy` is optional, so iptables rules
 * on the `agent-net` bridge are the PRIMARY mechanism and
 * `setNetworkPolicy?.()` is an opportunistic upgrade behind a capability
 * check. The PRD's "prefer session.setNetworkPolicy()" hedge inverts the
 * real priority. M2-BE-09 implements iptables as the real path.
 *
 * 2. RESUME. `resumeSession` is optional. The call site must be an
 * optional call with a `createSession()` fallback so an upstream change
 * degrades instead of throwing. The harness throws
 * `HarnessCapabilityUnsupportedError` when resume is attempted against a
 * provider that omits it — we implement it ourselves, so we control this,
 * but the guard stays.
 *
 * 3. PORT RESOLUTION. `getPortUrl` — the method the PRD names
 * throughout §4.3 and M2 — is `@deprecated` in 1.0.98 in favour of
 * `getPortEndpoint`, which returns `{ url, headers? }` rather than a bare
 * string. The headers are scoped to that URL and MUST be sent when opening
 * the connection. Dropping them fails the connection in a way that reads
 * as a sandbox or network fault, not a missing header. The upstream
 * interface still requires getPortUrl for compatibility; downstream
 * callers must use getPortEndpoint.
 */

import type {
  HarnessV1NetworkPolicy,
  HarnessV1NetworkSandboxSession,
  HarnessV1PortEndpoint,
  HarnessV1SandboxProvider,
} from '@ai-sdk/harness';

export type {
  HarnessV1NetworkPolicy,
  HarnessV1NetworkSandboxSession,
  HarnessV1PortEndpoint,
  HarnessV1SandboxProvider,
};

/**
 * Harness error classes, re-exported as values because call sites both throw
 * and narrow on them.
 *
 * `HarnessSandboxAuthenticationError` is the contractual signal for "sandbox
 * acquisition failed because credentials are missing, invalid, or unauthorized"
 * — it is what lets a framework integration tell a misconfiguration apart from
 * a Docker daemon that is simply down. Each class carries a private brand
 * symbol, so `instanceof` is unreliable across duplicated copies of the package;
 * prefer the static `isInstance` each one ships.
 */
export {
  HarnessCapabilityUnsupportedError,
  HarnessError,
  HarnessSandboxAuthenticationError,
} from '@ai-sdk/harness';

/**
 * `specificationVersion` as a value rather than a repeated string literal.
 *
 * Typing it from the interface is the point: if upstream revs the marker, this
 * assignment stops compiling in the one file that is allowed to know about it,
 * instead of leaving a stale literal in a provider that silently no longer
 * satisfies the contract.
 */
export const HARNESS_SANDBOX_SPECIFICATION_VERSION: HarnessV1SandboxProvider['specificationVersion'] =
  'harness-sandbox-v1';

/**
 * Options accepted by `createSession()`.
 *
 * Upstream declares this shape inline on the method and exports no name for it,
 * so without an alias here every downstream implementation and test would
 * re-derive the same `Parameters<...>` expression — which is exactly the
 * repo-wide churn surface the firewall exists to collapse. The parameter is
 * optional upstream (prewarm paths call it with nothing); `NonNullable` gives
 * the object itself, since implementations still have to name the fields.
 */
export type HarnessV1CreateSessionOptions = NonNullable<
  Parameters<HarnessV1SandboxProvider['createSession']>[0]
>;

/** Options accepted by `resumeSession()`. Inline upstream, same reasoning. */
export type HarnessV1ResumeSessionOptions = Parameters<
  NonNullable<HarnessV1SandboxProvider['resumeSession']>
>[0];

/** Options accepted by `getPortEndpoint()`. Inline upstream, same reasoning. */
export type HarnessV1PortEndpointOptions = Parameters<
  HarnessV1NetworkSandboxSession['getPortEndpoint']
>[0];

/**
 * The reduced session handed to tool `execute()` calls — file I/O, exec,
 * and spawn, with no way to stop the sandbox or change its network policy.
 *
 * Derived from `restricted()` rather than imported from `@ai-sdk/provider-utils`
 * on purpose. The underlying `Experimental_SandboxSession` lives in a different
 * package that is only a transitive dependency here, and naming it directly
 * would put a second harness-shaped type outside the firewall — the lint rule
 * bans `@ai-sdk/harness`, not the package the harness happens to build on. The
 * `ReturnType` keeps this alias correct for free if upstream swaps the type.
 */
export type HarnessV1RestrictedSandboxSession = ReturnType<
  HarnessV1NetworkSandboxSession['restricted']
>;

/**
 * Every member the network session adds on top of the base one — the infra
 * surface R4 keeps away from tools, as names that also exist at runtime.
 *
 * A tool reaching any of these can take the desktop away from the operator who
 * is watching it: `stop` and `destroy` end the container mid-task,
 * `setNetworkPolicy` and the two request-transformation setters repoint or
 * rewrite its egress, `setPorts` changes what it exposes,
 * `getPortEndpoint`/`getPortUrl` hand out a reachable address, and `restricted`
 * is the ladder back up to all of it. `id`, `defaultWorkingDirectory` and `ports` carry no capability, but
 * they are on the list for the property the list is FOR: it is the exact
 * difference between the two interfaces, asserted as such in `types.test.ts`,
 * so a member upstream adds cannot arrive unclassified. The build fails here,
 * in the one file allowed to know about the harness, rather than silently
 * widening what a tool can reach.
 */
export const SANDBOX_INFRA_SURFACE = [
  'id',
  'defaultWorkingDirectory',
  'ports',
  'getPortEndpoint',
  'getPortUrl',
  'stop',
  'destroy',
  'setNetworkPolicy',
  'setRequestTransformations',
  'addRequestTransformations',
  'setPorts',
  'restricted',
] as const;

/**
 * The session a tool's `execute()` receives.
 *
 * `HarnessV1RestrictedSandboxSession` on its own is not enough, and the reason
 * is structural typing: the network session EXTENDS the base one, so it is
 * assignable to it. Typing a tool's session as the reduced view therefore stops
 * a tool CALLING `destroy()` — the property is not on the type — but stops
 * nobody handing it the full session in the first place. That is the mistake
 * with a real chance of happening, because `() => this.session` is one word
 * shorter than `() => this.session.restricted()` and, until this type existed,
 * compiled.
 *
 * Declaring each infra member as an optional `never` closes it. A value that
 * HAS `destroy: () => PromiseLike<void>` stops being assignable, because a
 * function is not a `never`, so the wide session is rejected at the boundary —
 * while the reduced view, which carries no such property, still fits. Calling
 * stays blocked in both spellings: `s.destroy()` because the property is
 * possibly undefined, and `s.destroy?.()` because `never` has no call
 * signatures, so the optional-call escape hatch is not one.
 *
 * It cannot be the whole fence, because the type is erased: a value laundered
 * through a variable annotated as the plain reduced view still passes, and the
 * object itself comes from an injected provider that TypeScript never saw.
 * `AgentSessionService` carries the runtime half.
 */
export type ToolSandboxSession = HarnessV1RestrictedSandboxSession & {
  readonly git?: GitProcessRunner;
} & {
  readonly [Member in (typeof SANDBOX_INFRA_SURFACE)[number]]?: never;
};

/**
 * The option and result shapes on the reduced session's own methods.
 *
 * These live one package further out than the harness — they are
 * `@ai-sdk/provider-utils` types reached through `restricted()` — and upstream
 * exports a name for none of them. Deriving them here keeps that package out of
 * the rest of the repo for the same reason the harness itself is: the lint rule
 * fences one import name, but the churn arrives through whatever type the
 * session's methods happen to take.
 */
type Reduced = HarnessV1RestrictedSandboxSession;

/** Options for `run()` and `spawn()`. */
export type SandboxProcessOptions = Parameters<Reduced['run']>[0];

/** The handle `spawn()` returns: two byte streams, `wait()`, and `kill()`. */
export type SandboxProcess = Awaited<ReturnType<Reduced['spawn']>>;

/** The `{ exitCode, stdout, stderr }` triple `run()` resolves to. */
export type SandboxRunResult = Awaited<ReturnType<Reduced['run']>>;

/** Options for every read: `readFile`, `readBinaryFile`, `readTextFile`. */
export type SandboxReadFileOptions = Parameters<Reduced['readFile']>[0];

/** `readTextFile` adds encoding and a 1-based inclusive line range. */
export type SandboxReadTextFileOptions = Parameters<Reduced['readTextFile']>[0];

/** Options for each write, one per content shape. */
export type SandboxWriteStreamOptions = Parameters<Reduced['writeFile']>[0];
export type SandboxWriteBinaryOptions = Parameters<Reduced['writeBinaryFile']>[0];
export type SandboxWriteTextOptions = Parameters<Reduced['writeTextFile']>[0];
