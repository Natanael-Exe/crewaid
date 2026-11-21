import { McpAuthMetadataSchema, type McpAuthMetadata } from '@crewaid/shared';
import { Prisma } from '@prisma/client';
import {
  CredentialDecryptError,
  decryptCredential,
  encryptCredential,
} from '../credentials/credential-cipher.js';
import { parseMcpCredentialKey } from '../credentials/mcp-keyring.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * where a plugin credential is written, and where it is read back.
 *
 * BOTH TOKEN COLUMNS IN HERE ARE CIPHERTEXT BEFORE THEY REACH PRISMA.
 * `accessToken` and `refreshToken` are encrypted with AES-256-GCM under
 * `CREDENTIAL_KEY` by the same cipher the provider vault uses, and this
 * module is the ONLY writer and the ONLY reader. The one column that is NOT
 * encrypted is `authMetadata`, and it is not a credential: a public PKCE
 * client's id, a token endpoint the user's browser has already been sent to,
 * and the server's own URL. Nothing else in the orchestrator reads
 * `McpCredential` — the API layer cannot even name it
 * (`McpServerSummarySchema` has no field token material could travel in), and
 * `McpServersService.credentialFor` is the only caller of the read below.
 *
 * Why both fences, and why neither is redundant
 *
 * A read takes the connection instance (`serverId`) AND the resolved principal
 * (`userId`), and the owner is in the QUERY rather than checked afterwards —
 * the same shape closed ten HTTP routes for not having. The board's
 * instruction for this task is that the two must never be separated: a
 * credential keyed on the connection alone is one `serverId` away from
 * returning somebody else's bearer, which is the substitution the AAD also
 * refuses at the cipher level. They fail differently and both are wanted — the
 * query fence fails as "no such credential", the AAD as "authentication
 * failed" — so a bug has to get past two independent mechanisms to leak.
 *
 * There is deliberately NO in-process cache of a decrypted token.
 * states the same rule for the connection it opens, and the reason is
 * concrete: `DELETE /mcp/servers/:id` is the revocation path, so a
 * process-wide cache keyed on anything at all would keep a revoked token
 * alive in memory after the row that justified it is gone. The credential
 * table is the cache, and it has a delete.
 *
 * A credential reaches a server as a request header and nowhere else:
 * `McpServersService.withAuthorizedConnection` (through `credentialFor`) is the
 * only caller of `readMcpCredential`, and it builds `Authorization: Bearer …`
 * for the connection that is about to be opened — renewing it first when the
 * stored expiry is inside the skew. Never a log line, never a
 * response body, never a sandbox.
 */

/**
 * Who a credential belongs to: the row, and the principal it was resolved for.
 *
 * `serverId` alone identifies the connection instance; `userId` is the owner
 * that had to be established before the instance meant anything. Every
 * exported function here takes both, so there is no signature in this file
 * that can be called with half the answer.
 */
export type McpCredentialScope = {
  readonly userId: string;
  readonly serverId: string;
};

export type McpCredentialInput = McpCredentialScope & {
  readonly accessToken: string;
  /** Absent when the authorization server issued none — the nullable column. */
  readonly refreshToken?: string | undefined;
  /** Absent when the response carried no `expires_in`; the refresh path reads it. */
  readonly expiresAt?: Date | undefined;
  /** What was GRANTED, which is not always what was asked for. Not secret. */
  readonly scopes: readonly string[];
  /**
   * What a refresh will need, written by the callback that just
   * learned it from the flow row. Absent means "this credential has no refresh
   * coordinates", and it is written as NULL rather than left alone — see the
   * upsert note below.
   */
  readonly authMetadata?: McpAuthMetadata | undefined;
};

/** A decrypted credential. Exists only for as long as one call needs it. */
export type McpCredentialRecord = {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: Date | null;
  readonly scopes: readonly string[];
  /**
   * What a refresh needs, or null when there is none to be had — a row written
   * before, or a blob that is not the shape this build writes. Null is
   * NOT a refusal to use the credential: a bearer that is still valid is used
   * as it is, and only the refresh path turns a missing blob into a named
   * failure (with the one fix that exists: reconnect).
   */
  readonly authMetadata: McpAuthMetadata | null;
};

/**
 * The AAD binding for an MCP credential: the row AND the principal.
 *
 * One definition, used by both the write and the read, because a binding that
 * drifted between them would not fail loudly — every ciphertext would simply
 * stop decrypting — and because the principal being IN the binding is what
 * makes a ciphertext lifted into another user's row fail authentication
 * instead of handing them a working bearer.
 */
