import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CredentialDecryptError,
  credentialAad,
  credentialsEqual,
  decryptCredential,
  encryptCredential,
  rotateCredential,
} from '../src/credentials/credential-cipher.js';
import { KeyringConfigError, parseKeyring, type Keyring } from '../src/credentials/keyring.js';

/**
 * V1-03 / D-083 — the vault's properties, asserted rather than asserted-about.
 *
 * The one that matters most is the cross-user substitution case: without the
 * AAD, a ciphertext lifted from one row into another user's row decrypts
 * perfectly and the vault hands the wrong person's key to the wrong person's
 * turn. That failure is silent, it bills the wrong account, and nothing in the
 * transcript would show it — so it is the first case here.
 */

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);

const USER = 'usr_owner_1';
const OTHER_USER = 'usr_other_2';
const CONNECTION = 'conn_openai_1';
const OTHER_CONNECTION = 'conn_openai_2';
const SECRET = 'sk-live-00000000000000000000000000000000';

function ring(json: string, active?: string): Keyring {
  return parseKeyring({
    CREWAID_CREDENTIAL_KEYRING: json,
    ...(active === undefined ? {} : { CREWAID_CREDENTIAL_KEY_ACTIVE: active }),
  } as NodeJS.ProcessEnv);
}

describe('the credential keyring', () => {
  it('accepts a single key and infers the active version', () => {
    const keyring = ring(JSON.stringify({ 1: KEY_A }));
    expect(keyring.activeVersion).toBe(1);
    expect(keyring.versions).toEqual([1]);
  });

  it('refuses more than one key without an explicit active version', () => {
    // Picking the highest would silently begin a rotation nobody asked for,
    // and the operator's first evidence would be old rows failing to decrypt
    // after the old key was retired.
    expect(() => ring(JSON.stringify({ 1: KEY_A, 2: KEY_B }))).toThrow(KeyringConfigError);
    expect(ring(JSON.stringify({ 1: KEY_A, 2: KEY_B }), '2').activeVersion).toBe(2);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => ring(JSON.stringify({ 1: 'ab'.repeat(8) }))).toThrow(/64 hex characters/);
  });

  it('refuses an active version that is not in the ring', () => {
    expect(() => ring(JSON.stringify({ 1: KEY_A }), '7')).toThrow(/not a version/);
  });

  it('throws rather than returning an empty ring when unset', () => {
    // An empty ring would read at every call site as "this user has not added
    // a key yet", so a misconfigured secret would present as a settings page
    // that merely looks empty.
    expect(() => parseKeyring({} as NodeJS.ProcessEnv)).toThrow(KeyringConfigError);
  });

  it('never puts key material in a configuration error', () => {
    const secretish = 'f'.repeat(64);
    try {
      // Valid hex, invalid JSON around it: the parse fails with the key
      // material sitting in the variable the message is about.
      parseKeyring({
        CREWAID_CREDENTIAL_KEYRING: `{"1":"${secretish}"`,
      } as NodeJS.ProcessEnv);
      expect.unreachable('expected a KeyringConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(KeyringConfigError);
      expect((error as Error).message).not.toContain(secretish);
    }
  });
});

describe('encrypt and decrypt', () => {
  let keyring: Keyring;
  beforeEach(() => {
    keyring = ring(JSON.stringify({ 1: KEY_A }));
  });

  it('round-trips a credential', () => {
    const { ciphertext, keyVersion } = encryptCredential(
      SECRET,
      { userId: USER, connectionId: CONNECTION },
      keyring,
    );
    expect(keyVersion).toBe(1);
    expect(
      decryptCredential(ciphertext, 1, { userId: USER, connectionId: CONNECTION }, keyring),
    ).toBe(SECRET);
  });

  it('never repeats a nonce across writes of the same plaintext', () => {
    // Nonce reuse under one key does not merely weaken GCM, it leaks the XOR
    // of the plaintexts and permits tag forgery. Two encryptions of the same
    // secret must therefore share no bytes after the format marker.
    const binding = { userId: USER, connectionId: CONNECTION };
    const seen = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      const nonce = encryptCredential(SECRET, binding, keyring).ciphertext.split('.')[1]!;
      expect(seen.has(nonce), 'a nonce repeated').toBe(false);
      seen.add(nonce);
    }
  });

  it('stores no recognisable part of the plaintext', () => {
    const { ciphertext } = encryptCredential(
      SECRET,
      { userId: USER, connectionId: CONNECTION },
      keyring,
    );
    expect(ciphertext).not.toContain(SECRET);
    expect(ciphertext).not.toContain('sk-live');
  });
});

