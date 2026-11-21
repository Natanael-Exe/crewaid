import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CredentialService } from '../src/credentials/credential.service.js';
import { CredentialDecryptError } from '../src/credentials/credential-cipher.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const DATABASE_URL = process.env['DATABASE_URL'];

const KEY_1 = '1'.repeat(64);
const KEY_2 = '2'.repeat(64);

/**
 * V1-03 — the vault against a real database, with a real second user.
 *
 * `credential-cipher.test.ts` proves the crypto. What it cannot prove is that
 * the SERVICE scopes every read and write by owner: that lives in the `where`
 * clause, and a test with one user in the database passes whether the clause
 * is there or not. So this suite always has two.
 */
describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'CredentialService (real database)',
  () => {
    let prisma: PrismaService;
    let credentials: CredentialService;

    const owner = `cred-owner-${randomUUID()}`;
    const other = `cred-other-${randomUUID()}`;
    let ownerConnection: string;
    let otherConnection: string;

    function withKeyring(json: Record<number, string>, active?: number): void {
      process.env['CREWAID_CREDENTIAL_KEYRING'] = JSON.stringify(json);
      if (active === undefined) delete process.env['CREWAID_CREDENTIAL_KEY_ACTIVE'];
      else process.env['CREWAID_CREDENTIAL_KEY_ACTIVE'] = String(active);
      credentials.resetKeyringForTests();
    }

    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
      credentials = new CredentialService(prisma);

      for (const [id, label] of [
        [owner, 'Owner'],
        [other, 'Other'],
      ] as const) {
        await prisma.user.create({
          data: { id, name: label, email: `${id}@test.invalid` },
        });
      }

      ownerConnection = (
        await prisma.providerConnection.create({
          data: { userId: owner, kind: 'OPENAI', name: 'owner openai' },
        })
      ).id;
      otherConnection = (
        await prisma.providerConnection.create({
          data: { userId: other, kind: 'OPENAI', name: 'other openai' },
        })
      ).id;
    });

    beforeEach(() => {
      withKeyring({ 1: KEY_1 });
    });

    afterAll(async () => {
      await prisma.providerConnection.deleteMany({ where: { userId: { in: [owner, other] } } });
      await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
      delete process.env['CREWAID_CREDENTIAL_KEYRING'];
      delete process.env['CREWAID_CREDENTIAL_KEY_ACTIVE'];
      await prisma.$disconnect();
    });

    it('stores a key and reads it back for its owner', async () => {
      expect(await credentials.setCredential(owner, ownerConnection, 'sk-owner-key')).toBe(true);
      expect(await credentials.credentialFor(owner, ownerConnection)).toBe('sk-owner-key');
    });

    it('moves the connection to ACTIVE when a key lands, and back when it goes', async () => {
      // D-084: having a key is what makes a connection usable, so the state
      // travels with the credential rather than waiting for a caller to
      // remember to set it.
      await credentials.setCredential(owner, ownerConnection, 'sk-owner-key');
      expect(
        (await prisma.providerConnection.findUnique({ where: { id: ownerConnection } }))?.state,
      ).toBe('ACTIVE');

      expect(await credentials.clearCredential(owner, ownerConnection)).toBe(true);
      const cleared = await prisma.providerConnection.findUnique({
        where: { id: ownerConnection },
      });
      expect(cleared?.state).toBe('NEEDS_CREDENTIAL');
      expect(cleared?.credentialCiphertext).toBeNull();
      expect(cleared?.credentialKeyVersion).toBeNull();
      expect(cleared?.credentialSetAt).toBeNull();
    });

    it('never stores the plaintext in the column — R7/D-083', async () => {
      await credentials.setCredential(owner, ownerConnection, 'sk-plaintext-canary');
      const row = await prisma.providerConnection.findUnique({ where: { id: ownerConnection } });
      expect(row?.credentialCiphertext).not.toBeNull();
      expect(row?.credentialCiphertext).not.toContain('sk-plaintext-canary');
    });

    describe('owner scoping', () => {
      beforeEach(async () => {
        await credentials.setCredential(owner, ownerConnection, 'sk-owner-key');
        await credentials.setCredential(other, otherConnection, 'sk-other-key');
      });

      it('refuses to read another user’s connection', async () => {
        // Asserted against a PRESENCE: the other user's credential exists and
        // is readable by them, so this null means the scope refused it rather
        // than there being nothing to find.
        expect(await credentials.credentialFor(other, otherConnection)).toBe('sk-other-key');
        expect(await credentials.credentialFor(owner, otherConnection)).toBeNull();
      });

      it('refuses to write another user’s connection', async () => {
        expect(await credentials.setCredential(owner, otherConnection, 'sk-stolen')).toBe(false);
        expect(await credentials.credentialFor(other, otherConnection)).toBe('sk-other-key');
      });

      it('refuses to clear another user’s connection', async () => {
        expect(await credentials.clearCredential(owner, otherConnection)).toBe(false);
        expect(await credentials.credentialFor(other, otherConnection)).toBe('sk-other-key');
      });

      it('answers the same way for an absent id as for a foreign one', async () => {
        // Following bots.service.ts: the response must not be usable to
        // discover which connection ids exist.
        expect(await credentials.credentialFor(owner, 'conn_does_not_exist')).toBeNull();
        expect(await credentials.setCredential(owner, 'conn_does_not_exist', 'sk-x')).toBe(false);
      });

      it('refuses a ciphertext moved between two users’ rows in the database', async () => {
        // The attack the AAD exists for, executed as a database write rather
        // than as a unit-test argument: copy the row's stored bytes into
        // someone else's row and ask for the key.
        const stolen = await prisma.providerConnection.findUnique({
          where: { id: otherConnection },
          select: { credentialCiphertext: true, credentialKeyVersion: true },
        });
        await prisma.providerConnection.update({
          where: { id: ownerConnection },
          data: {
            credentialCiphertext: stolen!.credentialCiphertext,
            credentialKeyVersion: stolen!.credentialKeyVersion,
          },
        });
        await expect(credentials.credentialFor(owner, ownerConnection)).rejects.toThrow(
          CredentialDecryptError,
        );
      });
    });

    describe('rotation', () => {
      beforeEach(async () => {
        withKeyring({ 1: KEY_1 });
        await credentials.setCredential(owner, ownerConnection, 'sk-rotating');
        await credentials.setCredential(other, otherConnection, 'sk-other-rotating');
      });

      it('re-wraps this user’s rows and leaves the other user’s alone', async () => {
        withKeyring({ 1: KEY_1, 2: KEY_2 }, 2);
        const result = await credentials.rotate(owner);
        expect(result).toEqual({ rotated: 1, skipped: 0, failed: 0 });

        const mine = await prisma.providerConnection.findUnique({ where: { id: ownerConnection } });
        expect(mine?.credentialKeyVersion).toBe(2);
        expect(await credentials.credentialFor(owner, ownerConnection)).toBe('sk-rotating');

        const theirs = await prisma.providerConnection.findUnique({
          where: { id: otherConnection },
        });
        expect(theirs?.credentialKeyVersion, 'rotation crossed an owner boundary').toBe(1);
        expect(await credentials.credentialFor(other, otherConnection)).toBe('sk-other-rotating');
      });

      it('is idempotent, so an interrupted pass can simply be re-run', async () => {
        withKeyring({ 1: KEY_1, 2: KEY_2 }, 2);
        expect((await credentials.rotate(owner)).rotated).toBe(1);
        expect(await credentials.rotate(owner)).toEqual({ rotated: 0, skipped: 1, failed: 0 });
      });

      it('counts a damaged row instead of abandoning the pass', async () => {
        // One unreadable row must not stop the rotation for the rest, and the
        // count is how an operator learns something needs attention.
        const damaged = await prisma.providerConnection.create({
          data: {
            userId: owner,
            kind: 'CUSTOM',
            name: 'damaged',
            endpoint: 'https://example.invalid/v1',
            credentialCiphertext: 'g1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA',
            credentialKeyVersion: 1,
            credentialSetAt: new Date(),
            state: 'ACTIVE',
          },
        });

        withKeyring({ 1: KEY_1, 2: KEY_2 }, 2);
        const result = await credentials.rotate(owner);
        expect(result.failed).toBe(1);
        expect(result.rotated).toBe(1);
        // The good row still moved.
        expect(await credentials.credentialFor(owner, ownerConnection)).toBe('sk-rotating');

        await prisma.providerConnection.delete({ where: { id: damaged.id } });
      });

      it('leaves a row readable while both versions are in the ring', async () => {
        withKeyring({ 1: KEY_1, 2: KEY_2 }, 2);
        // Not yet rotated, still on version 1, and still readable — which is
        // what makes a rotation something other than a flag day.
        expect(await credentials.credentialFor(owner, ownerConnection)).toBe('sk-rotating');
      });

      it('does not revert a key that was replaced after the pass read it', async () => {
        // The pass reads every row in ONE query and then re-wraps them one at
        // a time, so there is a window between the read and each write. A
        // `setCredential` landing in that window must not be undone by the
        // re-wrap of the value the pass happens to be holding.
        //
        // Driven deterministically rather than by timing: the service is given
        // a Prisma whose `findMany` answers with the ciphertext as it was
        // BEFORE the replacement, which is exactly the stale view a real
        // interleaving produces. Every other call goes to the real database.
        withKeyring({ 1: KEY_1 });
        await credentials.setCredential(owner, ownerConnection, 'sk-before');
        const stale = await prisma.providerConnection.findFirstOrThrow({
          where: { id: ownerConnection },
          select: { id: true, credentialCiphertext: true, credentialKeyVersion: true },
        });

        await credentials.setCredential(owner, ownerConnection, 'sk-after');

        withKeyring({ 1: KEY_1, 2: KEY_2 }, 2);
        const stalePrisma = {
          ...prisma,
          providerConnection: {
            ...prisma.providerConnection,
            findMany: async () => [stale],
            updateMany: (args: Parameters<typeof prisma.providerConnection.updateMany>[0]) =>
              prisma.providerConnection.updateMany(args),
          },
        } as unknown as PrismaService;
        const racing = new CredentialService(stalePrisma);
        racing.resetKeyringForTests();

        const result = await racing.rotate(owner);

        // The stale re-wrap matched nothing, so it is counted as skipped
        // rather than reported as work done.
        expect(await credentials.credentialFor(owner, ownerConnection)).toBe('sk-after');
        expect(result).toEqual({ rotated: 0, skipped: 1, failed: 0 });
      });
    });
  },
);