export function mcpCredentialBinding(scope: McpCredentialScope): {
  readonly userId: string;
  readonly connectionId: string;
} {
  return { userId: scope.userId, connectionId: scope.serverId };
}

export class McpCredentialUnreadableError extends Error {
  readonly code = 'MCP_CREDENTIAL_UNREADABLE' as const;
  constructor(serverId: string, cause: unknown) {
    // The cause is the cipher's reason CLASS ("authentication failed",
    // "unrecognised format", a missing key version) and never a value: those
    // messages are written to be safe to carry, and an operator needs the
    // difference between a rotated key and a corrupted row.
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `the stored credential for MCP server ${serverId} could not be read ` +
        `(${reason}). Reconnecting that server replaces it.`,
    );
    this.name = 'McpCredentialUnreadableError';
  }
}

/**
 * Write the credential for a server, replacing whatever was there.
 *
 * Replacing is the point: this runs on a re-authorization (the user clicked
 * Connect on a server that already had a token, or `NEEDS_REAUTH` needs
 * clearing), and a merged write would leave the *old* refresh token in place
 * when the new grant did not issue one. `null` rather than `undefined` for the
 * optional columns, because Prisma reads `undefined` as "leave this alone" —
 * which is exactly the stale-secret bug this upsert exists to avoid.
 *
 * `authMetadata` follows the same rule for the same reason: a write that has
 * none must leave the column NULL, not inherit the coordinates of whatever
 * grant was stored before it.
 */
export async function storeMcpCredential(
  prisma: Pick<PrismaService, 'mcpCredential'>,
  input: McpCredentialInput,
): Promise<void> {
  const keyring = parseMcpCredentialKey();
  const binding = mcpCredentialBinding(input);
  const fields = {
    accessToken: encryptCredential(input.accessToken, binding, keyring).ciphertext,
    refreshToken:
      input.refreshToken === undefined
        ? null
        : encryptCredential(input.refreshToken, binding, keyring).ciphertext,
    expiresAt: input.expiresAt ?? null,
    scopes: [...input.scopes],
    // `DbNull` rather than a bare `null`: Prisma's nullable Json column wants
    // the SQL NULL sentinel, and a write with no metadata must leave the
    // column absent rather than storing the JSON literal `null` in it.
    authMetadata: input.authMetadata ?? Prisma.DbNull,
  };

  await prisma.mcpCredential.upsert({
    where: { serverId: input.serverId },
    create: { serverId: input.serverId, ...fields, revision: 1 },
    update: { ...fields, revision: { increment: 1 } },
  });
}

/**
 * The credential for a server this user owns, or null when there is none.
 *
 * The `where` carries BOTH fences: `serverId` names the connection instance,
 * and `server: { userId }` proves the caller has it. A credential that exists
 * but belongs to somebody else's server is therefore absent rather than
 * forbidden — the same answer as a server that was never connected, so the
 * response cannot be used to discover which ids exist.
 *
 * A row that cannot be DECRYPTED is a third answer and must not be folded into
 * either of those: it is a `McpCredentialUnreadableError`, because "you have
 * no credential" sends a user to a Connect button while the truth is that one
 * is there and unusable, and silently returning null would dial the server
 * unauthenticated and cache the 401 as a server fault.
 */
export async function readMcpCredential(
  prisma: Pick<PrismaService, 'mcpCredential'>,
  scope: McpCredentialScope,
): Promise<McpCredentialRecord | null> {
  const row = await prisma.mcpCredential.findFirst({
    where: { serverId: scope.serverId, server: { userId: scope.userId } },
    select: {
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
      scopes: true,
      authMetadata: true,
    },
  });
  if (row === null) return null;

  const keyring = parseMcpCredentialKey();
  const binding = mcpCredentialBinding(scope);
  // A blob this build cannot read is treated as absent rather than as an
  // unreadable row, and deliberately: the tokens beside it may be perfectly
  // good, and refusing to dial a working bearer because a refresh coordinate
  // was tampered with would break a server that is working. When a refresh IS
  // needed, the missing blob becomes a refusal that names the fix.
  const metadata = McpAuthMetadataSchema.safeParse(row.authMetadata);
  try {
    return {
      accessToken: decryptCredential(row.accessToken, keyring.activeVersion, binding, keyring),
      refreshToken:
        row.refreshToken === null
          ? null
          : decryptCredential(row.refreshToken, keyring.activeVersion, binding, keyring),
      expiresAt: row.expiresAt,
      scopes: row.scopes,
      authMetadata: metadata.success ? metadata.data : null,
    };
  } catch (error: unknown) {
    if (error instanceof CredentialDecryptError) {
      throw new McpCredentialUnreadableError(scope.serverId, error);
    }
    throw error;
  }
}