describe('the binding refuses a moved ciphertext', () => {
  let keyring: Keyring;
  let ciphertext: string;

  beforeEach(() => {
    keyring = ring(JSON.stringify({ 1: KEY_A }));
    ciphertext = encryptCredential(
      SECRET,
      { userId: USER, connectionId: CONNECTION },
      keyring,
    ).ciphertext;
  });

  it('refuses a ciphertext pasted into another user’s row', () => {
    // THE case. Without the AAD this returns SECRET and the other user's turn
    // bills this user's provider account, silently.
    expect(() =>
      decryptCredential(ciphertext, 1, { userId: OTHER_USER, connectionId: CONNECTION }, keyring),
    ).toThrow(CredentialDecryptError);
  });

  it('refuses a ciphertext moved to another connection of the same user', () => {
    expect(() =>
      decryptCredential(ciphertext, 1, { userId: USER, connectionId: OTHER_CONNECTION }, keyring),
    ).toThrow(CredentialDecryptError);
  });

  it('refuses a re-pointed key version', () => {
    // Editing `credentialKeyVersion` in the database must fail as the tamper
    // it is, rather than quietly decrypting under a different key.
    //
    // ⚠️ THE TWO VERSIONS HOLD THE SAME KEY BYTES, deliberately. With two
    // DIFFERENT keys this passes whether or not the version is in the AAD —
    // the wrong key alone refuses it — so it would assert nothing about the
    // binding. Identical bytes leave the version field as the only thing that
    // can tell the two apart. (The first draft used two different keys and
    // survived a mutation that dropped the version from the AAD entirely.)
    const sameKeyTwice = ring(JSON.stringify({ 1: KEY_A, 2: KEY_A }), '2');
    const underOne = encryptCredential(
      SECRET,
      { userId: USER, connectionId: CONNECTION },
      ring(JSON.stringify({ 1: KEY_A })),
    ).ciphertext;
    expect(() =>
      decryptCredential(underOne, 2, { userId: USER, connectionId: CONNECTION }, sameKeyTwice),
    ).toThrow(CredentialDecryptError);
  });

  it('cannot be defeated by ids that run together across the separator', () => {
    // Length-prefixed AAD, not bare values joined by a newline.
    //
    // ⚠️ THE IDS CONTAIN A NEWLINE, which is the collision the length prefix
    // actually prevents: with bare values, ('a\nb', 'c') and ('a', 'b\nc')
    // both render as "a\nb\nc" and a ciphertext moves between those two rows
    // undetected. `CuidSchema` is `z.string().min(1).max(64)` — it permits a
    // newline — so this is reachable input, not a thought experiment.
    // (The first draft used ('ab','cd') vs ('a','bcd'), which the newline
    // separator already distinguishes, and it survived the mutation.)
    expect(credentialAad({ userId: 'a\nb', connectionId: 'c' }, 1)).not.toEqual(
      credentialAad({ userId: 'a', connectionId: 'b\nc' }, 1),
    );
    const blob = encryptCredential(
      SECRET,
      { userId: 'a\nb', connectionId: 'c' },
      keyring,
    ).ciphertext;
    expect(() =>
      decryptCredential(blob, 1, { userId: 'a', connectionId: 'b\nc' }, keyring),
    ).toThrow(CredentialDecryptError);
  });

  it('refuses ids that differ only by a colon, which cuids may contain', () => {
    const blob = encryptCredential(
      SECRET,
      { userId: 'a:b', connectionId: 'c' },
      keyring,
    ).ciphertext;
    expect(() => decryptCredential(blob, 1, { userId: 'a', connectionId: 'b:c' }, keyring)).toThrow(
      CredentialDecryptError,
    );
  });
});

describe('tampering', () => {
  let keyring: Keyring;
  let ciphertext: string;
  const binding = { userId: USER, connectionId: CONNECTION };

  beforeEach(() => {
    keyring = ring(JSON.stringify({ 1: KEY_A }));
    ciphertext = encryptCredential(SECRET, binding, keyring).ciphertext;
  });

  it('refuses a flipped bit in the body — it does not return garbage', () => {
    // The property AES-GCM is chosen for. A mode without authentication would
    // hand back a plausible-looking string that the caller then sends to a
    // provider as somebody's API key.
    const [format, nonce, body, tag] = ciphertext.split('.');
    const bytes = Buffer.from(body!, 'base64url');
    bytes[0] ^= 0x01;
    const mutated = [format, nonce, bytes.toString('base64url'), tag].join('.');
    expect(() => decryptCredential(mutated, 1, binding, keyring)).toThrow(/authentication failed/);
  });

  it('refuses a flipped bit in the tag', () => {
    const [format, nonce, body, tag] = ciphertext.split('.');
    const bytes = Buffer.from(tag!, 'base64url');
    bytes[0] ^= 0x01;
    const mutated = [format, nonce, body, bytes.toString('base64url')].join('.');
    expect(() => decryptCredential(mutated, 1, binding, keyring)).toThrow(CredentialDecryptError);
  });

  it('refuses a swapped nonce', () => {
    const other = encryptCredential(SECRET, binding, keyring).ciphertext.split('.')[1]!;
    const [format, , body, tag] = ciphertext.split('.');
    expect(() =>
      decryptCredential([format, other, body, tag].join('.'), 1, binding, keyring),
    ).toThrow(CredentialDecryptError);
  });

  it('refuses a truncated or malformed blob without saying which', () => {
    for (const bad of ['', 'g1', 'g1.a.b', 'x9.a.b.c', `g1.!!!.${'a'}.${'b'}`]) {
      expect(() => decryptCredential(bad, 1, binding, keyring)).toThrow(CredentialDecryptError);
    }
  });

  it('refuses a key version the ring cannot load', () => {
    expect(() => decryptCredential(ciphertext, 9, binding, keyring)).toThrow(
      /no key for version 9/,
    );
  });

  it('refuses the wrong key entirely', () => {
    const wrong = ring(JSON.stringify({ 1: KEY_C }));
    expect(() => decryptCredential(ciphertext, 1, binding, wrong)).toThrow(CredentialDecryptError);
  });

  it('never puts the ciphertext or the plaintext in the error it throws', () => {
    // Error messages are the most-copied text in any codebase; one carrying
    // key material ends up in an issue tracker.
    try {
      decryptCredential(ciphertext, 1, { userId: OTHER_USER, connectionId: CONNECTION }, keyring);
      expect.unreachable('expected a CredentialDecryptError');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(ciphertext);
      expect(message).not.toContain(KEY_A);
    }
  });
});

