import type { BotPlugin, McpDirectoryEntry, McpServerSummary } from '@crewaid/shared';
import { t } from '../i18n/i18n';

/**
 * The Plugins pane's decisions, with no React in them.
 *
 * The pane renders; this file decides. Two of the three things MCP plugins asks the
 * modal to do are questions about DATA rather than about a screen — which
 * directory entries are already installed, and what a status means to a person
 * — and both are the kind of thing that is easy to get subtly wrong and
 * impossible to see in a screenshot.
 */

/** One row of the pane: a plugin, installed or not, and what it is doing. */
export type PluginRow = {
  /** The stable key — a slug for a curated entry, an id for a private one. */
  readonly key: string;
  readonly name: string;
  readonly slug: string;
  readonly category: string | null;
  readonly iconUrl: string | null;
  /**
   * How it connects, when the list knows: `COMPOSIO` for a toolkit of the
   * live catalog, `DIRECT` for an installed MCP server, `null` for a
   * curated entry that has never been installed (the directory omits the
   * field for them — direct is what installing one means).
   */
  readonly backend: 'DIRECT' | 'COMPOSIO' | null;
  /** Whether this build curates it, which is what "install by slug" needs. */
  readonly curated: boolean;
  /** The installed row, when there is one. */
  readonly server: McpServerSummary | null;
  /** Whether the CURRENT bot has it enabled. `null` when no bot is selected. */
  readonly enabledForBot: boolean | null;
};

/**
 * Merge the catalog with what is installed.
 *
 * Why the join is on slug and happens here
 *
 * `GET /mcp/directory` deliberately carries no "installed" flag: an entry is
 * the same entry for every user, while being installed is per user and per row.
 * So the client joins, and the join key is the slug — which is also
 * the thing that is unique per user and namespaces every tool, so two
 * rows can never collide on it.
 *
 * A private server has no catalog entry at all, so it is appended: the pane
 * shows the curated list in its shipped order, then whatever the operator
 * added by URL. Order is the catalog's and then install order, never a sort by
 * status — a list that reorders itself when a server reconnects is a list an
 * operator loses their place in.
 */
export function mergePlugins(
  directory: readonly McpDirectoryEntry[],
  installed: readonly McpServerSummary[],
  botPlugins: readonly BotPlugin[] | null,
): readonly PluginRow[] {
  const bySlug = new Map(installed.map((server) => [server.slug, server]));
  const enabled = new Map((botPlugins ?? []).map((row) => [row.serverId, row.enabled]));
  const enabledFor = (server: McpServerSummary | null): boolean | null => {
    if (botPlugins === null || server === null) return null;
    return enabled.get(server.id) === true;
  };

  const curated = directory.map((entry): PluginRow => {
    const server = bySlug.get(entry.slug) ?? null;
    return {
      key: entry.slug,
      name: entry.name,
      slug: entry.slug,
      category: entry.category,
      iconUrl: entry.iconUrl,
      backend: server?.backend ?? entry.backend ?? null,
      curated: true,
      server,
      enabledForBot: enabledFor(server),
    };
  });

  const curatedSlugs = new Set(directory.map((entry) => entry.slug));
  const privateRows = installed
    .filter((server) => !curatedSlugs.has(server.slug))
    .map((server): PluginRow => ({
      key: server.id,
      name: server.name,
      slug: server.slug,
      category: server.category,
      iconUrl: server.iconUrl,
      backend: server.backend,
      curated: false,
      server,
      enabledForBot: enabledFor(server),
    }));

  return [...curated, ...privateRows];
}

/** Every category present, in first-seen order, for the filter dropdown. */
export function categoriesOf(rows: readonly PluginRow[]): readonly string[] {
  const seen: string[] = [];
  for (const row of rows) {
    if (row.category !== null && !seen.includes(row.category)) seen.push(row.category);
  }
  return seen;
}

/**
 * The option standing for "no category filter", and its sentinel id.
 *
 * A sentinel rather than a `null` key because React Aria keys are strings —
 * `onSelectionChange` hands back `Key | null`, and an untyped comparison of
 * `"All"` against a vendor category that happens to be named "All" would be a
 * filter that silently selects everything.
 */
export const ALL_CATEGORY_KEY = '\u0000all-categories';
export type CategoryOption = { readonly id: string; readonly label: string };

