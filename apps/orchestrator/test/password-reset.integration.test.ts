import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth } from '../src/auth/better-auth.js';
import { resetPassword } from '../src/auth/password-reset.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * D-155 — the self-hosted operator's password reset, against a real database
 * and the real Better Auth sign-in: the new password works, the old one does
 * not, and the account's sessions are gone.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const auth = createAuth('selfhosted');
const BASE = `${new URL(process.env['BETTER_AUTH_URL'] ?? 'http://localhost:3000').origin}${auth.options.basePath}`;
const ORIGIN = new URL(BASE).origin;

function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return auth.handler(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(body),
    }),
  );
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'D-155 — resetting a password on a self-hosted server',
  () => {
    let prisma: PrismaService;
    const emails: string[] = [];

    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
    });

    afterAll(async () => {
      if (emails.length > 0) await prisma.user.deleteMany({ where: { email: { in: emails } } });
      await prisma.$disconnect();
    });

    it('replaces the password, so only the new one signs in, and ends every session', async () => {
      const email = `d155_${randomUUID().slice(0, 8)}@test.invalid`;
      emails.push(email);
      expect(
        (await post('/sign-up/email', { name: 'Ada', email, password: 'old-password-1' })).status,
      ).toBe(200);
      const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
      expect(await prisma.session.count({ where: { userId: user.id } })).toBeGreaterThan(0);

      // Mixed case and spaces: the address as an operator might type it.
      const result = await resetPassword(prisma, `  ${email.toUpperCase()} `, 'new-password-2');
      expect(result).toMatchObject({ status: 'changed' });
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);

      expect((await post('/sign-in/email', { email, password: 'old-password-1' })).status).toBe(
        401,
      );
      expect((await post('/sign-in/email', { email, password: 'new-password-2' })).status).toBe(
        200,
      );
    });

    it('refuses an address with no account, and a password sign-up would refuse', async () => {
      await expect(
        resetPassword(prisma, `nobody_${randomUUID().slice(0, 8)}@test.invalid`, 'long-enough-1'),
      ).resolves.toEqual({ status: 'no-account' });
      await expect(resetPassword(prisma, 'x@test.invalid', 'short')).resolves.toEqual({
        status: 'invalid-password',
      });
    });
  },
);
