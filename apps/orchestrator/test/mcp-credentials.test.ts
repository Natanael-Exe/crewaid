import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { decryptCredential, encryptCredential } from '../src/credentials/credential-cipher.js';
import {
  MCP_CREDENTIAL_KEY_VERSION,
  parseMcpCredentialKey,
} from '../src/credentials/mcp-keyring.js';
import { KeyringConfigError } from '../src/credentials/keyring.js';
import {
  McpCredentialUnreadableError,
  mcpCredentialBinding,
  readMcpCredential,
  storeMcpCredential,
} from '../src/mcp/mcp-credentials.js';

/**
 * M6-BE-04 — the credential seam, at the level where the values are visible.
 *
 * ── WHY THIS SUITE IS A FAKE AND NOT A DATABASE ─────────────────────────────
 *
 * The two facts worth proving here are "what string was handed to Prisma" and
 * "what `where` clause was used to ask for it back" — both of which are the
 * ARGUMENTS to a call, not the state of a row. A fake captures them exactly,
 * runs everywhere, and needs no Postgres; the row-level behaviour (a foreign
 * principal really gets nothing back) is asserted in the integration suites,
 * where a real database answers.
 *
 * The threat this file exists for is a single sentence: a stored token must not
 * be readable by anything that has not first proved it owns the server.
 */

const USER = `usr_${randomUUID()}`;
const OTHER_USER = `usr_${randomUUID()}`;
const SERVER = `srv_${randomUUID()}`;
const OTHER_SERVER = `srv_${randomUUID()}`;
const ACCESS = `tok_${randomUUID()}`;
const REFRESH = `ref_${randomUUID()}`;
const KEY = 'ab'.repeat(32);

type Row = {
  serverId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
  /** `Prisma.DbNull`, or the plain object this module wrote. */
  authMetadata: unknown;
};

type Captured = {
  upserts: { where: { serverId: string }; create: Row; update: Omit<Row, 'serverId'> }[];
  findFirsts: { where: unknown; select: unknown }[];
};

/**
 * A Prisma stand-in for exactly the two calls this module makes.
 *
 * The relation filter is emulated the way the database does it, because
 * emulating it is the whole point: `server: { userId }` must be what decides
 * whether a row comes back, so a call site that forgot the owner would look
 * exactly as broken here as it would in production.
 */
function fakePrisma(owners: Map<string, string>): {
  prisma: PrismaService;
  captured: Captured;
  /** The stored rows, so a case can put something in the column by hand. */
  rows: Map<string, Row>;
} {
  const rows = new Map<string, Row>();
  const captured: Captured = { upserts: [], findFirsts: [] };

  const prisma = {
    mcpCredential: {
      upsert: (args: {
        where: { serverId: string };
        create: Row;
        update: Omit<Row, 'serverId'>;
      }) => {
        captured.upserts.push(args);
        rows.set(args.where.serverId, { ...args.create });
        return Promise.resolve(rows.get(args.where.serverId));
      },
      findFirst: (args: { where: { serverId: string; server: { userId: string } } }) => {
        captured.findFirsts.push(args);
        const row = rows.get(args.where.serverId);
        const owner = owners.get(args.where.serverId);
        if (row === undefined || owner !== args.where.server.userId) return Promise.resolve(null);
        return Promise.resolve(row);
      },
    },
  } as unknown as PrismaService;

  return { prisma, captured, rows };
}

let saved: string | undefined;

beforeEach(() => {
  saved = process.env['CREDENTIAL_KEY'];
  process.env['CREDENTIAL_KEY'] = KEY;
});

afterEach(() => {
  if (saved === undefined) delete process.env['CREDENTIAL_KEY'];
  else process.env['CREDENTIAL_KEY'] = saved;
});

