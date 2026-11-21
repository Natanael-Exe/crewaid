import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { ScreenTicketClaims } from '@crewaid/shared';
import {
  exportScreenTicketPublicKey,
  generateScreenTicketKeys,
  importScreenTicketPublicKey,
  ScreenTicketReplayGuard,
  signScreenTicket,
  verifyScreenTicket,
} from './screen-ticket.js';

const NOW = 1_791_900_000_000;

const claims = (overrides: Partial<ScreenTicketClaims> = {}): ScreenTicketClaims => ({
  v: 1,
  aud: 'crewaid-screen',
  session: 'session-1',
  botId: 'clx9z8y7x6w5v4u3t2s1r0q9',
  port: 5901,
  exp: NOW + 60_000,
  jti: 'a1b2c3d4e5f6',
  ...overrides,
});

describe('screen tickets', () => {
  const keys = generateScreenTicketKeys();

  it('verifies a ticket it signed, returning the claims', () => {
    const verdict = verifyScreenTicket(
      signScreenTicket(claims(), keys.privateKey),
      keys.publicKey,
      NOW,
    );
    expect(verdict).toEqual({ ok: true, claims: claims() });
  });

  it('verifies with a public key that travelled as text', () => {
    // The computer only ever holds the public half, delivered as a string.
    const travelled = importScreenTicketPublicKey(exportScreenTicketPublicKey(keys.publicKey));
    expect(verifyScreenTicket(signScreenTicket(claims(), keys.privateKey), travelled, NOW).ok).toBe(
      true,
    );
  });

  it('refuses an expired ticket', () => {
    const ticket = signScreenTicket(claims({ exp: NOW }), keys.privateKey);
    expect(verifyScreenTicket(ticket, keys.publicKey, NOW)).toEqual({
      ok: false,
      reason: 'ticket has expired',
    });
  });

  it('refuses a ticket whose claims were changed after signing', () => {
    const [, signature] = signScreenTicket(claims(), keys.privateKey).split('.');
    // Another seat's port: exactly what an edited ticket would try.
    const forged = Buffer.from(JSON.stringify(claims({ port: 5902 }))).toString('base64url');
    expect(verifyScreenTicket(`${forged}.${signature}`, keys.publicKey, NOW).ok).toBe(false);
  });

  it('refuses a ticket signed by another key', () => {
    const other = generateScreenTicketKeys();
    const ticket = signScreenTicket(claims(), other.privateKey);
    expect(verifyScreenTicket(ticket, keys.publicKey, NOW)).toEqual({
      ok: false,
      reason: 'ticket signature does not verify',
    });
  });

  it.each(['', 'one-part', 'a.b.c', `${'x'.repeat(5000)}.y`])('refuses %j', (ticket) => {
    expect(verifyScreenTicket(ticket, keys.publicKey, NOW).ok).toBe(false);
  });

  it('refuses to sign claims a verifier would reject', () => {
    expect(() =>
      signScreenTicket({ ...claims(), aud: 'crewaid-chat' } as never, keys.privateKey),
    ).toThrow();
  });

  it('refuses a public key of another kind', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const encoded = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
    expect(() => importScreenTicketPublicKey(encoded)).toThrow(/ed25519/);
  });

  it('opens one stream per ticket: a replay is refused until it would have expired', () => {
    const guard = new ScreenTicketReplayGuard();
    const ticket = claims();
    expect(guard.claim(ticket, NOW)).toBe(true);
    expect(guard.claim(ticket, NOW + 1)).toBe(false);
    expect(guard.claim(claims({ jti: 'f6e5d4c3b2a1' }), NOW + 1)).toBe(true);
  });
});
