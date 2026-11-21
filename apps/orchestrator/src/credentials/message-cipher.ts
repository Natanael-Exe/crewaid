import { hkdfSync } from 'node:crypto';
import {
  CredentialDecryptError,
  decryptCredential,
  encryptCredential,
} from './credential-cipher.js';
import { KeyringConfigError, parseKeyring, type Keyring, type KeyVersion } from './keyring.js';

/**
 * Message text at rest.
 *
 * What a person and their bots say to each other is stored sealed: the
 * `Message` row's `content` and `parts`, and the run's delivery log
 * (`RunEvent.chunk`), which carries the same words a second time as the stream
 * that produced them. A copy of the database — a backup, a dump, a replica —
 * holds ciphertext for all three.
 *
 * Pure, like the credential cipher it is built on: a keyring in, a string out.
 * The Prisma layer that calls it is `prisma/message-sealing.ts`.
 *
 * The key is the keyring's, derived
 *
 * Messages are sealed under `CREWAID_CREDENTIAL_KEYRING`, the versioned ring
 * every deployment already has, so there is no second secret to lose and a
 * rotation covers both. They are not sealed under its keys directly: each
 * version's key goes through HKDF with a label of its own first, so a message
 * and a provider credential are never encrypted under the same key, and a
 * ciphertext from one cannot be offered to the other.
 *
 * The value says what it is
 *
 * A sealed value starts with `SEALED_PREFIX` and carries its key version, so
 * no column is added for either: a row written before this existed is read as
 * the plaintext it is, and one written under a retired version names the
 * version it needs. Empty and whitespace-only text is stored as itself. Rows
 * are selected on `content <> ''` in a dozen places, and "this row has no
 * text" says only that a turn called a tool.
 *
 * What a ciphertext is bound to
 *
 * The column, and the key version. Not the row: a message's id does not exist
 * when its `create` is built, and an `update` names the row by id alone. So a
 * writer inside the database could move a ciphertext between two rows of the
 * same column and it would open. This protects what a reader of the database
 * can learn, which is the promise; it does not make the database a witness.
 */

/** Leads every sealed value. Never the start of a JSON document or of ordinary prose. */
export const SEALED_PREFIX = 'cwsealed1.';

/** Which column a value belongs to; bound into the tag. */
export type SealedColumn = 'message.content' | 'message.parts' | 'runEvent.chunk';

/** Any JSON a `Json` column can hold, as Prisma hands it over. */
export type SealableJson = string | number | boolean | null | readonly unknown[] | object;

export class MessageDecryptError extends Error {
  readonly code = 'MESSAGE_DECRYPT' as const;
  constructor(reason: string) {
    // Names the class of failure and never the value, for the reason the
    // credential cipher gives: this text ends up in logs.
    super(`a stored message could not be read: ${reason}`);
    this.name = 'MessageDecryptError';
  }
}

const HKDF_LABEL = 'crewaid/message-at-rest/v1';
const KEY_BYTES = 32;

/** The ring messages are sealed under: each of `keyring`'s keys, derived for this purpose. */
export function deriveMessageKeyring(keyring: Keyring): Keyring {
  const derived = new Map<KeyVersion, Buffer>();
  return {
    activeVersion: keyring.activeVersion,
    versions: keyring.versions,
    keyFor: (version) => {
      const known = derived.get(version);
      if (known !== undefined) return known;
      const source = keyring.keyFor(version);
      if (source === undefined) return undefined;
      const key = Buffer.from(hkdfSync('sha256', source, Buffer.alloc(0), HKDF_LABEL, KEY_BYTES));
      derived.set(version, key);
      return key;
    },
  };
}

export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
}