describe('M6-BE-04 — the MCP credential key', () => {
  it('reads a 64-hex secret into a one-version ring', () => {
    const ring = parseMcpCredentialKey({ CREDENTIAL_KEY: KEY });

    expect(ring.activeVersion).toBe(MCP_CREDENTIAL_KEY_VERSION);
    expect(ring.versions).toEqual([MCP_CREDENTIAL_KEY_VERSION]);
    expect(ring.keyFor(MCP_CREDENTIAL_KEY_VERSION)).toEqual(Buffer.from(KEY, 'hex'));
    // Nothing else is loadable — there is one secret, so there is one answer.
    expect(ring.keyFor(MCP_CREDENTIAL_KEY_VERSION + 1)).toBeUndefined();
  });

  it('names the variable and its shape when the key is missing', () => {
    expect(() => parseMcpCredentialKey({})).toThrow(KeyringConfigError);
    expect(() => parseMcpCredentialKey({})).toThrow(/CREDENTIAL_KEY is not set/);
  });

  it('refuses anything that is not 64 hex characters, without echoing the value', () => {
    const short = 'ab'.repeat(31);
    expect(() => parseMcpCredentialKey({ CREDENTIAL_KEY: short })).toThrow(/64 hex characters/);

    const notHex = 'zz'.repeat(32);
    let message = '';
    try {
      parseMcpCredentialKey({ CREDENTIAL_KEY: notHex });
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).toContain('CREDENTIAL_KEY');
    // The message must never quote the secret — not even a rejected one, which
    // is the one an operator is most likely to paste into a bug report.
    expect(message).not.toContain(notHex);
  });
});

describe('M6-BE-04 — a credential is ciphertext before it reaches Prisma', () => {
  it('writes something that is not the token, and reads the token back', async () => {
    const { prisma, captured } = fakePrisma(new Map([[SERVER, USER]]));

    await storeMcpCredential(prisma, {
      userId: USER,
      serverId: SERVER,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: null,
      scopes: ['issues.read'],
    });

    const written = captured.upserts[0]!.create;
    expect(written.accessToken).not.toBe(ACCESS);
    expect(written.accessToken).not.toContain(ACCESS);
    expect(written.refreshToken).not.toContain(REFRESH);
    // The format tag, so a row that predates encryption is distinguishable
    // from one that was written by this module (M6-BE-03 stored plaintext).
    expect(written.accessToken.startsWith('g1.')).toBe(true);
    expect(written.refreshToken?.startsWith('g1.')).toBe(true);

    const read = await readMcpCredential(prisma, { userId: USER, serverId: SERVER });
    expect(read?.accessToken).toBe(ACCESS);
    expect(read?.refreshToken).toBe(REFRESH);
    expect(read?.scopes).toEqual(['issues.read']);
  });

  it('gives the same token two different ciphertexts', async () => {
    const { prisma, captured } = fakePrisma(new Map([[SERVER, USER]]));
    const input = { userId: USER, serverId: SERVER, accessToken: ACCESS, scopes: [] };

    await storeMcpCredential(prisma, input);
    await storeMcpCredential(prisma, input);

    // A fresh nonce per write. Equal ciphertexts would mean a reused nonce,
    // which in GCM leaks the XOR of the two plaintexts rather than merely
    // looking untidy.
    expect(captured.upserts[0]!.create.accessToken).not.toBe(
      captured.upserts[1]!.create.accessToken,
    );
  });

  it('stores a missing refresh token as NULL rather than leaving the old one', async () => {
    const { prisma, captured } = fakePrisma(new Map([[SERVER, USER]]));

    await storeMcpCredential(prisma, {
      userId: USER,
      serverId: SERVER,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      scopes: [],
    });
    await storeMcpCredential(prisma, {
      userId: USER,
      serverId: SERVER,
      accessToken: ACCESS,
      scopes: [],
    });

    // `undefined` would mean "leave the column alone" to Prisma, which is the
    // stale-secret bug: a re-authorization that issued no refresh token would
    // keep the previous grant's.
    expect(captured.upserts[1]!.update.refreshToken).toBeNull();
    const read = await readMcpCredential(prisma, { userId: USER, serverId: SERVER });
    expect(read?.refreshToken).toBeNull();
  });

  it('leaves the non-secret columns in the clear', async () => {
    const { prisma, captured } = fakePrisma(new Map([[SERVER, USER]]));
    const expiresAt = new Date('2026-09-22T00:00:00.000Z');

    await storeMcpCredential(prisma, {
      userId: USER,
      serverId: SERVER,
      accessToken: ACCESS,
      expiresAt,
      scopes: ['a', 'b'],
    });

    // §7.3 is about tokens. Encrypting an expiry would make M6-BE-05's
    // "is this about to expire" query impossible to write in SQL, and a scope
    // list is not a credential.
    expect(captured.upserts[0]!.create.expiresAt).toEqual(expiresAt);
    expect(captured.upserts[0]!.create.scopes).toEqual(['a', 'b']);
  });
});

