import { describe, expect, it } from 'vitest';
import type { BotPlugin, McpDirectoryEntry, McpServerSummary } from '@crewaid/shared';

import {
  authorizeUrlOf,
  categoriesOf,
  customServerBody,
  EMPTY_CUSTOM_SERVER,
  filterPlugins,
  installedSummary,
  mergePlugins,
  splitRows,
  statusView,
  tileOf,
  validateCustomServer,
  type CustomServerDraft,
} from '../src/renderer/settings/pluginsState';
import { markFor, markedSlugs } from '../src/renderer/settings/pluginMarks';

/**
 * M6-FE-01 … FE-03 — the Plugins pane's decisions, without a screen.
 *
 * Two of the three things §6/M6 asks the modal to do are questions about data:
 * which catalog entries are already installed, and what a status means to a
 * person. Both are easy to get subtly wrong and impossible to see in a
 * screenshot, which is why they are here rather than in the render test.
 */

const ENTRY = (over: Partial<McpDirectoryEntry> = {}): McpDirectoryEntry => ({
  name: 'GitHub',
  slug: 'github',
  category: 'Developer Tools',
  iconUrl: null,
  authType: 'OAUTH2',
  ...over,
});

const SERVER = (over: Partial<McpServerSummary> = {}): McpServerSummary => ({
  backend: 'DIRECT',
  access: { mode: 'SELECTED', selectedBotIds: [] },
  id: 'clx1a2b3c4d5e6f7g8h9i0j1',
  name: 'GitHub',
  slug: 'github',
  category: 'Developer Tools',
  iconUrl: null,
  transport: 'HTTP',
  url: 'https://mcp.github.test/mcp',
  isPrivate: false,
  authType: 'OAUTH2',
  status: 'CONNECTED',
  toolCount: 12,
  lastError: null,
  ...over,
});

describe('M6-FE-01 merging the catalog with what is installed', () => {
  it('joins on slug, because the directory carries no installed flag', () => {
    // D-100: an entry is the same entry for every user, while being installed
    // is per user and per row — so the flag would be a second place that fact
    // lived, and the one that goes stale.
    const rows = mergePlugins(
      [ENTRY(), ENTRY({ name: 'Linear', slug: 'linear' })],
      [SERVER()],
      null,
    );

    expect(rows.map((row) => [row.slug, row.server !== null])).toEqual([
      ['github', true],
      ['linear', false],
    ]);
  });

  it('appends a private server, which has no catalog entry at all', () => {
    const custom = SERVER({
      id: 'clx9z8y7x6w5v4u3t2s1r0q9',
      name: 'My Server',
      slug: 'my-server',
      isPrivate: true,
      category: null,
    });

    const rows = mergePlugins([ENTRY()], [SERVER(), custom], null);

    // Catalog order first, then install order — never a sort by status, which
    // would reorder the list under an operator's cursor when a server
    // reconnects.
    expect(rows.map((row) => row.slug)).toEqual(['github', 'my-server']);
    expect(rows[1]?.curated).toBe(false);
  });

  it('carries this bot’s enablement, and says null when there is no bot', () => {
    const server = SERVER();
    const plugins: BotPlugin[] = [
      { serverId: server.id, slug: 'github', name: 'GitHub', enabled: true, toolCount: 12 },
    ];

    expect(mergePlugins([ENTRY()], [server], plugins)[0]?.enabledForBot).toBe(true);
    expect(
      mergePlugins([ENTRY()], [server], [{ ...plugins[0]!, enabled: false }])[0]?.enabledForBot,
    ).toBe(false);
    // No bot selected is not the same as "not enabled": the pane renders no
    // switch at all, rather than an unchecked one that would be a lie.
    expect(mergePlugins([ENTRY()], [server], null)[0]?.enabledForBot).toBeNull();
    // …and an uninstalled entry has nothing to enable.
    expect(mergePlugins([ENTRY()], [], plugins)[0]?.enabledForBot).toBeNull();
  });
});

