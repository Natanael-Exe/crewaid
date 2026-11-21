import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

import { ScreenTicketClaimsSchema, type ScreenTicketClaims } from '@crewaid/shared';

/**
 * Screen tickets: what lets one viewer open one stream.
 *
 * The orchestrator signs a ticket after checking that the person owns the bot
 * and that its computer is running; whichever server the grant points at
 * checks the signature before it streams a pixel. That server may be inside
 * the computer, so it holds only the PUBLIC half — there is no secret in the
 * computer to steal, and a bot that replaces the key can only let itself watch
 * its own desktop.
 *
 * Ed25519 because Node verifies it with no dependency and the signature is 64
 * bytes. The orchestrator can rotate its signing key at boot. A gateway that
 * retains the verification key across its own restarts must also retain its
 * consumed ticket IDs until expiry.
 *
 * Wire form: `base64url(JSON claims) "." base64url(signature over the first part)`.
 */

/** A ticket is meant to be used straight away; this is the most it has. */
export const SCREEN_TICKET_TTL_MS = 60_000;
/** Bounds what a verifier will even try to parse. */
export const SCREEN_TICKET_MAX_LENGTH = 4096;

export interface ScreenTicketKeys {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export function generateScreenTicketKeys(): ScreenTicketKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey };
}

/** The public key as text, for a server that verifies somewhere else. */
export function exportScreenTicketPublicKey(publicKey: KeyObject): string {
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
}

export function importScreenTicketPublicKey(encoded: string): KeyObject {
  const key = createPublicKey({
    key: Buffer.from(encoded, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `a screen ticket key must be ed25519, not ${key.asymmetricKeyType ?? 'unknown'}`,
    );
  }
  return key;
}

export function signScreenTicket(claims: ScreenTicketClaims, privateKey: KeyObject): string {
  // Parsed on the way out as well as in: a claim the verifier would refuse is
  // a bug here, and failing at the signer names it.
  const body = Buffer.from(JSON.stringify(ScreenTicketClaimsSchema.parse(claims))).toString(
    'base64url',
  );
  const signature = sign(null, Buffer.from(body, 'ascii'), privateKey).toString('base64url');
  return `${body}.${signature}`;
}

export type ScreenTicketVerdict =
  | { readonly ok: true; readonly claims: ScreenTicketClaims }
  | { readonly ok: false; readonly reason: string };

/**
 * Check a ticket's signature, shape and expiry. Says why it refused, for the
 * log line; a caller never tells the viewer more than "unauthorized".
 */
export function verifyScreenTicket(
  ticket: string,
  publicKey: KeyObject,
  now: number = Date.now(),
): ScreenTicketVerdict {
  if (ticket.length === 0 || ticket.length > SCREEN_TICKET_MAX_LENGTH) {
    return { ok: false, reason: 'ticket is empty or too long' };
  }
  const parts = ticket.split('.');
  const [body, signature] = parts;
  if (parts.length !== 2 || body === undefined || signature === undefined) {
    return { ok: false, reason: 'ticket is not two parts' };
  }
  let signed: boolean;
  try {
    signed = verify(
      null,
      Buffer.from(body, 'ascii'),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    signed = false;
  }
  if (!signed) return { ok: false, reason: 'ticket signature does not verify' };

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'ticket body is not JSON' };
  }
  const claims = ScreenTicketClaimsSchema.safeParse(decoded);
  if (!claims.success) return { ok: false, reason: 'ticket claims are malformed' };
  if (claims.data.exp <= now) return { ok: false, reason: 'ticket has expired' };
  return { ok: true, claims: claims.data };
}

/**
 * Remembers every ticket used until it expires, so each opens one stream once.
 * A ticket is in a URL, and URLs end up in logs and histories; a replayed one
 * should open nothing.
 */
export class ScreenTicketReplayGuard {
  private readonly used = new Map<string, number>();

  /** True the first time a live ticket is presented; false on every replay. */
  claim(claims: ScreenTicketClaims, now: number = Date.now()): boolean {
    for (const [jti, exp] of this.used) {
      if (exp <= now) this.used.delete(jti);
    }
    if (this.used.has(claims.jti)) return false;
    this.used.set(claims.jti, claims.exp);
    return true;
  }
}
