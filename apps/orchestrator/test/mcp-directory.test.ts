import { describe, expect, it } from 'vitest';
import {
  McpAuthTypeSchema,
  McpDirectoryEntrySchema,
  McpTransportSchema,
  SlugSchema,
} from '@crewaid/shared';
import {
  CURATED_MCP_SERVERS,
  findCuratedMcpServer,
  toDirectoryEntry,
} from '../src/mcp/mcp-directory.js';
import { deriveMcpSlug } from '../src/mcp/mcp-slug.js';
import { parseEndpoint } from '../src/providers/endpoint-guard.js';

/**
 * M6-BE-02 — the directory is data, and this is the fence around it.
 *
 * Nothing here starts a process or opens a socket: the catalog is a frozen
 * array and the two functions over it are total. What the suite buys is that a
 * bad entry fails the build rather than a user's install — a duplicate slug,
 * an `http://` URL, a transport §6/M6 refuses, or an entry whose wire shape
 * has drifted from the schema the client parses.
 *
 * It cannot check the one thing that matters most about a catalog — that the
 * servers answer — because that is a network call and a test that needs the
 * internet is a test that fails for reasons the code did not cause. The
 * module's own header records what was probed and when, and re-probing is part
 * of adding an entry.
 */

describe('M6-BE-02 — the curated plugin directory', () => {
  it('ships entries at all', () => {
    // An empty catalog would make every assertion below vacuous, and would
    // also mean the modal has nothing to show.
    expect(CURATED_MCP_SERVERS.length).toBeGreaterThan(0);
  });

  it('has a slug per entry, valid and unique', () => {
    const slugs = CURATED_MCP_SERVERS.map((server) => server.slug);
    for (const slug of slugs) {
      expect(SlugSchema.safeParse(slug).success, `${slug} is not a slug`).toBe(true);
    }
    // The slug IS the tool namespace (M6-BE-06), so two entries sharing one
    // would be two servers claiming one prefix.
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('names every entry, in a name a person typed', () => {
    for (const server of CURATED_MCP_SERVERS) {
      expect(server.name.length).toBeGreaterThan(0);
      expect(server.name.trim()).toBe(server.name);
      expect(server.category.length).toBeGreaterThan(0);
    }
  });

  it('points every entry at an admissible https URL', () => {
    for (const server of CURATED_MCP_SERVERS) {
      // `parseEndpoint` is the orchestrator's own rule for a URL it will open
      // a socket to (D-085): https, no embedded credentials, no fragment.
      expect(() => parseEndpoint(server.url), server.name).not.toThrow();
      expect(new URL(server.url).protocol).toBe('https:');
    }
  });

  it('admits only the transports and auth types §6/M6 defines', () => {
    for (const server of CURATED_MCP_SERVERS) {
      expect(McpTransportSchema.safeParse(server.transport).success, server.name).toBe(true);
      expect(McpAuthTypeSchema.safeParse(server.authType).success, server.name).toBe(true);
    }
  });

  it('ships no icon URL that has not been verified', () => {
    // Null renders as an initial and is honest. A guessed favicon path is a
    // broken image in the modal, so an icon may arrive here only as an https
    // URL somebody actually fetched.
    for (const server of CURATED_MCP_SERVERS) {
      if (server.iconUrl === null) continue;
      expect(() => parseEndpoint(server.iconUrl as string), server.name).not.toThrow();
    }
  });

  it('ships at least one NONE entry, so the directory is installable today', () => {
    // Every other entry needs M6-BE-03's OAuth flow before it can do anything.
    // A directory with none of these would be a catalog where the only
    // available action is "install a thing that cannot connect".
    expect(CURATED_MCP_SERVERS.some((server) => server.authType === 'NONE')).toBe(true);
  });

  it('finds an entry by slug, and nothing else', () => {
    for (const server of CURATED_MCP_SERVERS) {
      expect(findCuratedMcpServer(server.slug)).toBe(server);
    }
    expect(findCuratedMcpServer('not-in-this-build')).toBeUndefined();
    expect(findCuratedMcpServer('')).toBeUndefined();
  });

  it('projects an entry onto the §4.1 shape, and nothing else', () => {
    for (const server of CURATED_MCP_SERVERS) {
      const entry = toDirectoryEntry(server);
      // Field-for-field: `url` and `transport` are the installer's business
      // and §4.1's directory entry has no place for them. Asserted on the
      // KEYS, so a spread that grew would fail here rather than ship.
      expect(Object.keys(entry).sort()).toEqual([
        'authType',
        'category',
        'iconUrl',
        'name',
        'slug',
      ]);
      expect(McpDirectoryEntrySchema.safeParse(entry).success).toBe(true);
    }
  });
});

describe('M6-BE-02 — deriving a private server’s slug', () => {
  it('reads a slug out of the name that was typed', () => {
    expect(deriveMcpSlug('Gmail')).toBe('gmail');
    expect(deriveMcpSlug('GitHub Copilot')).toBe('github-copilot');
    expect(deriveMcpSlug('My  Server!')).toBe('my-server');
    expect(deriveMcpSlug('  Padded  ')).toBe('padded');
    // Folded, not truncated: `Café` is `cafe`, never `caf`.
    expect(deriveMcpSlug('Café')).toBe('cafe');
    // A one-letter slug is legal, and `é` IS a letter — folding it must not
    // turn a name into a refusal.
    expect(deriveMcpSlug('é')).toBe('e');
    expect(deriveMcpSlug('Vendor_A')).toBe('vendor-a');
  });

  it('refuses a name with no slug in it rather than inventing one', () => {
    // Each of these would otherwise need a fallback the operator never chose:
    // a URL-derived name, a numeric one, or a 65-character truncation. The
    // 400 that comes of this is the operator picking a usable name.
    expect(deriveMcpSlug('!!!!')).toBeNull();
    // Digits are not enough on their own: SlugSchema requires a leading letter,
    // because the namespace has to read as a word next to the tool name.
    expect(deriveMcpSlug('123')).toBeNull();
    // …and a name that STARTS with one is refused for the same reason rather
    // than silently gaining a letter it did not have.
    expect(deriveMcpSlug('42 App')).toBeNull();
    expect(deriveMcpSlug('   ')).toBeNull();
    expect(deriveMcpSlug('a'.repeat(65))).toBeNull();
  });

  it('only ever returns a string the schema accepts', () => {
    for (const name of ['a', 'A B C', 'x'.repeat(64), '-leading', 'trailing-', '9lives']) {
      const slug = deriveMcpSlug(name);
      if (slug === null) continue;
      expect(SlugSchema.safeParse(slug).success, `${name} → ${slug}`).toBe(true);
    }
  });
});
