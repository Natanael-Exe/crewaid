import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { SINGLETON_USER_ID } from '../src/auth/singleton-user.js';

/**
 * Seeds the development account (PRD §3, R7).
 *
 * ── THE "EXACTLY ONE USER" CHECK IS GONE, ON PURPOSE ────────────────────────
 *
 * It used to throw when the database held a second row, and that was a live
 * guard while `AuthGuard` resolved every request to one hardcoded Principal:
 * a second User meant a suite had leaked one, and CI caught real leaks that
 * way. V1-08 ended the premise. Sessions resolve to their own owner, so a
 * second account is the product working rather than a defect, and a check that
 * refuses one would fail the first time anybody signed up.
 *
 * What it cost to keep even this long is worth recording: it was the last
 * thing in CI that still asserted the single-user world, and it failed the
 * V1-08 branch after every other step had passed — the tests that now create
 * their own users had left nine rows behind, which is exactly correct.
 *
 * This row is a FIXTURE, not an authentication decision: a fresh checkout
 * needs an account to sign in as. The §4.2 socket still resolves to it until
 * V1-09 (see `singleton-user.ts`), which is the last thing that treats it as
 * special.
 *
 * Idempotent: safe to run on every `migrate deploy`.
 */

function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is required to seed. See infra/compose/.env.example.');
  }
  return url;
}

/**
 * `email` is unique and non-null now, so the seed needs a real address rather
 * than the optional one §3's nullable column allowed. A default is supplied
 * rather than made required: a developer running `db:seed` for the first time
 * should not have to discover a new mandatory variable, and the address is
 * obviously local.
 */
const DEFAULT_SEED_EMAIL = 'dev@crewaid.localhost';

async function main(): Promise<void> {
  const adapter = new PrismaPg({ connectionString: requireDatabaseUrl() });
  const prisma = new PrismaClient({ adapter });

  try {
    const configured = process.env['SEED_USER_EMAIL'];
    const email = configured === undefined || configured === '' ? DEFAULT_SEED_EMAIL : configured;

    const user = await prisma.user.upsert({
      where: { id: SINGLETON_USER_ID },
      // Deliberately empty: re-seeding must not overwrite an address someone
      // set, or reset `emailVerified` on an account that has since signed in.
      update: {},
      create: {
        id: SINGLETON_USER_ID,
        name: 'Crewaid Developer',
        email,
        emailVerified: true,
      },
    });

    console.log(`Seeded development user: ${user.id} <${user.email}>`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