describe('M6-FE-01 search and category filters', () => {
  const rows = mergePlugins(
    [
      ENTRY(),
      ENTRY({ name: 'Linear', slug: 'linear', category: 'Project Tracking' }),
      ENTRY({ name: 'Sentry', slug: 'sentry', category: 'Developer Tools' }),
    ],
    [],
    null,
  );

  it('lists every category once, in first-seen order', () => {
    expect(categoriesOf(rows)).toEqual(['Developer Tools', 'Project Tracking']);
  });

  it('matches the name and the category, and nothing the operator cannot see', () => {
    expect(filterPlugins(rows, 'lin', null).map((row) => row.slug)).toEqual(['linear']);
    expect(filterPlugins(rows, 'developer', null).map((row) => row.slug)).toEqual([
      'github',
      'sentry',
    ]);
    // Not the slug: "git" finding `github` through a string that is nowhere on
    // this screen reads as the filter doing something arbitrary. The name is
    // the thing being searched, and here it happens to match anyway — so the
    // case that proves it is a slug-only match.
    expect(filterPlugins(rows, 'sentry-io', null)).toEqual([]);
  });

  it('applies the query and the category together', () => {
    expect(filterPlugins(rows, 'sent', 'Developer Tools').map((row) => row.slug)).toEqual([
      'sentry',
    ]);
    // The category narrows even when the query alone would have matched more:
    // "developer" matches both Developer Tools entries by their category text,
    // and this one is filtered out by the category rather than by the words.
    expect(filterPlugins(rows, 'developer', 'Project Tracking')).toEqual([]);
    expect(filterPlugins(rows, '', 'Project Tracking').map((row) => row.slug)).toEqual(['linear']);
    expect(filterPlugins(rows, '   ', null)).toHaveLength(3);
  });
});

describe('M6-FE-01 the installed-count summary', () => {
  it('says nothing is installed when nothing is', () => {
    expect(installedSummary(mergePlugins([ENTRY()], [], null))).toBe('No plugins installed yet.');
  });

  it('counts installed, connected and tools separately', () => {
    // Three numbers rather than one, because they answer different questions
    // and can disagree: a plugin can be installed and not connected, and a
    // connected one can offer nothing.
    const rows = mergePlugins(
      [ENTRY(), ENTRY({ name: 'Linear', slug: 'linear' })],
      [
        SERVER(),
        SERVER({ id: 'clx2b3c4d5e6f7g8h9i0j1k2', slug: 'linear', status: 'ERROR', toolCount: 3 }),
      ],
      null,
    );

    expect(installedSummary(rows)).toBe('2 plugins installed · 1 connected · 15 tools');
  });

  it('keeps the singular singular', () => {
    const rows = mergePlugins([ENTRY()], [SERVER({ toolCount: 1 })], null);
    expect(installedSummary(rows)).toBe('1 plugin installed · 1 connected · 1 tool');
  });
});

describe('M6-FE-03 a status an operator can act on', () => {
  it('turns NEEDS_REAUTH into a sentence and a button, not an error', () => {
    // The whole task. A raw error is `lastError` in a red box: the server's
    // own words, saying what failed rather than what to do, and indis-
    // tinguishable from a bug in this app.
    const view = statusView(SERVER({ status: 'NEEDS_REAUTH', lastError: 'invalid_grant' }));

    expect(view.action).toBe('reconnect');
    expect(view.tone).toBe('attention');
    expect(view.label).toBe('Sign in again');
    expect(view.sentence).toContain('Reconnect');
    // Nothing of the server's own vocabulary is in the sentence a person reads.
    expect(view.sentence).not.toContain('invalid_grant');
    expect(view.sentence).not.toContain('REAUTH');
  });

  it('gives every state that needs a person an action, and the rest none', () => {
    expect(statusView(SERVER({ status: 'DISCONNECTED' })).action).toBe('connect');
    expect(statusView(SERVER({ status: 'ERROR' })).action).toBe('retry');
    expect(statusView(SERVER({ status: 'CONNECTED' })).action).toBeNull();
    // Mid-trip: the modal updates itself, but a trip the provider refused on
    // its own page never comes back, so there is always a way to start over.
    expect(statusView(SERVER({ status: 'CONNECTING' })).action).toBe('restart');
    expect(statusView(null).action).toBeNull();
  });

  it('restarts app sign-in after a failed Composio link instead of refreshing missing tools', () => {
    const view = statusView(SERVER({ backend: 'COMPOSIO', status: 'ERROR', toolCount: 0 }));
    expect(view.label).toBe('Connection failed');
    expect(view.action).toBe('reconnect');
    expect(view.sentence).toContain('reconnect');
  });

  it('says a connected server with no tools is connected, and says so', () => {
    const view = statusView(SERVER({ toolCount: 0 }));
    expect(view.tone).toBe('good');
    expect(view.action).toBeNull();
    expect(view.sentence).toContain('no tools');
  });
});