/** The dropdown's options: no filter first, then every category, sorted. */
export function categoryOptions(rows: readonly PluginRow[]): readonly CategoryOption[] {
  return [
    { id: ALL_CATEGORY_KEY, label: t('plugins.allCategories') },
    ...categoriesOf(rows)
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .map((label) => ({ id: label, label })),
  ];
}

/** How many cards render before the pane stops and says how many it hid. */
export const PLUGIN_RENDER_CAP = 60;

/**
 * The rows a section actually renders.
 *
 * The directory is a live catalog of hundreds of toolkits, and the grid
 * maps rows into DOM without virtualization. Rendering all of them would make
 * every poll reload (two seconds during a connect) re-mount hundreds of cards
 * for a list nobody scrolls to the end of. The cap is honest about it: the
 * pane shows what it cut, and search or the category filter is how the rest
 * are reached — which is exactly how a catalog this size is browsed anyway.
 */
export function capRows(rows: readonly PluginRow[]): {
  readonly visible: readonly PluginRow[];
  readonly hidden: number;
} {
  return {
    visible: rows.slice(0, PLUGIN_RENDER_CAP),
    hidden: Math.max(0, rows.length - PLUGIN_RENDER_CAP),
  };
}

/**
 * Search and category, applied together.
 *
 * The query matches the NAME and the CATEGORY and nothing else. Matching the
 * slug too would make "git" find `github` through a string the operator never
 * sees on this screen, and matching a description would make a filter that
 * hits half the list feel broken rather than generous.
 */
