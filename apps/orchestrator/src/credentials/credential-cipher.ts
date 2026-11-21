import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Keyring, KeyVersion } from './keyring.js';

/**
 * AES-256-GCM for provider credentials.
 *
 * Pure: a keyring in, a string out. No database, no Nest, no logging — the
 * last one deliberately, because the only interesting values in this file are
 * the plaintext and the key, and a debug line that survives review is how both
 * end up in a log aggregator.
 */

const ALGORITHM = 'aes-256-gcm';
/** 96 bits, GCM's specified nonce size. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Bumped only if the encoding below changes shape. */
const FORMAT = 'g1';

/** Who a ciphertext belongs to. Bound into the tag, not stored beside it. */
export type CredentialBinding = {
  readonly userId: string;
  readonly connectionId: string;
};

export class CredentialDecryptError extends Error {
  readonly code = 'CREDENTIAL_DECRYPT' as const;
  constructor(reason: string) {
    // The reason names the CLASS of failure and never the value. A message
    // carrying any part of the ciphertext or the key is the leak this whole
    // module exists to prevent, and error messages are the most-copied text in
    // any codebase.
    super(`stored credential could not be read: ${reason}`);
    this.name = 'CredentialDecryptError';
  }
}

/**
 * The additional authenticated data binding a ciphertext to its row.
 *
 * ⚠️ LENGTH-PREFIXED, not delimiter-joined, and that is the whole point of the
 * function. With a plain `${userId}:${connectionId}` the pairs
 * (`ab`, `cd`) and (`a`, `bcd`) produce the same string, so a ciphertext could
 * be moved between two rows whose ids happen to concatenate the same way and
 * would decrypt cleanly — which is precisely the substitution the AAD exists
 * to refuse. Cuids in this repo are validated loosely enough to contain `:`,
 * so this is not a theoretical concern about exotic input.
 *
 * The key version is bound in too, so editing `credentialKeyVersion` in the
 * database to point at a different key does not silently produce a different
 * plaintext — it fails as a tamper, which is what it is.
 */
export function credentialAad(binding: CredentialBinding, version: KeyVersion): Buffer {
  const part = (value: string): string => `${value.length}:${value}`;
  return Buffer.from(
    [FORMAT, part(binding.userId), part(binding.connectionId), String(version)].join('\n'),
    'utf8',
  );
}

/**
 * Encrypt a provider API key.
 *
 * A fresh nonce per call, from the CSPRNG. Reusing one under the same key in
 * GCM does not merely weaken the ciphertext, it leaks the XOR of the two
 * plaintexts and lets an attacker forge tags — so this is the one parameter
 * with no "good enough" setting, and it is why nothing here accepts a nonce
 * from a caller.
 */
export function encryptCredential(
  plaintext: string,
  binding: CredentialBinding,
  keyring: Keyring,
): { ciphertext: string; keyVersion: KeyVersion } {
  if (plaintext === '') {
    throw new Error('refusing to encrypt an empty credential');
  }
  const version = keyring.activeVersion;
  const key = keyring.keyFor(version);
  /* c8 ignore next 3 -- parseKeyring guarantees the active version is present;
     the check is here so a hand-built Keyring in a test cannot encrypt under
     `undefined` and produce a ciphertext nothing can open. */
  if (key === undefined) {
    throw new Error(`keyring has no key for its own active version ${version}`);
  }

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(credentialAad(binding, version));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: [FORMAT, b64(nonce), b64(body), b64(tag)].join('.'),
    keyVersion: version,
  };
}

/**
 * Decrypt a provider API key.
 *
 * Every failure is a `CredentialDecryptError` — a malformed blob, an unknown
 * key version, a tampered body and a ciphertext lifted from another user's row
 * are all the same answer to the caller, because they are the same answer to
 * the operator: this credential cannot be used, re-enter it. Distinguishing
 * them in the message would tell whoever provoked it which of the four they
 * achieved.
 */
export function decryptCredential(
  ciphertext: string,
  version: KeyVersion,
  binding: CredentialBinding,
  keyring: Keyring,
): string {
  const parts = ciphertext.split('.');
  if (parts.length !== 4 || parts[0] !== FORMAT) {
    throw new CredentialDecryptError('unrecognised format');
  }
  const key = keyring.keyFor(version);
  if (key === undefined) {
    throw new CredentialDecryptError(
      `no key for version ${version} in the keyring — it may have been retired before ` +
        'every row using it was rotated',
    );
  }

  let nonce: Buffer;
  let body: Buffer;
  let tag: Buffer;
  try {
    nonce = unb64(parts[1]!);
    body = unb64(parts[2]!);
    tag = unb64(parts[3]!);
  } catch {
    throw new CredentialDecryptError('unrecognised format');
  }
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new CredentialDecryptError('unrecognised format');
  }

  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAAD(credentialAad(binding, version));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // GCM REFUSES rather than returning garbage, and that is the property this
    // whole scheme is chosen for: a tampered or misbound ciphertext must never
    // become a plausible-looking string that a caller then sends to a provider
    // as somebody's API key.
    throw new CredentialDecryptError('authentication failed');
  }
}

/**
 * Re-wrap a ciphertext under the keyring's active version.
 *
 * Returns `null` when the row is already on the active version, so a rotation
 * pass can be re-run over the whole table without rewriting rows it already
 * did — which matters because a rotation that is not idempotent is one that
 * cannot be resumed after it is interrupted.
 */
export function rotateCredential(
  ciphertext: string,
  fromVersion: KeyVersion,
  binding: CredentialBinding,
  keyring: Keyring,
): { ciphertext: string; keyVersion: KeyVersion } | null {
  if (fromVersion === keyring.activeVersion) return null;
  const plaintext = decryptCredential(ciphertext, fromVersion, binding, keyring);
  return encryptCredential(plaintext, binding, keyring);
}

/**
 * Whether two credentials are the same, without leaking which prefix matched.
 *
 * Used by the "did this key actually change" check on update, which would
 * otherwise be a `===` on two secrets in a code path an attacker can time.
 */
export function credentialsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function b64(value: Buffer): string {
  return value.toString('base64url');
}

function unb64(value: string): Buffer {
  // `Buffer.from` is famously lenient, so round-trip to prove the input was
  // actually base64url rather than accepting a silently truncated decode.
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error('not base64url');
  }
  return decoded;
}