describe('M6-BE-04 — a credential belongs to a server AND a principal', () => {
  it('asks the database for the owner, not just the row', async () => {
    const { prisma, captured } = fakePrisma(new Map([[SERVER, USER]]));

    await readMcpCredential(prisma, { userId: USER, serverId: SERVER });

    // The fence has to be in the QUERY. Checking the owner after the read is
    // the shape D-010 closed ten routes for: it works until one call site
    // forgets, and then the row is already in memory.
    expect(captured.findFirsts[0]!.where).toMatchObject({
      serverId: SERVER,
      server: { userId: USER },
    });
  });

  it('returns nothing when the server belongs to somebody else', async () => {
    const { prisma } = fakePrisma(new Map([[SERVER, OTHER_USER]]));
    await storeMcpCredential(prisma, {
      userId: OTHER_USER,
      serverId: SERVER,
      accessToken: ACCESS,
      scopes: [],
    });

    expect(await readMcpCredential(prisma, { userId: USER, serverId: SERVER })).toBeNull();
  });

  it('binds the ciphertext to the principal as well as the row', () => {
    const ring = parseMcpCredentialKey({ CREDENTIAL_KEY: KEY });

    const { ciphertext } = encryptCredential(
      ACCESS,
      mcpCredentialBinding({ userId: OTHER_USER, serverId: SERVER }),
      ring,
    );

    // Two users could one day hold credentials against the same server row
    // (M9), and a ciphertext moving between them must fail as a tamper rather
    // than decrypt into somebody else's bearer.
    expect(() =>
      decryptCredential(
        ciphertext,
        MCP_CREDENTIAL_KEY_VERSION,
        mcpCredentialBinding({ userId: USER, serverId: SERVER }),
        ring,
      ),
    ).toThrow(/authentication failed/);
  });

  it('binds the ciphertext to the row as well as the principal', () => {
    const ring = parseMcpCredentialKey({ CREDENTIAL_KEY: KEY });
    const { ciphertext } = encryptCredential(
      ACCESS,
      mcpCredentialBinding({ userId: USER, serverId: OTHER_SERVER }),
      ring,
    );

    expect(() =>
      decryptCredential(
        ciphertext,
        MCP_CREDENTIAL_KEY_VERSION,
        mcpCredentialBinding({ userId: USER, serverId: SERVER }),
        ring,
      ),
    ).toThrow(/authentication failed/);
  });
});

describe('M6-BE-05 — what a refresh needs, beside the tokens it refreshes', () => {
  const METADATA = {
    tokenEndpoint: 'https://auth.example.test/tenant/token',
    clientId: 'client-abc',
    resource: 'https://mcp.example.test/mcp',
  };

  it('writes the three coordinates in the clear and reads them back', async () => {
    const { prisma, captured } = fakePrisma(new Map([[SERVER, USER]]));

    await storeMcpCredential(prisma, {
      userId: USER,
      serverId: SERVER,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      scopes: [],
      authMetadata: METADATA,
    });

    // NOT encrypted, unlike the two columns beside it: a public PKCE client's
    // id, a URL the browser already visited and the server's own URL are not
    // credentials (D-103). A ciphertext here would also make a failed refresh
    // undiagnosable without the key.
    expect(captured.upserts[0]!.create.authMetadata).toEqual(METADATA);
    expect(captured.upserts[0]!.create.accessToken).not.toContain(METADATA.clientId);

    const read = await readMcpCredential(prisma, { userId: USER, serverId: SERVER });
    expect(read?.authMetadata).toEqual(METADATA);
  });

  it('stores no metadata as NULL rather than leaving the previous one', async () => {
    const { prisma, captured } = fakePrisma(new Map([[SERVER, USER]]));

    await storeMcpCredential(prisma, {
      userId: USER,
      serverId: SERVER,
      accessToken: ACCESS,
      scopes: [],
      authMetadata: METADATA,
    });
    await storeMcpCredential(prisma, {
      userId: USER,
      serverId: SERVER,
      accessToken: ACCESS,
      scopes: [],
    });

    // The same trap the refresh token is written against: `undefined` would
    // mean "leave the column alone" to Prisma, so a credential stored without
    // coordinates would inherit the previous grant's.
    expect(captured.upserts[1]!.update.authMetadata).toBe(Prisma.DbNull);
    const read = await readMcpCredential(prisma, { userId: USER, serverId: SERVER });
    expect(read?.authMetadata).toBeNull();
  });

  it('treats a blob it cannot read as no metadata, and still returns the token', async () => {
    const { prisma, rows } = fakePrisma(new Map([[SERVER, USER]]));
    await storeMcpCredential(prisma, {
      userId: USER,
      serverId: SERVER,
      accessToken: ACCESS,
      scopes: [],
      authMetadata: METADATA,
    });
    // Somebody edited the column by hand, or a later build wrote a shape this
    // one does not know. The TOKENS beside it are still good, so a working
    // bearer must not be refused over it — the refresh path is where a missing
    // blob becomes a refusal that names the fix.
    rows.get(SERVER)!.authMetadata = { tokenEndpoint: 'not-a-url' };

    const read = await readMcpCredential(prisma, { userId: USER, serverId: SERVER });
    expect(read?.authMetadata).toBeNull();
    expect(read?.accessToken).toBe(ACCESS);
  });

  it('reads a row written before this task as no metadata, not as unreadable', async () => {
    const { prisma } = fakePrisma(new Map([[SERVER, USER]]));
    // A row from M6-BE-03/04: real ciphertext, no coordinates column. It is
    // usable until its token expires, and then the refresh refuses with the
    // one fix that exists — a reconnect — rather than a raw error.
    await storeMcpCredential(prisma, {
      userId: USER,
      serverId: SERVER,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      scopes: [],
    });

    const read = await readMcpCredential(prisma, { userId: USER, serverId: SERVER });
    expect(read?.authMetadata).toBeNull();
    expect(read?.refreshToken).toBe(REFRESH);
  });
});

