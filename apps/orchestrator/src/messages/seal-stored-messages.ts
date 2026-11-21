import type { PrismaClient } from '@prisma/client';
import {
  MessageDecryptError,
  SEALED_PREFIX,
  openJson,
  openText,
  sealJson,
  sealText,
  sealedVersion,
  type SealableJson,
} from '../credentials/message-cipher.js';
import type { Keyring } from '../credentials/keyring.js';

/**
 * Seal what is already stored.
 *
 * New writes are sealed as they are made. This is for the rows that were not:
 * messages and run events written before sealing existed, or while no keyring
 * was configured, and — after a key rotation — rows still sealed under a
 * version that is no longer the active one. One pass leaves every row under
 * the active key, so the old key can then be retired.
 *
 * It takes a client WITHOUT the sealing extension, because it has to see what
 * is stored rather than what it means.
 *
 * Safe to run beside a serving orchestrator and safe to run twice: each row is
 * replaced only if it still holds exactly what was read, so a reply being
 * written at the same moment keeps its newer text and is picked up by the next
 * pass, and a row already under the active key is not selected at all.
 *
 * A row that will not open — sealed under a key that is no longer in the ring
 * — is counted and left as it is. One such row must not stop every other row
 * from being sealed, and the count is what tells an operator a key was
 * retired too early.
 */

const BATCH = 500;

export type SealStoredResult = {
  readonly messages: number;
  readonly runEvents: number;
  /** Rows sealed under a key the ring no longer holds; left untouched. */
  readonly unreadable: number;
};

export async function sealStoredMessages(
  prisma: PrismaClient,
  keyring: Keyring,
): Promise<SealStoredResult> {
  const current = `${SEALED_PREFIX}${String(keyring.activeVersion)}.%`;
  let messages = 0;
  let unreadable = 0;
  for (let after = 0; ;) {
    const rows = await prisma.$queryRaw<
      { id: string; sequence: number; content: string; parts: unknown }[]
    >`
      SELECT id, sequence, content, parts FROM "Message"
      WHERE sequence > ${after}
        AND ((content <> '' AND content NOT LIKE ${current})
          OR (parts IS NOT NULL
            AND (jsonb_typeof(parts) <> 'string' OR parts #>> '{}' NOT LIKE ${current})))
      ORDER BY sequence ASC
      LIMIT ${BATCH}
    `;
    if (rows.length === 0) break;
    for (const row of rows) {
      let content: string;
      let parts: unknown;
      try {
        content = isCurrent(row.content, keyring)
          ? row.content
          : sealText(openText(row.content, 'message.content', keyring), 'message.content', keyring);
        parts =
          row.parts === null || isCurrent(row.parts, keyring)
            ? row.parts
            : sealJson(
                openJson(row.parts, 'message.parts', keyring) as SealableJson,
                'message.parts',
                keyring,
              );
      } catch (error: unknown) {
        if (!(error instanceof MessageDecryptError)) throw error;
        unreadable += 1;
        continue;
      }
      if (content === row.content && parts === row.parts) continue;
      messages += await prisma.$executeRaw`
        UPDATE "Message"
        SET content = ${content}, parts = ${jsonb(parts)}::jsonb
        WHERE id = ${row.id} AND content = ${row.content}
          AND parts IS NOT DISTINCT FROM ${jsonb(row.parts)}::jsonb
      `;
    }
    after = rows.at(-1)?.sequence ?? after;
  }

  let runEvents = 0;
  for (let after = 0n; ;) {
    const rows = await prisma.$queryRaw<{ id: bigint; chunk: unknown }[]>`
      SELECT id, chunk FROM "RunEvent"
      WHERE id > ${after}
        AND (jsonb_typeof(chunk) <> 'string' OR chunk #>> '{}' NOT LIKE ${current})
      ORDER BY id ASC
      LIMIT ${BATCH}
    `;
    if (rows.length === 0) break;
    for (const row of rows) {
      let chunk: string;
      try {
        chunk = sealJson(
          openJson(row.chunk, 'runEvent.chunk', keyring) as SealableJson,
          'runEvent.chunk',
          keyring,
        );
      } catch (error: unknown) {
        if (!(error instanceof MessageDecryptError)) throw error;
        unreadable += 1;
        continue;
      }
      runEvents += await prisma.$executeRaw`
        UPDATE "RunEvent" SET chunk = ${jsonb(chunk)}::jsonb
        WHERE id = ${row.id} AND chunk = ${jsonb(row.chunk)}::jsonb
      `;
    }
    after = rows.at(-1)?.id ?? after;
  }
  return { messages, runEvents, unreadable };
}

function isCurrent(stored: unknown, keyring: Keyring): boolean {
  return sealedVersion(stored) === keyring.activeVersion;
}

/** A `jsonb` parameter as text; SQL NULL for a column that holds none. */
function jsonb(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}
