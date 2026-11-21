import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import type { PrismaClient } from '@prisma/client';

/** Better Auth's own bounds, which sign-up enforces. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordResetResult =
  | { readonly status: 'changed'; readonly sessionsEnded: number }
  | { readonly status: 'no-account' }
  | { readonly status: 'invalid-password' };

/**
 * Give an account a new password and end its sessions.
 *
 * The operator path for a self-hosted server, which has no mail service to
 * send a reset link with: `src/cli/reset-password.ts` is its only caller. The
 * hash is Better Auth's own (`better-auth/crypto`), the one sign-in verifies.
 * Every session is revoked in the same transaction, so a password reset after
 * a lost laptop stops that laptop's session at once.
 */
export async function resetPassword(
  prisma: PrismaClient,
  email: string,
  password: string,
): Promise<PasswordResetResult> {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return { status: 'invalid-password' };
  }
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { id: true },
  });
  if (user === null) return { status: 'no-account' };

  const hash = await hashPassword(password);
  const sessionsEnded = await prisma.$transaction(async (tx) => {
    // One credential row per user, the one email sign-up made; created if
    // missing, so an account that predates passwords can be given one.
    const existing = await tx.account.findFirst({
      where: { userId: user.id, providerId: 'credential' },
      select: { id: true },
    });
    if (existing === null) {
      await tx.account.create({
        data: {
          id: randomUUID(),
          accountId: user.id,
          providerId: 'credential',
          userId: user.id,
          password: hash,
        },
      });
    } else {
      await tx.account.update({ where: { id: existing.id }, data: { password: hash } });
    }
    return (await tx.session.deleteMany({ where: { userId: user.id } })).count;
  });
  return { status: 'changed', sessionsEnded };
}
