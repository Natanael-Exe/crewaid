/**
 * The wire between the Docker provider and the sandbox supervisor.
 *
 * Both halves import this file, so a verb's path, a request's signature and a
 * status's JSON shape have one definition. It carries no Docker types: the
 * supervisor is the only process that speaks to the daemon, and what crosses
 * here is the narrow `ContainerEngine` vocabulary.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type { ContainerMount, ContainerPortBinding, ContainerStatus } from '@crewaid/sandbox-core';

/** Every verb is a `POST` under this prefix with a JSON body. */
export const SUPERVISOR_PATHS = {
  health: '/v1/health',
  ensureNetwork: '/v1/network/ensure',
  create: '/v1/containers/create',
  start: '/v1/containers/start',
  stop: '/v1/containers/stop',
  remove: '/v1/containers/remove',
  inspect: '/v1/containers/inspect',
  findByLabel: '/v1/containers/find-by-label',
  listByLabel: '/v1/containers/list-by-label',
  listByVolume: '/v1/containers/list-by-volume',
  findById: '/v1/containers/find-by-id',
  listWorkspaceVolumes: '/v1/volumes/list',
  findVolume: '/v1/volumes/find',
  createVolume: '/v1/volumes/create',
  removeWorkspaceVolume: '/v1/volumes/remove',
  workspaceMarker: '/v1/volumes/marker',
  retireBotProfile: '/v1/volumes/retire-profile',
} as const;

export const SIGNATURE_HEADER = 'x-crewaid-signature';
/** Written only by the supervisor when it creates a workspace. */
export const SUPERVISOR_NETWORK_LABEL = 'crewaid.supervisorNetwork';

/**
 * How far a request's clock may be from the supervisor's. Nonces stay cached
 * for twice this window because an accepted future timestamp remains valid
 * for another full window after the receiving clock reaches it.
 */
export const SIGNATURE_WINDOW_MS = 30_000;

/** A secret shorter than this is a typo or a placeholder, not a key. */
export const MIN_SECRET_LENGTH = 32;

/**
 * A request's signature: an HMAC over everything that decides what it does.
 *
 * The body is hashed rather than signed raw so the canonical string stays
 * small and line-oriented; the hash binds it just as well. The secret itself
 * never travels, which is what keeps a captured request from being a key.
 */
export function signRequest(
  secret: string,
  request: { readonly method: string; readonly path: string; readonly body: string },
  now: number = Date.now(),
  nonce: string = randomUUID(),
): string {
  const mac = hmac(secret, canonical(request, now, nonce));
  return `t=${now},n=${nonce},s=${mac}`;
}

export type VerifyFailure = 'missing' | 'malformed' | 'stale' | 'replayed' | 'bad-signature';

/**
 * Remembers the nonces seen inside the signature window, so a request
 * captured on the private network cannot be sent a second time.
 */
export class NonceCache {
  readonly #seen = new Map<string, number>();

  /** True when the nonce is new; records it. */
  claim(nonce: string, now: number): boolean {
    for (const [seen, at] of this.#seen) {
      if (now - at > SIGNATURE_WINDOW_MS * 2) this.#seen.delete(seen);
    }
    if (this.#seen.has(nonce)) return false;
    this.#seen.set(nonce, now);
    return true;
  }
}

/**
 * Checks a signature against every accepted secret — the current one, and the
 * previous one while a rotation is under way.
 *
 * The nonce is claimed only after the MAC verifies, so a forged request cannot
 * burn a nonce a genuine one is about to use.
 */
export function verifyRequest(
  secrets: readonly string[],
  request: { readonly method: string; readonly path: string; readonly body: string },
  header: string | undefined,
  nonces: NonceCache,
  now: number = Date.now(),
): { readonly ok: true } | { readonly ok: false; readonly reason: VerifyFailure } {
  if (header === undefined || header === '') return { ok: false, reason: 'missing' };
  const match = /^t=(\d{1,16}),n=([0-9a-f-]{36}),s=([0-9a-f]{64})$/.exec(header);
  if (match === null) return { ok: false, reason: 'malformed' };
  const [, rawTime, nonce, mac] = match as unknown as [string, string, string, string];
  const time = Number(rawTime);
  if (!Number.isSafeInteger(time) || Math.abs(now - time) > SIGNATURE_WINDOW_MS) {
    return { ok: false, reason: 'stale' };
  }
  const expected = canonical(request, time, nonce);
  const given = Buffer.from(mac, 'hex');
  const verified = secrets.some((secret) => {
    const want = Buffer.from(hmac(secret, expected), 'hex');
    return want.length === given.length && timingSafeEqual(want, given);
  });
  if (!verified) return { ok: false, reason: 'bad-signature' };
  if (!nonces.claim(nonce, now)) return { ok: false, reason: 'replayed' };
  return { ok: true };
}

function canonical(
  request: { readonly method: string; readonly path: string; readonly body: string },
  time: number,
  nonce: string,
): string {
  const bodyHash = createHash('sha256').update(request.body).digest('hex');
  return [request.method.toUpperCase(), request.path, String(time), nonce, bodyHash].join('\n');
}

function hmac(secret: string, text: string): string {
  return createHmac('sha256', secret).update(text).digest('hex');
}

/** `ContainerStatus` as JSON: object keys are strings, so ports travel as string keys. */
export interface WireContainerStatus {
  readonly running: boolean;
  readonly exitCode: number | null;
  readonly portBindings: Readonly<Record<string, ContainerPortBinding>>;
  readonly mounts: readonly ContainerMount[];
  readonly labels: Readonly<Record<string, string>>;
}

export function toWireStatus(status: ContainerStatus): WireContainerStatus {
  const portBindings: Record<string, ContainerPortBinding> = {};
  for (const [port, binding] of Object.entries(status.portBindings)) {
    if (binding !== undefined) portBindings[port] = binding;
  }
  return {
    running: status.running,
    exitCode: status.exitCode,
    portBindings,
    mounts: status.mounts,
    labels: status.labels,
  };
}

export function fromWireStatus(wire: WireContainerStatus): ContainerStatus {
  const portBindings: Record<number, ContainerPortBinding | undefined> = {};
  for (const [port, binding] of Object.entries(wire.portBindings)) {
    portBindings[Number(port)] = binding;
  }
  return {
    running: wire.running,
    exitCode: wire.exitCode,
    portBindings,
    mounts: wire.mounts,
    labels: wire.labels,
  };
}

/** The body of every refusal, so the provider can tell "no" from "down". */
export interface SupervisorRefusal {
  readonly error: string;
  readonly code: 'unauthorized' | 'refused' | 'not-found' | 'invalid' | 'failed';
}