describe('rotation', () => {
  const binding = { userId: USER, connectionId: CONNECTION };

  it('re-wraps under the new active version and stays readable', () => {
    const v1 = ring(JSON.stringify({ 1: KEY_A }));
    const original = encryptCredential(SECRET, binding, v1).ciphertext;

    const v2 = ring(JSON.stringify({ 1: KEY_A, 2: KEY_B }), '2');
    const rotated = rotateCredential(original, 1, binding, v2);
    expect(rotated).not.toBeNull();
    expect(rotated!.keyVersion).toBe(2);
    expect(rotated!.ciphertext).not.toBe(original);
    expect(decryptCredential(rotated!.ciphertext, 2, binding, v2)).toBe(SECRET);
  });

  it('is a no-op for a row already on the active version', () => {
    // Idempotence is what lets an interrupted rotation simply be re-run.
    const v2 = ring(JSON.stringify({ 1: KEY_A, 2: KEY_B }), '2');
    const current = encryptCredential(SECRET, binding, v2);
    expect(rotateCredential(current.ciphertext, current.keyVersion, binding, v2)).toBeNull();
  });

  it('keeps the old version readable until every row has moved', () => {
    // The reason the ring is a SET rather than one key plus one previous: a
    // rotation is not atomic, so both must open rows for as long as it runs.
    const v2 = ring(JSON.stringify({ 1: KEY_A, 2: KEY_B }), '2');
    const old = encryptCredential(SECRET, binding, ring(JSON.stringify({ 1: KEY_A }))).ciphertext;
    expect(decryptCredential(old, 1, binding, v2)).toBe(SECRET);
  });

  it('cannot read a row whose version was dropped from the ring', () => {
    const v1 = ring(JSON.stringify({ 1: KEY_A }));
    const old = encryptCredential(SECRET, binding, v1).ciphertext;
    const retired = ring(JSON.stringify({ 2: KEY_B }), '2');
    expect(() => decryptCredential(old, 1, binding, retired)).toThrow(/may have been retired/);
  });
});

describe('credentialsEqual', () => {
  it('compares without leaking length-independent timing', () => {
    expect(credentialsEqual(SECRET, SECRET)).toBe(true);
    expect(credentialsEqual(SECRET, `${SECRET}x`)).toBe(false);
    expect(credentialsEqual(SECRET, SECRET.replace(/0$/, '1'))).toBe(false);
    expect(credentialsEqual('', '')).toBe(true);
  });
});

describe('inputs the vault refuses outright', () => {
  it('will not encrypt an empty credential', () => {
    // An empty key stored as a valid ciphertext is a connection that reports
    // ACTIVE and 401s on every turn.
    const keyring = ring(JSON.stringify({ 1: KEY_A }));
    expect(() =>
      encryptCredential('', { userId: USER, connectionId: CONNECTION }, keyring),
    ).toThrow(/empty credential/);
  });

  it('survives a credential with newlines and non-ASCII', () => {
    // The AAD is newline-delimited, so a plaintext containing newlines is the
    // obvious thing to get wrong.
    const keyring = ring(JSON.stringify({ 1: KEY_A }));
    const awkward = `line1\nline2\t${randomBytes(8).toString('hex')}é—`;
    const { ciphertext } = encryptCredential(
      awkward,
      { userId: USER, connectionId: CONNECTION },
      keyring,
    );
    expect(
      decryptCredential(ciphertext, 1, { userId: USER, connectionId: CONNECTION }, keyring),
    ).toBe(awkward);
  });
});
