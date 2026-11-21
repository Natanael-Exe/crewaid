import { describe, expect, it } from 'vitest';

import { decryptCredential } from '../src/credentials/credential-cipher.js';
import { KeyringConfigError, parseKeyring, type Keyring } from '../src/credentials/keyring.js';
import {
  MessageDecryptError,
  SEALED_PREFIX,
  deriveMessageKeyring,
  isSealed,
  messageKeyring,
  openJson,
  openText,
  sealJson,
  sealText,
  sealedVersion,
} from '../src/credentials/message-cipher.js';

/**
 * D-236 — what sealing a message promises, case by case.
 *
 * The first block is the promise itself: what is stored does not contain what
 * was said. The rest are the ways a sealed value must refuse to open, because
 * each of them would otherwise put somebody else's words, or garbage, into a
 * transcript without a single error.
 */

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const SAID = 'Meet me at the harbour at nine. Bring the contract.';

function source(json: string, active?: string): Keyring {
  return parseKeyring({
    CREWAID_CREDENTIAL_KEYRING: json,
    ...(active === undefined ? {} : { CREWAID_CREDENTIAL_KEY_ACTIVE: active }),
  } as NodeJS.ProcessEnv);
}

const ring = deriveMessageKeyring(source(JSON.stringify({ 1: KEY_A })));

describe('sealing message text', () => {
  it('stores nothing of what was said, and gives it back', () => {
    const stored = sealText(SAID, 'message.content', ring);
    expect(stored.startsWith(SEALED_PREFIX)).toBe(true);
    for (const word of SAID.split(' ')) expect(stored).not.toContain(word);
    expect(openText(stored, 'message.content', ring)).toBe(SAID);
  });

  it('seals the same words differently each time', () => {
    expect(sealText(SAID, 'message.content', ring)).not.toBe(
      sealText(SAID, 'message.content', ring),
    );
  });

  it.each(['', ' ', '\n\t '])('stores text that says nothing (%j) as itself', (blank) => {
    // SQL tells a spoken row from an empty one by `content <> ''` and by trimming.
    expect(sealText(blank, 'message.content', ring)).toBe(blank);
    expect(openText(blank, 'message.content', ring)).toBe(blank);
  });

  it('seals text a person typed that looks sealed already', () => {
    // Stored as it came, it would claim to be ciphertext and open under no key.
    const typed = `${SEALED_PREFIX}1.g1.AAAA.BBBB.CCCC`;
    const stored = sealText(typed, 'message.content', ring);
    expect(stored).not.toBe(typed);
    expect(openText(stored, 'message.content', ring)).toBe(typed);
  });

  it('reads a row written before sealing as the plaintext it holds', () => {
    expect(openText(SAID, 'message.content', ring)).toBe(SAID);
    expect(openText(SAID, 'message.content', null)).toBe(SAID);
    expect(isSealed(SAID)).toBe(false);
  });

  it('round-trips a JSON body, and leaves an unsealed one alone', () => {
    const parts = { role: 'assistant', content: [{ type: 'text', content: SAID }], n: [1, null] };
    const stored = sealJson(parts, 'message.parts', ring);
    expect(typeof stored).toBe('string');
    expect(stored).not.toContain('harbour');
    expect(openJson(stored, 'message.parts', ring)).toEqual(parts);
    expect(openJson(parts, 'message.parts', ring)).toBe(parts);
    expect(openJson(null, 'message.parts', ring)).toBeNull();
  });
});

