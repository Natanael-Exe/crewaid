import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * A signed-in user for a test (V1-08).
 *
 * `token` goes in `Authorization: Bearer <token>` exactly as the desktop sends
 * it. `userId` is who the orchestrator will resolve that to, so a suite owns
 * its fixture rows with it rather than with a shared constant.
 */
export type SignedInUser = {
  readonly userId: string;
  readonly token: string;
  /** Ready to spread into supertest: `.set(actor.headers)`. */
  readonly headers: { readonly Authorization: string };
};

/**
 * Create a real `User` with a real `Session`, and hand back its bearer token.
 *
 * ── WHY THE ROWS ARE WRITTEN DIRECTLY ───────────────────────────────────────
 *
 * The alternative is to drive a real sign-in, and every way in goes outside
 * the process: Google and GitHub need an identity provider, and a magic link
 * needs Resend to deliver mail a test would then have to read. A suite about
 * bot ownership must not need a mail provider to be reachable.
 *
 * This is not a shortcut around the auth check — it is the same row a real
 * sign-in writes, and the guard validates it through the same
 * `auth.api.getSession` path with no test-only branch anywhere. What it does
 * NOT cover is the sign-in flow itself: callbacks, single-use links, replay.
 * That is V1-15's subject, and it needs the real endpoints rather than this.
 *
 * ── WHY THE TOKEN IS THE RAW ROW VALUE ──────────────────────────────────────
 *
 * Better Auth's bearer plugin accepts an unsigned token and signs it itself
 * before converting it into the session cookie it looks up (its `before` hook
 * calls `serializeSignedCookie` when the value carries no `.`). So the exact
 * string in `Session.token` is what a client sends — which is also what makes
 * a revocation test a one-row delete.
 *
 * V1-08 needed an `asUserId` option here so the socket-driven suites could
 * borrow the singleton, because the §4.2 gateway still resolved every frame to
 * it. V1-09 gave the socket the connection's own principal, so the borrow went
 * with it and every suite signs in as itself.
 */
export async function signIn(
  prisma: PrismaService,
  options: { readonly label?: string } = {},
): Promise<SignedInUser> {
  // Unique per call, not per suite: two users in one suite is the shape V1-14
  // asserts isolation with, and a fixture that quietly reuses one user would
  // make those cases pass for the wrong reason.
  const unique = randomUUID();
  const label = options.label ?? 'actor';
  const userId = `usr_test_${label}_${unique.slice(0, 12)}`;

  await prisma.user.create({
    data: {
      id: userId,
      name: `Test ${label}`,
      // @unique, so it carries the same uuid rather than the label alone —
      // otherwise the second suite to use a label fails on a constraint that
      // says nothing about what it was doing.
      email: `${userId}@test.invalid`,
      emailVerified: true,
    },
  });

  const token = `sess_${unique}${randomUUID().replace(/-/g, '')}`;
  await prisma.session.create({
    data: {
      id: `ses_${unique}`,
      token,
      userId,
      // Far enough out that a slow suite cannot expire mid-run. Expiry IS
      // asserted, by the case that sets it in the past on purpose.
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return { userId, token, headers: { Authorization: `Bearer ${token}` } };
}

/**
 * Remove a fixture user and, by cascade, its sessions.
 *
 * Bots, attachments and sandboxes cascade from `User` too, so a suite that
 * calls this in `afterAll` cleans up after itself — which the suites predating
 * V1-08 could not do, because they all shared one seeded user nobody could
 * delete. See the leftovers note in CLAUDE.md for what that accumulated into.
 */
export async function signOutAndDelete(prisma: PrismaService, userId: string): Promise<void> {
  await prisma.user.deleteMany({ where: { id: userId } });
}