describe('M6-FE-02 which connect answers need a browser', () => {
  it('narrows the two shapes rather than guessing from a status code', () => {
    expect(authorizeUrlOf({ authorizeUrl: 'https://auth.test/authorize' })).toBe(
      'https://auth.test/authorize',
    );
    expect(authorizeUrlOf({ connected: true })).toBeNull();
  });
});

describe('CC-57 splitting the grid', () => {
  it('puts installed rows first and leaves catalogue order alone', () => {
    const rows = mergePlugins(
      [
        ENTRY({ slug: 'a', name: 'A' }),
        ENTRY({ slug: 'b', name: 'B' }),
        ENTRY({ slug: 'c', name: 'C' }),
      ],
      [SERVER({ slug: 'b', name: 'B' })],
      null,
    );

    const { installed, available } = splitRows(rows);

    expect(installed.map((row) => row.slug)).toEqual(['b']);
    // Order is the catalogue's, not a sort: a grid that reorders when a
    // server reconnects is a grid an operator loses their place in.
    expect(available.map((row) => row.slug)).toEqual(['a', 'c']);
  });

  it('accounts for every row exactly once', () => {
    const rows = mergePlugins(
      [ENTRY({ slug: 'a' }), ENTRY({ slug: 'b' })],
      [SERVER({ slug: 'b' }), SERVER({ slug: 'z', id: 'clzzz1a2b3c4d5e6f7g8h9i0' })],
      null,
    );

    const { installed, available } = splitRows(rows);

    expect(installed.length + available.length).toBe(rows.length);
  });
});

