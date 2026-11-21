import {
  decryptCredential,
  encryptCredential,
  type CredentialBinding,
} from '../credentials/credential-cipher.js';
import { MCP_CREDENTIAL_KEY_VERSION, parseMcpCredentialKey } from '../credentials/mcp-keyring.js';

/**
 * The ONE reader and writer of a person's Telegram bot token. A token
 * is full control of that person's bot, so it is sealed at rest under
 * `CREDENTIAL_KEY` with the same AES-256-GCM cipher as plugin credentials.
 *
 * The binding is part of the authenticated data. A pending bot's ciphertext
 * names only the bot, because a managed bot arrives before anyone has claimed
 * it; once confirmed it is resealed under its account. Neither opens under the
 * other's binding, so a ciphertext copied between rows or accounts is
 * unreadable rather than quietly someone else's.
 */
const pendingBinding = (telegramBotId: string): CredentialBinding => ({
  userId: 'telegram',
  connectionId: `pending:${telegramBotId}`,
});
const connectionBinding = (userId: string, telegramBotId: string): CredentialBinding => ({
  userId,
  connectionId: `telegram:${telegramBotId}`,
});

/** Throws a `KeyringConfigError` naming `CREDENTIAL_KEY` when tokens could not be sealed. */
export function assertTelegramTokenKey(env: NodeJS.ProcessEnv = process.env): void {
  parseMcpCredentialKey(env);
}

export function sealPendingToken(telegramBotId: string, token: string): string {
  return encryptCredential(token, pendingBinding(telegramBotId), parseMcpCredentialKey())
    .ciphertext;
}

export function openPendingToken(row: { telegramBotId: string; tokenCiphertext: string }): string {
  return decryptCredential(
    row.tokenCiphertext,
    MCP_CREDENTIAL_KEY_VERSION,
    pendingBinding(row.telegramBotId),
    parseMcpCredentialKey(),
  );
}

export function sealConnectionToken(userId: string, telegramBotId: string, token: string): string {
  return encryptCredential(token, connectionBinding(userId, telegramBotId), parseMcpCredentialKey())
    .ciphertext;
}

export function openConnectionToken(row: {
  userId: string;
  telegramBotId: string;
  tokenCiphertext: string;
}): string {
  return decryptCredential(
    row.tokenCiphertext,
    MCP_CREDENTIAL_KEY_VERSION,
    connectionBinding(row.userId, row.telegramBotId),
    parseMcpCredentialKey(),
  );
}
