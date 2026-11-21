import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CredentialDecryptError,
  decryptCredential,
  encryptCredential,
  rotateCredential,
} from './credential-cipher.js';
import { parseKeyring, type Keyring } from './keyring.js';

/**
 * The only thing in the orchestrator that can read a provider credential.
 *
 * THE CAPABILITY LIVES HERE AND NOWHERE ELSE. Inference code does not
 * decrypt a database column and does not read an environment secret; it asks
 * this service, scoped to an owner. That is what makes the R7 audit surface
 * one file rather than every call site that happens to need a key — and it is
 * why `reveal` does not exist: nothing outside a provider call ever needs the
 * plaintext, so there is no method to misuse.
 *
 * Every method takes `userId` FIRST and puts it in the `where` clause. A
 * connection id alone is not authorisation: it is a cuid an attacker can
 * guess at, and D-010 closed ten routes that had made exactly that assumption.
 */
@Injectable()
export class CredentialService {
  private keyringCache: Keyring | undefined;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Parsed on first use, not in the constructor.
   *
   * Unlike `AuthGuard`, which must fail at boot because an orchestrator that
   * cannot authenticate is useless, an orchestrator with no keyring is
   * perfectly able to serve chat history, sandboxes and the settings pages
   * where an operator would go to FIX the configuration. Throwing at boot
   * would take all of that down to report a variable, and the error an
   * operator would see is a process that exits rather than a settings page
   * saying what is missing.
   */
  private keyring(): Keyring {
    this.keyringCache ??= parseKeyring();
    return this.keyringCache;
  }

  /** Test seam: drop the cached keyring so a case can supply fresh env. */
  resetKeyringForTests(): void {
    this.keyringCache = undefined;
  }

  /** The version new writes land under — what a rotation pass compares against. */
  activeKeyVersion(): number {
    return this.keyring().activeVersion;
  }

  /**
   * Store a credential for a connection this user owns.
   *
   * Returns false when the connection is absent OR foreign — the same answer
   * for both, following `bots.service.ts`, so the response cannot be used to
   * discover which connection ids exist.
   */
  async setCredential(userId: string, connectionId: string, plaintext: string): Promise<boolean> {
    const trimmed = plaintext.trim();
    if (trimmed === '') return false;

    const { ciphertext, keyVersion } = encryptCredential(
      trimmed,
      { userId, connectionId },
      this.keyring(),
    );

    // updateMany rather than update: `update` takes a unique where, which
    // would mean looking the row up by id alone and checking the owner
    // afterwards. This way the ownership is IN the write — a row that is not
    // this user's matches nothing and updates nothing.
    const result = await this.prisma.providerConnection.updateMany({
      where: { id: connectionId, userId },
      data: {
        credentialCiphertext: ciphertext,
        credentialKeyVersion: keyVersion,
        credentialSetAt: new Date(),
        // Having a key is what makes a connection usable, so the state
        // moves with the credential rather than being set separately by
        // whichever caller remembers to.
        state: 'ACTIVE',
      },
    });
    return result.count === 1;
  }

  /**
   * Remove a credential. The connection stays; its models become unavailable.
   *
   * This is the revocation path, so it is never refused for a reference the
   * way deleting a model or a connection is. Someone removing a
   * leaked key must not be told to go and repoint three bots first.
   */
  async clearCredential(userId: string, connectionId: string): Promise<boolean> {
    const result = await this.prisma.providerConnection.updateMany({
      where: { id: connectionId, userId },
      data: {
        credentialCiphertext: null,
        credentialKeyVersion: null,
        credentialSetAt: null,
        state: 'NEEDS_CREDENTIAL',
      },
    });
    return result.count === 1;
  }

  /**
   * The plaintext key for a connection this user owns, for a provider call.
   *
   * Returns null when the connection is absent, foreign, or has no credential.
   * Throws `CredentialDecryptError` when a credential IS stored and cannot be
   * read — those are different situations and the caller must not conflate
   * them: the first is "add a key", the second is "this row is damaged or the
   * keyring is wrong", and reporting the second as the first sends an operator
   * to re-enter a key that was already correct.
   */
  async credentialFor(userId: string, connectionId: string): Promise<string | null> {
    const row = await this.prisma.providerConnection.findFirst({
      where: { id: connectionId, userId },
      select: { id: true, credentialCiphertext: true, credentialKeyVersion: true },
    });
    if (row === null) return null;
    if (row.credentialCiphertext === null || row.credentialKeyVersion === null) return null;

    return decryptCredential(
      row.credentialCiphertext,
      row.credentialKeyVersion,
      { userId, connectionId },
      this.keyring(),
    );
  }

  /**
   * Re-wrap this user's credentials under the active key version.
   *
   * Row by row, and idempotent: a row already on the active version is skipped
   * rather than rewritten, so an interrupted pass can simply be run again.
   * A row that cannot be decrypted is COUNTED AND SKIPPED rather than thrown
   * on — one damaged row must not stop the rotation for the rest, and the
   * count is what tells an operator that something needs attention without
   * telling them which key it was.
   */
  async rotate(userId: string): Promise<{ rotated: number; skipped: number; failed: number }> {
    const keyring = this.keyring();
    const rows = await this.prisma.providerConnection.findMany({
      where: { userId, credentialCiphertext: { not: null } },
      select: { id: true, credentialCiphertext: true, credentialKeyVersion: true },
    });

    let rotated = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of rows) {
      if (row.credentialCiphertext === null || row.credentialKeyVersion === null) {
        skipped += 1;
        continue;
      }
      let next: { ciphertext: string; keyVersion: number } | null;
      try {
        next = rotateCredential(
          row.credentialCiphertext,
          row.credentialKeyVersion,
          { userId, connectionId: row.id },
          keyring,
        );
      } catch (error: unknown) {
        if (error instanceof CredentialDecryptError) {
          failed += 1;
          continue;
        }
        throw error;
      }
      if (next === null) {
        skipped += 1;
        continue;
      }
      // Compare-and-swap on the ciphertext we actually read. The rows were
      // read in one query and are re-wrapped one at a time, so a `setCredential`
      // landing in that window would otherwise be silently reverted: the new
      // key is overwritten by the OLD one re-wrapped under the new version,
      // and `credentialSetAt` still shows the newer write, so nothing about
      // the row says it happened. Matching on the prior ciphertext makes the
      // stale write update nothing.
      const swapped = await this.prisma.providerConnection.updateMany({
        where: { id: row.id, userId, credentialCiphertext: row.credentialCiphertext },
        data: { credentialCiphertext: next.ciphertext, credentialKeyVersion: next.keyVersion },
      });
      if (swapped.count === 1) {
        rotated += 1;
      } else {
        // Changed underneath us. The new value is already under the active
        // version — `setCredential` always writes there — so there is nothing
        // to redo.
        skipped += 1;
      }
    }

    return { rotated, skipped, failed };
  }
}
