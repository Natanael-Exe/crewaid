import { KeyringConfigError, type Keyring } from './keyring.js';

/**
 * The MCP credential key — `CREDENTIAL_KEY`.
 *
 * Why this is not `crewaid_credential_keyring`
 *
 * §7.3 names `CREDENTIAL_KEY` for MCP tokens and D-083 names the keyring for
 * provider keys, and the separation is deliberate on both sides: one secret
 * serving two purposes means rotating either one forces rotating the other, so
 * the rotation that should be routine becomes a sign-out for everybody (and
 * for MCP, a reconnect for everybody) and therefore never happens. The two
 * also have different lifetimes — a provider key is typed in by an operator,
 * an MCP token is minted by a third party's authorization server.
 *
 * WHAT IS SHARED IS THE CIPHER, NOT THE SECRET. `credential-cipher.ts` encrypts
 * both, and the binding is what keeps a ciphertext from travelling between the
 * two tables: the AAD is `(userId, <row id>)` length-prefixed, and a
 * `ProviderConnection` id is not an `McpServer` id.
 *
 * Why the ring has exactly one version
 *
 * `CREDENTIAL_KEY` is a single 64-hex secret, not a versioned set, so every
 * MCP ciphertext is written under version 1 and there is nothing else it could
 * be. The cipher still BINDS the version into the AAD (it takes a `Keyring`,
 * and that is the interface it has), which is what makes the constant safe
 * rather than decorative: a ciphertext re-labelled as another version fails
 * authentication instead of decrypting to something else.
 *
 * THE CONSEQUENCE, STATED RATHER THAN DISCOVERED. Replacing `CREDENTIAL_KEY`
 * makes every stored MCP credential unreadable, and the recovery is that each
 * user reconnects that server — which is the same recovery as a revoked grant
 * and the same one the read path already names. If a rotation that does NOT
 * force that is ever wanted, it needs a keyring and a version column, and that
 * is a task with its own migration rather than something to half-build here.
 *
 * KEEP THIS OUT OF THE DATABASE AND OUT OF DATABASE BACKUPS. A backup that
 * holds the ciphertext and the key that opens it is not encryption.
 */

/** 32 bytes — AES-256. Anything else is a configuration error, not a weaker key. */
const KEY_BYTES = 32;

const VAR = 'CREDENTIAL_KEY';

/** The one version an MCP ciphertext is written under. See the file comment. */
export const MCP_CREDENTIAL_KEY_VERSION = 1;

/**
 * Parse `CREDENTIAL_KEY` into the single-version ring the cipher takes.
 *
 * Every failure is a `KeyringConfigError`, which is the class
 * `KeyringConfigFilter` already turns into a 503 naming the variable — so a
 * misconfigured MCP key reaches an operator the same way a misconfigured
 * provider keyring does, instead of as a 500 on a screen where trying again
 * cannot possibly work.
 *
 * The messages name the VARIABLE and its expected shape and never quote its
 * value: this is key material, and a parse error that echoes the input puts the
 * key in the log line that reports the typo.
 *
 * Parsed per call rather than cached. It is a hex decode and a length check on
 * a path that is about to open a socket to somebody else's server; a cache
 * would buy nothing measurable and would add a stale-key window whose only
 * symptom is a credential that fails to decrypt for reasons the operator
 * already fixed.
 */
export function parseMcpCredentialKey(env: NodeJS.ProcessEnv = process.env): Keyring {
  const raw = env[VAR];
  if (raw === undefined || raw.trim() === '') {
    throw new KeyringConfigError(
      `${VAR} is not set. MCP credentials cannot be read or written without it. ` +
        'See infra/compose/.env.example.',
    );
  }

  const value = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new KeyringConfigError(
      `${VAR} is not 64 hex characters (32 bytes for AES-256). ` +
        'Generate one with: openssl rand -hex 32',
    );
  }

  const key = Buffer.from(value, 'hex');
  /* c8 ignore next 3 -- unreachable while the regex above pins the length, and
     kept because the two checks are separate facts: the regex is about the
     ENCODING and this is about the KEY SIZE, and someone relaxing the former to
     accept whitespace should not silently also relax the latter. */
  if (key.length !== KEY_BYTES) {
    throw new KeyringConfigError(`${VAR} is not ${KEY_BYTES} bytes.`);
  }

  const version = MCP_CREDENTIAL_KEY_VERSION;
  return {
    activeVersion: version,
    versions: [version],
    keyFor: (asked) => (asked === version ? key : undefined),
  };
}
