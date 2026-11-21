/**
 * The seeded development account's id.
 *
 * NOT A PRINCIPAL ANY MORE, on either transport. V1-08 made `AuthGuard`
 * resolve a Better Auth session, and V1-09 made the WebSocket handshake resolve one
 * too — so both HTTP requests and socket frames run as whoever signed in.
 * Nothing in `src/` reads this except the seed, and code reaching for it to
 * answer "who is this" would be running as the wrong person on any install
 * with more than one account.
 *
 * What it still is: the id `prisma/seed.ts` gives a fresh development
 * database, so a new checkout has an account to sign in as. A fixture, not an
 * authentication decision — which is why it survives rather than being
 * deleted, and why the name is now the only misleading thing about it.
 */
export const SINGLETON_USER_ID = 'usr_crewaid_singleton_v1';