export function filterPlugins(
  rows: readonly PluginRow[],
  query: string,
  category: string | null,
): readonly PluginRow[] {
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  return rows.filter((row) => {
    if (category !== null && row.category !== category) return false;
    if (words.length === 0) return true;
    const haystack = `${row.name} ${row.category ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The "installed count" summary, said rather than counted on screen. */
export function installedSummary(rows: readonly PluginRow[]): string {
  const installed = rows.filter((row) => row.server !== null);
  if (installed.length === 0) return t('plugins.noneInstalled');
  const connected = installed.filter((row) => row.server?.status === 'CONNECTED').length;
  const tools = installed.reduce((total, row) => total + (row.server?.toolCount ?? 0), 0);
  return [
    t('plugins.summary.installed', { count: installed.length }),
    t('plugins.summary.connected', { count: connected }),
    t('plugins.summary.tools', { count: tools }),
  ].join(' · ');
}

/**
 * What a status means to the person reading it, and what they can do about it.
 *
 * M6-fe-03 is this function
 *
 * "NEEDS_REAUTH surfaced as an actionable state, not a raw error." A raw error
 * is `lastError` rendered into a red box: it is the server's own words, it
 * says what failed rather than what to do, and it looks identical to a bug in
 * this app. Every state here therefore carries an ACTION — the label of the
 * button that fixes it — and `lastError` is shown as detail underneath rather
 * than as the headline, because "the token was rejected" is useful to whoever
 * is debugging and useless to whoever has to press something.
 */
export type PluginStatusView = {
  /** Two or three words, for a chip. */
  readonly label: string;
  /** How the chip reads: neutral, working, good, or needs-a-person. */
  readonly tone: 'neutral' | 'progress' | 'good' | 'attention';
  /** One sentence in the second person. Empty when there is nothing to say. */
  readonly sentence: string;
  /** The action that resolves it, or `null` when nothing is required. */
  readonly action: 'connect' | 'reconnect' | 'retry' | 'set-token' | 'restart' | null;
};

export function statusView(server: McpServerSummary | null): PluginStatusView {
  if (server === null) {
    return { label: t('plugins.status.notInstalled'), tone: 'neutral', sentence: '', action: null };
  }
  switch (server.status) {
    case 'CONNECTED':
      return {
        label: t('plugins.status.connected'),
        tone: 'good',
        sentence:
          server.toolCount === 0
            ? t('plugins.status.connected.noTools')
            : t('plugins.status.connected.ready', { count: server.toolCount }),
        action: null,
      };
    case 'CONNECTING':
      // Still an action, because a browser trip can fail where this app cannot
      // see it: a provider that rejects the request shows its own error page and
      // never redirects back, and a closed tab says nothing at all. Without a
      // way out, the card would sit here for the flow's whole ten minutes.
      // Starting over is an ordinary connect — the server replaces the old trip.
      return {
        label: t('plugins.status.connecting'),
        tone: 'progress',
        sentence: t('plugins.status.connecting.line'),
        action: 'restart',
      };
    case 'NEEDS_REAUTH':
      // Two different states wearing one status. A server signed in through a
      // browser gets sent back to the browser; a server holding a bearer has
      // no sign-in to repeat — D-114 made pasting a new token ITS ladder, so
      // offering "Reconnect" would be offering the one thing that cannot fix
      // it. The whole of M6-FE-03 is that the sentence names the real action.
      return server.authType === 'HEADER'
        ? {
            label: t('plugins.status.tokenRejected'),
            tone: 'attention',
            sentence: t('plugins.status.tokenRejected.line'),
            action: 'set-token',
          }
        : {
            label: t('plugins.status.signInAgain'),
            tone: 'attention',
            sentence: t('plugins.status.signInAgain.line'),
            action: 'reconnect',
          };
    case 'ERROR':
      if (server.backend === 'COMPOSIO')
        return {
          label: t('plugins.status.failed'),
          tone: 'attention',
          sentence: t('plugins.status.failed.line'),
          action: 'reconnect',
        };
      return {
        label: t('plugins.status.notResponding'),
        tone: 'attention',
        sentence: t('plugins.status.notResponding.line'),
        action: 'retry',
      };
    case 'DISCONNECTED':
      return {
        // "Installed" was true and said nothing: it sits under a heading that
        // already says Installed, so the one line a card spends on status was
        // spent repeating the section. What the operator needs to know about
        // this row is that it is not connected yet.
        label: t('plugins.status.notConnected'),
        tone: 'neutral',
        sentence: t('plugins.status.notConnected.line'),
        action: 'connect',
      };
  }
}

/**
 * Whether a connect answer needs the browser.
 *
 * A narrowing helper rather than an inline `'authorizeUrl' in response`,
 * because the caller does two very different things with the two shapes and
 * the difference is one word long.
 */
export function authorizeUrlOf(
  response: { authorizeUrl: string } | { connected: true },
): string | null {
  return 'authorizeUrl' in response ? response.authorizeUrl : null;
}

/**
 * How long to keep polling after sending someone to their browser, and how
 * often.
 *
 * Why it stops at all
 *
 * A browser trip can simply not come back: the person closes the tab, or
 * chooses "no". §6/M6 wants the modal to update "with no manual refresh", not
 * to poll forever — a pane that polls an abandoned flow until the app closes
 * spends a request every two seconds on a question nobody is waiting for. The
 * flow's own row expires server-side, so the poll gives up a little
 * after that and says so.
 */
export const CONNECT_POLL_INTERVAL_MS = 2_000;
export const CONNECT_POLL_TIMEOUT_MS = 5 * 60_000;

// The grid, the tiles, and the custom-server form

/**
 * Installed first, then the rest — the split the grid is drawn in.
 *
 * Two sections rather than one list with a status chip, because the operator's
 * two questions are different questions. "What do my bots have, and is any of
 * it broken?" is about a handful of rows and wants every one of them visible;
 * "what else could I add?" is browsing. One list answers the first question by
 * making a person scan the whole catalogue for the two rows that are theirs.
 *
 * Order inside each half is `mergePlugins`' order and deliberately not a sort
 * by status: a grid that reorders itself when a server reconnects is a grid an
 * operator loses their place in — and the reconnect they were watching is
 * exactly when it would move.
 */
export function splitRows(rows: readonly PluginRow[]): {
  readonly installed: readonly PluginRow[];
  readonly available: readonly PluginRow[];
} {
  return {
    installed: rows.filter((row) => row.server !== null),
    available: rows.filter((row) => row.server === null),
  };
}

/** What a plugin's tile shows when there is no icon to show. */
export type PluginTile = {
  /** One or two characters — never more, whatever the name is. */
  readonly initial: string;
  /** A tile colour, stable for a slug across renders and restarts. */
  readonly color: string;
};

/**
 * The tile palette, and why it is a list rather than a hue.
 *
 * This was `hsl(hash % 360, 52%, 42%)`, which is the obvious thing and is
 * wrong twice. A modulo over a small set does not spread: across the twelve
 * plugins this build ships without a mark, EIGHT landed between 82° and 145° —
 * one green band, and three tiles in a row a person cannot tell apart. And a
 * free hue includes the ones white text sits badly on; a yellow-green at 42%
 * lightness is legible in a screenshot and not on a laptop at an angle.
 *
 * So the colours are chosen instead of computed: twelve that are distinct from
 * each other at 32px and carry white text at AA. Indexing a fixed list keeps
 * everything the hue gave us — stable per slug, no state, no assignment to
 * maintain — and gives up only the illusion that every plugin gets a unique
 * colour, which twelve plugins over 360 hues never delivered anyway.
 */
const TILE_COLORS: readonly string[] = [
  '#3B6FD4', // blue
  '#177A63', // teal
  '#8B4BC7', // violet
  '#B03A5B', // rose
  '#1F7A3D', // green
  '#B45309', // amber
  '#2563A8', // steel
  '#7A3FA8', // purple
  '#0F766E', // deep teal
  '#A63D2F', // brick
  '#4B5FA8', // indigo
  '#5C6E1F', // olive
];

/**
 * The tile for a row.
 *
 * Why an initial and not a favicon
 *
 * `iconUrl` is null for every curated entry on purpose: `mcp-directory.ts`
 * refuses to guess one from the host because "an icon URL is a claim that an
 * image renders at that address, and this build has verified none — a broken
 * icon in the modal is a small lie that costs a user's trust in the rest of
 * the card". That reasoning did not change because the layout did. So the tile
 * is an initial over a colour derived from the slug, which is honest about
 * being a placeholder while still giving the grid the rhythm that makes it
 * scannable.
 *
 * The hue is derived rather than assigned so it survives a restart and a
 * reorder: a plugin whose colour changes between sessions is a plugin the
 * operator has to read rather than recognise. `iconUrl` is still rendered when
 * it is non-null — the Composio entries carry the vendor's logo, from the
 * one host every toolkit answers on — so the directory can gain icons for the
 * curated entries later without this screen changing at all.
 */
export function tileOf(row: Pick<PluginRow, 'name' | 'slug'>): PluginTile {
  // FNV-1a over the slug: stable across processes, unlike a string hash that
  // depends on engine internals, and cheap enough to run per render.
  let hash = 0x811c9dc5;
  for (let index = 0; index < row.slug.length; index += 1) {
    hash ^= row.slug.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const letters = row.name.replace(/[^A-Za-z0-9]/g, '');
  return {
    initial: (letters.slice(0, 2) || row.slug.slice(0, 2) || '?').toUpperCase(),
    color: TILE_COLORS[hash % TILE_COLORS.length] ?? TILE_COLORS[0] ?? '#3B6FD4',
  };
}

/** A custom server the operator is describing, before it is submitted. */
export type CustomServerDraft = {
  readonly name: string;
  readonly url: string;
  readonly transport: 'HTTP' | 'SSE';
  /** Blank means the server needs none — `authType` follows this. */
  readonly bearerToken: string;
};

export const EMPTY_CUSTOM_SERVER: CustomServerDraft = {
  name: '',
  url: '',
  transport: 'HTTP',
  bearerToken: '',
};

/**
 * What is wrong with a draft, by field, or nothing.
 *
 * Why the client checks at all, when the server does it properly
 *
 * `admitEndpoint` is the real fence and it is not reproducible here: it
 * resolves the host and refuses private and link-local addresses,
 * which a renderer cannot do and must not pretend to. So this checks only the
 * three things a person can see they got wrong — an empty name, a URL that is
 * not a URL, a URL that is not https — and says so beside the field instead of
 * after a round trip. Everything else is the server's answer, rendered as it
 * comes.
 *
 * https because that is what `admitEndpoint` requires. Saying it here turns a
 * 400 into a sentence next to the box that caused it.
 */
export function validateCustomServer(draft: CustomServerDraft): {
  readonly name?: string;
  readonly url?: string;
} {
  const problems: { name?: string; url?: string } = {};
  if (draft.name.trim() === '') problems.name = t('plugins.custom.nameMissing');

  const url = draft.url.trim();
  if (url === '') {
    problems.url = t('plugins.custom.urlMissing');
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      problems.url = t('plugins.custom.urlInvalid');
      return problems;
    }
    if (parsed.protocol !== 'https:') problems.url = t('plugins.custom.httpsOnly');
  }
  return problems;
}

/** The body `POST /mcp/servers` takes, built from a draft. */
export function customServerBody(draft: CustomServerDraft): {
  name: string;
  url: string;
  transport: 'HTTP' | 'SSE';
  bearerToken?: string;
} {
  const token = draft.bearerToken.trim();
  return {
    name: draft.name.trim(),
    url: draft.url.trim(),
    transport: draft.transport,
    // Omitted rather than sent empty: the field's absence is what makes the
    // server `NONE` instead of a `HEADER` server with a blank secret, and the
    // schema refuses `''` anyway.
    ...(token === '' ? {} : { bearerToken: token }),
  };
}
