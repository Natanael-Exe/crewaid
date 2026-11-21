/**
 * The credential keyring.
 *
 * A VERSIONED set of AES-256 keys, read from the environment, kept in
 * deployment secrets and deliberately separate from both the database and
 * `BETTER_AUTH_SECRET`. Two reasons the separation is not ceremony: a backup
 * holding the ciphertext and the key that opens it is not encryption, and one
 * secret serving both purposes means rotating either forces rotating the
 * other — so the rotation that should be routine becomes a sign-out for
 * everybody, and therefore never happens.
 *
 * Versioned because rotation has to be incremental. Re-encrypting every row in
 * one transaction is the plan that gets abandoned halfway with some rows under
 * the new key and no way to read the rest; instead a row records the version
 * that produced it, new writes use the active version, and the old versions
 * stay loadable until nothing points at them.
 */

/** 32 bytes — AES-256. Anything else is a configuration error, not a weaker key. */
const KEY_BYTES = 32;

export type KeyVersion = number;

export type Keyring = {
  /** The version new ciphertext is written under. */
  readonly activeVersion: KeyVersion;
  /** Every loadable version, including the active one. */
  readonly versions: readonly KeyVersion[];
  /** The key for a version, or undefined when it is not in the ring. */
  readonly keyFor: (version: KeyVersion) => Buffer | undefined;
};

export class KeyringConfigError extends Error {
  readonly code = 'KEYRING_CONFIG' as const;
  constructor(message: string) {
    super(message);
    this.name = 'KeyringConfigError';
  }
}

const KEYRING_VAR = 'CREWAID_CREDENTIAL_KEYRING';
const ACTIVE_VAR = 'CREWAID_CREDENTIAL_KEY_ACTIVE';

/**
 * Parse a keyring from its two environment variables.
 *
 * `CREWAID_CREDENTIAL_KEYRING` is a JSON object of version → 64 hex characters,
 * e.g. `{"1":"3f…","2":"a1…"}`. `CREWAID_CREDENTIAL_KEY_ACTIVE` names which
 * version new writes use.
 *
 * JSON rather than a delimited string because the alternative encodings all
 * fail silently on a key that contains the delimiter, and the failure mode of
 * a half-parsed key is a ring that loads and cannot decrypt anything.
 *
 * Every failure here is a throw. A keyring that cannot be parsed must not
 * degrade into "no credentials configured": that reads, at every call site, as
 * a user who has not added a key yet — and the operator's evidence for a
 * misconfigured secret would be a settings page that looks empty.
 */
export function parseKeyring(env: NodeJS.ProcessEnv = process.env): Keyring {
  const raw = env[KEYRING_VAR];
  if (raw === undefined || raw.trim() === '') {
    throw new KeyringConfigError(
      `${KEYRING_VAR} is not set. Provider credentials cannot be read or written ` +
        'without it. See infra/compose/.env.example.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The variable's VALUE is never quoted back, here or anywhere else in this
    // file: it is key material, and a parse error that prints it puts every
    // key in the ring into the log line that reports the typo.
    throw new KeyringConfigError(
      `${KEYRING_VAR} is not valid JSON. Expected {"<version>":"<64 hex chars>"}.`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KeyringConfigError(
      `${KEYRING_VAR} must be a JSON object of version to 64 hex characters.`,
    );
  }

  const keys = new Map<KeyVersion, Buffer>();
  for (const [versionText, value] of Object.entries(parsed)) {
    const version = Number(versionText);
    if (!Number.isInteger(version) || version < 1) {
      throw new KeyringConfigError(
        `${KEYRING_VAR} has a non-integer version "${versionText}". Versions are 1, 2, 3, …`,
      );
    }
    if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
      throw new KeyringConfigError(
        `${KEYRING_VAR} version ${version} is not 64 hex characters (32 bytes for AES-256). ` +
          'Generate one with: openssl rand -hex 32',
      );
    }
    const key = Buffer.from(value, 'hex');
    /* c8 ignore next 5 -- unreachable while the regex above pins the length,
       and kept because the two checks are separate facts: the regex is about
       the ENCODING and this is about the KEY SIZE, and someone relaxing the
       former to accept whitespace should not silently also relax the latter. */
    if (key.length !== KEY_BYTES) {
      throw new KeyringConfigError(`${KEYRING_VAR} version ${version} is not ${KEY_BYTES} bytes.`);
    }
    keys.set(version, key);
  }

  if (keys.size === 0) {
    throw new KeyringConfigError(`${KEYRING_VAR} contains no keys.`);
  }

  const activeRaw = env[ACTIVE_VAR];
  // A single-key ring has exactly one answer, so making an operator state it
  // twice is a second thing to get wrong for no information gained. With two
  // or more, "which one do new writes use" has no safe default — picking the
  // highest would silently start a rotation the operator did not ask for.
  let activeVersion: KeyVersion;
  if (activeRaw === undefined || activeRaw.trim() === '') {
    if (keys.size > 1) {
      throw new KeyringConfigError(
        `${ACTIVE_VAR} must be set when ${KEYRING_VAR} holds more than one key: ` +
          `it decides which version new credentials are written under. ` +
          `Available: ${[...keys.keys()].sort((a, b) => a - b).join(', ')}.`,
      );
    }
    activeVersion = [...keys.keys()][0]!;
  } else {
    activeVersion = Number(activeRaw);
    if (!Number.isInteger(activeVersion) || !keys.has(activeVersion)) {
      throw new KeyringConfigError(
        `${ACTIVE_VAR} is "${activeRaw}", which is not a version in ${KEYRING_VAR}. ` +
          `Available: ${[...keys.keys()].sort((a, b) => a - b).join(', ')}.`,
      );
    }
  }

  return {
    activeVersion,
    versions: [...keys.keys()].sort((a, b) => a - b),
    keyFor: (version) => keys.get(version),
  };
}
