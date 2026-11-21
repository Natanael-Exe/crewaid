import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * How a Prisma client is wired, in one place.
 *
 * Two callers need it: `PrismaService`, which is the only client Crewaid's own
 * services touch, and `auth/better-auth.ts`, whose adapter is imported by the
 * Better Auth CLI outside any Nest context. Neither may guess at the wiring,
 * because getting it wrong fails identically to a missing migration — Prisma 7
 * refuses to construct without a driver adapter, and its error names the
 * adapter rather than the caller that forgot one.
 *
 * This is a factory, not a second pool: `PrismaService` remains the single
 * client for orchestration code, which is what R7 and the D-010 allowlist
 * assume when they audit call sites.
 */
export function prismaClientOptions(): ConstructorParameters<typeof PrismaClient>[0] {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    // Fail loudly at boot rather than at first query.
    throw new Error('DATABASE_URL is required. See infra/compose/.env.example.');
  }
  // Prisma's CLI reads `?schema=` from its datasource URL, but the pg driver
  // adapter requires the schema as a separate option. Keep migrations and
  // runtime queries on the same schema, including isolated E2E runs.
  const schema = new URL(url).searchParams.get('schema') ?? undefined;
  return {
    adapter: new PrismaPg({ connectionString: url }, schema === undefined ? undefined : { schema }),
  };
}

/** A standalone client for the one caller that cannot use `PrismaService`. */
export function createPrismaClient(): PrismaClient {
  return new PrismaClient(prismaClientOptions());
}