/** The key version a sealed value was written under; null when it is not sealed. */
export function sealedVersion(value: unknown): KeyVersion | null {
  if (!isSealed(value)) return null;
  const version = Number(value.slice(SEALED_PREFIX.length).split('.', 1)[0]);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

/**
 * Seal text. Text that is empty or only whitespace comes back as it is: it
 * says nothing, and SQL that picks "the last thing actually said" tells such a
 * row from a spoken one by trimming it.
 *
 * Text that already starts with the prefix is sealed like any other: it is
 * something a person typed, and storing it as it came would leave a row that
 * claims to be ciphertext and opens under no key.
 */
export function sealText(plaintext: string, column: SealedColumn, keyring: Keyring): string {
  if (plaintext.trim() === '') return plaintext;
  const { ciphertext, keyVersion } = encryptCredential(plaintext, binding(column), keyring);
  return `${SEALED_PREFIX}${keyVersion}.${ciphertext}`;
}

/**
 * Open text. A value that is not sealed is returned as it is: a row from
 * before sealing, or one written where no keyring is configured.
 */
export function openText(stored: string, column: SealedColumn, keyring: Keyring | null): string {
  if (!isSealed(stored)) return stored;
  if (keyring === null) throw new MessageDecryptError('no keyring is configured');
  const rest = stored.slice(SEALED_PREFIX.length);
  const dot = rest.indexOf('.');
  const version = Number(rest.slice(0, dot));
  if (dot < 1 || !Number.isInteger(version) || version < 1) {
    throw new MessageDecryptError('unrecognised format');
  }
  try {
    return decryptCredential(rest.slice(dot + 1), version, binding(column), keyring);
  } catch (error: unknown) {
    if (!(error instanceof CredentialDecryptError)) throw error;
    // The cipher's sentence talks about a credential; the cause is the same four.
    throw new MessageDecryptError(error.message.replace(/^[^:]*: /, ''));
  }
}

/** Seal a JSON value as one string, which a `Json` column stores as a JSON string. */
export function sealJson(value: SealableJson, column: SealedColumn, keyring: Keyring): string {
  return sealText(JSON.stringify(value), column, keyring);
}

/** Open a `Json` column's value; anything but a sealed string is returned as it is. */
export function openJson(stored: unknown, column: SealedColumn, keyring: Keyring | null): unknown {
  if (!isSealed(stored)) return stored;
  const text = openText(stored, column, keyring);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MessageDecryptError('unrecognised format');
  }
}

/**
 * The ring this process seals messages under, or null where there is none.
 *
 * Production refuses to run without one: a server that takes people's messages
 * must not store them readable because a variable was left out of a deploy.
 * Every production compose file already requires the keyring. Outside
 * production — local development, the test suites, the e2e servers — a missing
 * keyring means messages are stored as written, the same line the artifact
 * store and the cookie rules draw. A keyring that is set and malformed is
 * refused everywhere.
 *
 * Read per call and cached on the two variables' text, so a suite that sets a
 * keyring for its own cases gets it, and a busy turn parses nothing.
 */
export function messageKeyring(env: NodeJS.ProcessEnv = process.env): Keyring | null {
  const raw = env['CREWAID_CREDENTIAL_KEYRING'] ?? '';
  const active = env['CREWAID_CREDENTIAL_KEY_ACTIVE'] ?? '';
  const production = (env['NODE_ENV'] ?? '').trim() === 'production';
  if (cached?.raw === raw && cached.active === active && cached.production === production) {
    return cached.keyring;
  }
  let keyring: Keyring | null;
  if (raw.trim() === '') {
    if (production) {
      throw new KeyringConfigError(
        'CREWAID_CREDENTIAL_KEYRING is not set. Messages are encrypted before they are stored, ' +
          'and a production server does not store them without it. See infra/compose/.env.example.',
      );
    }
    keyring = null;
  } else {
    keyring = deriveMessageKeyring(parseKeyring(env));
  }
  cached = { raw, active, production, keyring };
  return keyring;
}

let cached:
  | {
      readonly raw: string;
      readonly active: string;
      readonly production: boolean;
      readonly keyring: Keyring | null;
    }
  | undefined;

function binding(column: SealedColumn): { userId: string; connectionId: string } {
  return { userId: HKDF_LABEL, connectionId: column };
}