describe('M6-BE-04 — a row that cannot be read is an error, not a silence', () => {
  it('refuses a plaintext row left by the task before this one', async () => {
    // Exactly what M6-BE-03 wrote into this column: the token itself.
    const legacy = {
      mcpCredential: {
        findFirst: () =>
          Promise.resolve({
            accessToken: ACCESS,
            refreshToken: null,
            expiresAt: null,
            scopes: [],
          }),
      },
    } as unknown as PrismaService;

    await expect(readMcpCredential(legacy, { userId: USER, serverId: SERVER })).rejects.toThrow(
      McpCredentialUnreadableError,
    );
  });

  it('refuses a tampered ciphertext instead of returning something plausible', async () => {
    const { prisma, captured } = fakePrisma(new Map([[SERVER, USER]]));
    await storeMcpCredential(prisma, {
      userId: USER,
      serverId: SERVER,
      accessToken: ACCESS,
      scopes: [],
    });

    const written = captured.upserts[0]!.create.accessToken;
    const parts = written.split('.');
    const body = parts[2]!;
    parts[2] = `${body.slice(0, -1)}${body.endsWith('A') ? 'B' : 'A'}`;
    const tampered = parts.join('.');

    const { prisma: withTampered } = fakePrisma(new Map([[SERVER, USER]]));
    const serving = {
      mcpCredential: {
        findFirst: () =>
          Promise.resolve({
            accessToken: tampered,
            refreshToken: null,
            expiresAt: null,
            scopes: [],
          }),
      },
    } as unknown as PrismaService;

    await expect(readMcpCredential(serving, { userId: USER, serverId: SERVER })).rejects.toThrow(
      /could not be read/,
    );
  });

  it('keeps the token out of the failure it reports', async () => {
    const serving = {
      mcpCredential: {
        findFirst: () =>
          Promise.resolve({
            accessToken: `${ACCESS}-not-a-ciphertext`,
            refreshToken: null,
            expiresAt: null,
            scopes: [],
          }),
      },
    } as unknown as PrismaService;

    let thrown: unknown;
    try {
      await readMcpCredential(serving, { userId: USER, serverId: SERVER });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpCredentialUnreadableError);
    const message = (thrown as Error).message;
    expect(message).not.toContain(ACCESS);
    expect(message).not.toContain(KEY);
    // Actionable: the caller is told which server and what fixes it.
    expect(message).toContain(SERVER);
    expect(message).toContain('Reconnecting');
  });

  it('refuses to write at all when the key is missing', async () => {
    delete process.env['CREDENTIAL_KEY'];
    const { prisma, captured } = fakePrisma(new Map([[SERVER, USER]]));

    await expect(
      storeMcpCredential(prisma, {
        userId: USER,
        serverId: SERVER,
        accessToken: ACCESS,
        scopes: [],
      }),
    ).rejects.toThrow(KeyringConfigError);
    // Nothing reached the database, so a misconfigured key cannot leave a
    // plaintext credential behind on the way out.
    expect(captured.upserts).toHaveLength(0);
  });
});