describe('CC-57 the tile', () => {
  it('is the same colour for a slug every time', () => {
    // Derived rather than assigned, so it survives a restart and a reorder: a
    // plugin whose colour changes between sessions has to be read rather than
    // recognised.
    expect(tileOf({ name: 'GitHub', slug: 'github' })).toEqual(
      tileOf({ name: 'GitHub', slug: 'github' }),
    );
  });

  it('gives different plugins different colours', () => {
    const colors = ['github', 'linear', 'notion', 'stripe', 'sentry'].map(
      (slug) => tileOf({ name: slug, slug }).color,
    );
    expect(new Set(colors).size).toBeGreaterThan(1);
  });

  it('draws from the palette rather than computing a hue', () => {
    // It used to be `hsl(hash % 360, …)`, which does not spread over a small
    // set: of the twelve plugins this build ships without a mark, EIGHT landed
    // between 82° and 145°. Three green tiles in a row are one tile.
    const colors = new Set(
      ['amplitude', 'ahrefs', 'attio', 'apify', 'monday', 'runway', 'otter', 'mercury'].map(
        (slug) => tileOf({ name: slug, slug }).color,
      ),
    );
    for (const color of colors) expect(color).toMatch(/^#[0-9A-F]{6}$/i);
    // Not a promise that every plugin differs — twelve colours cannot do that
    // for an unbounded directory, and stability per slug is worth more than
    // uniqueness. The claim is only that they are not all one colour.
    expect(colors.size).toBeGreaterThan(2);
  });

  it('takes two letters, skipping whatever is not one', () => {
    expect(tileOf({ name: '  acme corp', slug: 'acme-corp' }).initial).toBe('AC');
    expect(tileOf({ name: '7 Eleven', slug: 'seven' }).initial).toBe('7E');
  });

  it('falls back to the slug when a name has no letters at all', () => {
    expect(tileOf({ name: '!!!', slug: 'qq' }).initial).toBe('QQ');
  });

  it('always lands on a real palette colour', () => {
    for (const slug of ['a', 'bb', 'ccc', 'dddd', 'github', 'x-y-z', '', 'z'.repeat(80)]) {
      expect(tileOf({ name: slug, slug }).color).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });
});

describe('CC-57 the custom server draft', () => {
  const draft = (over: Partial<CustomServerDraft> = {}): CustomServerDraft => ({
    ...EMPTY_CUSTOM_SERVER,
    name: 'Acme',
    url: 'https://mcp.acme.test/mcp',
    ...over,
  });

  it('accepts a name and an https URL', () => {
    expect(validateCustomServer(draft())).toEqual({});
  });

  it('asks for a name, because the tools are named after it', () => {
    expect(validateCustomServer(draft({ name: '   ' })).name).toBeDefined();
  });

  it('refuses http, which is what admitEndpoint would refuse anyway', () => {
    // The client checks only what a person can SEE they got wrong. The real
    // fence resolves the host and refuses private addresses (D-085), which a
    // renderer cannot do and must not pretend to.
    expect(validateCustomServer(draft({ url: 'http://mcp.acme.test/mcp' })).url).toBe(
      'It has to be https.',
    );
  });

  it('refuses something that is not a URL at all', () => {
    expect(validateCustomServer(draft({ url: 'mcp.acme.test' })).url).toBeDefined();
  });

  it('omits the token entirely when it is blank, rather than sending empty', () => {
    // The field's ABSENCE is what makes the server NONE instead of a HEADER
    // server holding a blank secret (D-114) — and the schema refuses '' too.
    expect(customServerBody(draft({ bearerToken: '   ' }))).toEqual({
      name: 'Acme',
      url: 'https://mcp.acme.test/mcp',
      transport: 'HTTP',
    });
  });

  it('trims what it sends', () => {
    expect(
      customServerBody(
        draft({ name: '  Acme  ', url: '  https://x.test/mcp  ', bearerToken: ' t ' }),
      ),
    ).toEqual({
      name: 'Acme',
      url: 'https://x.test/mcp',
      transport: 'HTTP',
      bearerToken: 't',
    });
  });
});

describe('CC-57 a header server’s NEEDS_REAUTH is a different state', () => {
  it('asks for a token rather than a reconnect', () => {
    const view = statusView(SERVER({ authType: 'HEADER', status: 'NEEDS_REAUTH' }));

    expect(view.action).toBe('set-token');
    expect(view.sentence).toContain('Add a new one');
  });

  it('still asks an OAuth server to reconnect', () => {
    expect(statusView(SERVER({ authType: 'OAUTH2', status: 'NEEDS_REAUTH' })).action).toBe(
      'reconnect',
    );
  });
});

describe('CC-60 the bundled brand marks', () => {
  it('ships a mark for every plugin whose file is in the folder', () => {
    // The folder IS the registry (CC-61): `notion.svg` is the mark for the
    // plugin slugged `notion`, resolved by import.meta.glob at build time. The
    // map it replaced had to be regenerated by hand, so a dozen icons were
    // dropped in and silently never drawn.
    expect(markFor('notion')).toBeTruthy();
    expect(markFor('amplitude')).toBeTruthy();
    expect(markFor('monday')).toBeTruthy();
  });

  it('has none for a slug the folder does not cover', () => {
    // Expected, not a gap: the tile falls back to the initial.
    expect(markFor('not-a-plugin')).toBeUndefined();
    expect(markFor('')).toBeUndefined();
  });

  it('keys every mark on a slug the directory actually ships', () => {
    // A mark keyed on a slug nothing uses is a file in the bundle that can
    // never render — and the mistake is silent, because a missing key just
    // falls through to the initial.
    // A file named anything else is a file that can never render, and the
    // mistake is silent — a missing key just falls through to the initial.
    for (const slug of markedSlugs()) {
      expect(slug).toMatch(/^[a-z][a-z0-9-]*$/);
    }
    expect(markedSlugs().length).toBeGreaterThan(20);
  });
});