describe('what a sealed value refuses', () => {
  const stored = sealText(SAID, 'message.content', ring);

  it('to open as another column', () => {
    // A `parts` body moved into `content` must not become a message.
    expect(() => openText(stored, 'message.parts', ring)).toThrow(MessageDecryptError);
    expect(() => openText(stored, 'runEvent.chunk', ring)).toThrow(MessageDecryptError);
  });

  it('to open after being altered', () => {
    const last = stored.at(-1) === 'A' ? 'B' : 'A';
    expect(() => openText(stored.slice(0, -1) + last, 'message.content', ring)).toThrow(
      MessageDecryptError,
    );
    expect(() => openText(`${SEALED_PREFIX}nonsense`, 'message.content', ring)).toThrow(
      MessageDecryptError,
    );
  });

  it('to open under another key, or with none', () => {
    const other = deriveMessageKeyring(source(JSON.stringify({ 1: KEY_B })));
    expect(() => openText(stored, 'message.content', other)).toThrow(MessageDecryptError);
    expect(() => openText(stored, 'message.content', null)).toThrow(/no keyring/);
  });

  it('to name what it held when it fails', () => {
    try {
      openText(stored.slice(0, -2), 'message.content', ring);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(stored.slice(SEALED_PREFIX.length + 10, -2));
      expect(String(error)).not.toContain('credential');
    }
  });

  it('to open as a provider credential under the same keyring', () => {
    // The message key is derived from the ring's key, never the key itself, so
    // the two kinds of ciphertext cannot be offered to each other.
    const blob = stored.slice(SEALED_PREFIX.length + '1.'.length);
    const credentials = source(JSON.stringify({ 1: KEY_A }));
    expect(() =>
      decryptCredential(
        blob,
        1,
        { userId: 'crewaid/message-at-rest/v1', connectionId: 'message.content' },
        credentials,
      ),
    ).toThrow();
  });
});

describe('rotation', () => {
  it('opens a row sealed under a retired-from-active version, and writes under the new one', () => {
    const before = sealText(SAID, 'message.content', ring);
    const rotated = deriveMessageKeyring(source(JSON.stringify({ 1: KEY_A, 2: KEY_B }), '2'));
    expect(sealedVersion(before)).toBe(1);
    expect(openText(before, 'message.content', rotated)).toBe(SAID);
    expect(sealedVersion(sealText(SAID, 'message.content', rotated))).toBe(2);
    expect(sealedVersion(SAID)).toBeNull();
  });

  it('says which version is missing once its key is taken out', () => {
    const rotated = deriveMessageKeyring(source(JSON.stringify({ 1: KEY_A, 2: KEY_B }), '2'));
    const under2 = sealText(SAID, 'message.content', rotated);
    expect(() => openText(under2, 'message.content', ring)).toThrow(/version 2/);
  });
});

describe('which keyring a process seals under', () => {
  const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;

  it('has none outside production when the variable is unset', () => {
    expect(messageKeyring(env({}))).toBeNull();
    expect(messageKeyring(env({ CREWAID_CREDENTIAL_KEYRING: '  ', NODE_ENV: 'test' }))).toBeNull();
  });

  it('refuses a production server without one', () => {
    // A deploy that left the variable out must not store messages readable.
    expect(() => messageKeyring(env({ NODE_ENV: 'production' }))).toThrow(KeyringConfigError);
  });

  it('refuses a malformed keyring everywhere, without quoting it', () => {
    const typo = `{"1":"${KEY_A}"`;
    expect(() => messageKeyring(env({ CREWAID_CREDENTIAL_KEYRING: typo }))).toThrow(
      KeyringConfigError,
    );
    try {
      messageKeyring(env({ CREWAID_CREDENTIAL_KEYRING: typo }));
    } catch (error) {
      expect(String(error)).not.toContain(KEY_A);
    }
  });

  it('follows the variable when it changes, as a suite that sets its own does', () => {
    const first = messageKeyring(env({ CREWAID_CREDENTIAL_KEYRING: JSON.stringify({ 1: KEY_A }) }));
    const second = messageKeyring(
      env({ CREWAID_CREDENTIAL_KEYRING: JSON.stringify({ 1: KEY_B }) }),
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const stored = sealText(SAID, 'message.content', first as Keyring);
    expect(() => openText(stored, 'message.content', second)).toThrow(MessageDecryptError);
    expect(openText(stored, 'message.content', ring)).toBe(SAID);
  });
});
