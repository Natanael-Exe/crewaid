import { Button, ListBox, ListBoxItem, SearchField, Select, Spinner, Switch } from '@heroui/react';
import { IconAlertTriangle, IconPlus } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  Bot,
  PluginAccess,
  BotPlugin,
  McpDirectoryEntry,
  McpServerSummary,
} from '@crewaid/shared';

import {
  connectServer,
  failureOf,
  installServer,
  listBotPlugins,
  listBots,
  listDirectory,
  listServers,
  refreshServerTools,
  setBotPlugins,
  setPluginAccess,
  setServerCredential,
  uninstallServer,
  useApiClient,
  type ApiClient,
} from '../api';
import { systemBrowser } from '../bridge';
import {
  ALL_CATEGORY_KEY,
  authorizeUrlOf,
  capRows,
  categoryOptions,
  customServerBody,
  EMPTY_CUSTOM_SERVER,
  splitRows,
  tileOf,
  validateCustomServer,
  type CustomServerDraft,
  type CategoryOption,
  CONNECT_POLL_INTERVAL_MS,
  CONNECT_POLL_TIMEOUT_MS,
  filterPlugins,
  installedSummary,
  mergePlugins,
  statusView,
  type PluginRow,
} from './pluginsState';
import { PluginAccessEditor, accessSummary } from './PluginAccessEditor';
import { markFor } from './pluginMarks';
import { SETTINGS_INPUT_CLASS, SettingsRow, SettingsSection } from './SettingsLayout';
import { type MessageKey, useT } from '../i18n/i18n';

/**
 * Plugins — the modal MCP plugins asks for (, FE-02, FE-03).
 *
 * "search, category filters, install, connect, and an installed-count summary",
 * plus the two things the milestone needs that its FE tasks do not name: the
 * per-bot enablement `PUT /bots/:id/plugins` exists for, and uninstall. A
 * plugin an operator can install and connect but cannot give to a bot is a
 * feature that does nothing, so it is here — flagged rather than smuggled.
 *
 * Why one screen and not two
 *
 * Installing is per USER and enabling is per BOT, which argues for two places.
 * It is the wrong split for the question an operator actually has, which is
 * "which plugins does this bot have?" — and answering it across two screens
 * means the checkbox and the thing it is about are never visible together.
 * So the list is one list: every plugin this build offers, its installed
 * state, and — when a bot is selected — whether that bot uses it.
 *
 * Why every action refetches
 *
 * Same reasoning as `ConnectionsPane`: a connect moves `status` and fills
 * `toolCount`, an install adds a row, and a refresh can change both. Splicing
 * a returned row into a cached list would be constructing a view the server
 * never agreed to. Refetching costs one call on an action a person took by
 * hand.
 */

export type PluginActions = {
  readonly setAccess: (serverId: string, access: PluginAccess) => Promise<void>;
  readonly install: (row: PluginRow) => Promise<void>;
  readonly uninstall: (serverId: string) => Promise<void>;
  /** Resolves to an authorize URL when a browser trip is needed. */
  readonly connect: (serverId: string) => Promise<string | null>;
  readonly retry: (serverId: string) => Promise<void>;
  readonly setEnabled: (serverIds: readonly string[]) => Promise<void>;
  /** Install a server this build does not curate. */
  readonly addCustom: (draft: CustomServerDraft) => Promise<void>;
  /** Replace a header server's bearer. */
  readonly setToken: (serverId: string, token: string) => Promise<void>;
};

/**
 * The form the pane is showing instead of the grid.
 *
 * A value rather than a boolean because the pane will grow a second form
 * before it grows a second flag — and a `null | 'custom'` union is a compile
 * error at every branch when that happens, where `addingCustom === false`
 * would silently mean "showing something else".
 */
export type AddingView = 'custom';

/** The key a custom install's busy state and failure hang off. */
export const ADD_KEY = '\u0000add-custom';

export type PluginsPaneProps = {
  /** The bot whose enablement this pane edits, or `null` for none. */
  readonly botId?: string | null;
  readonly botName?: string | null;
  /** Seams for tests; production uses the live client. */
  readonly load?: () => Promise<{
    readonly directory: readonly McpDirectoryEntry[];
    readonly servers: readonly McpServerSummary[];
    readonly botPlugins: readonly BotPlugin[] | null;
    readonly bots?: readonly Pick<Bot, 'id' | 'name'>[];
  }>;
  readonly act?: PluginActions;
  /** Opens a URL in the system browser. Defaults to the preload bridge. */
  readonly openBrowser?: (url: string) => Promise<{ readonly status: string }>;
};

/**
 * The live wiring, exported so it can be asserted.
 *
 * Injecting `act` lets a test drive the pane without a network, which is right
 * for the pane's behaviour and wrong for this: what this function can get
 * wrong is the MAPPING — installing a private row by slug, enabling by the
 * wrong id — and a test that only ever sees a fake cannot notice.
 */
export function liveActions(client: ApiClient, botId: string | null): PluginActions {
  return {
    setAccess: async (serverId, access) => {
      await setPluginAccess(client, serverId, access);
    },
    install: async (row) => {
      // A curated entry installs by slug; there is no other shape for one, and
      // a private row is already installed by definition (it exists only
      // because somebody added it by URL).
      await installServer(client, { slug: row.slug });
    },
    uninstall: async (serverId) => {
      await uninstallServer(client, serverId);
    },
    connect: async (serverId) => authorizeUrlOf(await connectServer(client, serverId)),
    retry: async (serverId) => {
      await refreshServerTools(client, serverId);
    },
    setEnabled: async (serverIds) => {
      if (botId === null) return;
      await setBotPlugins(client, botId, serverIds);
    },
    addCustom: async (draft) => {
      await installServer(client, customServerBody(draft));
    },
    setToken: async (serverId, token) => {
      await setServerCredential(client, serverId, token);
    },
  };
}

type PaneState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly rows: readonly PluginRow[];
      readonly bots: readonly Pick<Bot, 'id' | 'name'>[];
    }
  | { readonly status: 'failed'; readonly message: string };

export function PluginsPane({
  botId = null,
  botName = null,
  load,
  act,
  openBrowser,
}: PluginsPaneProps) {
  const t = useT();
  const client = useApiClient();
  const [state, setState] = useState<PaneState>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** Keyed by row key; a failure belongs beside the row that refused. */
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>({});
  /** Server ids whose browser trip is still out. */
  const [awaiting, setAwaiting] = useState<readonly string[]>([]);
  /** The form showing instead of the grid, or null. */
  const [adding, setAdding] = useState<AddingView | null>(null);
  const [editingAccess, setEditingAccess] = useState<string | null>(null);
  /** Per server, which poll is the current one; see `pollUntilSettled`. */
  const pollGenerations = useRef(new Map<string, number>());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    const generations = pollGenerations.current;
    return () => {
      mountedRef.current = false;
      generations.clear();
    };
  }, []);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  const reload = useCallback(async (): Promise<readonly PluginRow[]> => {
    const fetchAll =
      loadRef.current ??
      (async () => {
        const [directory, servers, botPlugins, bots] = await Promise.all([
          listDirectory(client),
          listServers(client),
          botId === null ? Promise.resolve(null) : listBotPlugins(client, botId),
          listBots(client),
        ]);
        return { directory, servers, botPlugins, bots };
      });
    const { directory, servers, botPlugins, bots = [] } = await fetchAll();
    const rows = mergePlugins(directory, servers, botPlugins);
    if (mountedRef.current) setState({ status: 'ready', rows, bots });
    return rows;
  }, [client, botId]);

  useEffect(() => {
    void reload().catch((error: unknown) => {
      if (mountedRef.current) setState({ status: 'failed', message: failureOf(error).message });
    });
  }, [reload]);

  const actions = useMemo(() => act ?? liveActions(client, botId), [act, client, botId]);

  /** Returns whether the work succeeded, for the callers that branch on it. */
  const run = useCallback(
    async (key: string, work: () => Promise<void>): Promise<boolean> => {
      setBusyKey(key);
      setProblems((current) => ({ ...current, [key]: '' }));
      try {
        await work();
        await reload();
        return true;
      } catch (error: unknown) {
        setProblems((current) => ({ ...current, [key]: failureOf(error).message }));
        return false;
      } finally {
        setBusyKey(null);
      }
    },
    [reload],
  );

  /**
   * "Connecting an OAuth server opens the system browser, and on
   * completion the server reaches CONNECTED … with no manual refresh."
   *
   * The trip finishes in a browser this app does not own, minutes later, so
   * the only thing the pane can do is ask again. It stops asking after
   * `CONNECT_POLL_TIMEOUT_MS` — an abandoned tab must not cost a request every
   * two seconds until the app closes — and the flow's own row expires
   * server-side well before that.
   */
  const pollUntilSettled = useCallback(
    async (serverId: string): Promise<void> => {
      // Starting over while a trip is out begins a second poll for the same
      // server. The older loop steps aside rather than running beside it —
      // otherwise its deadline, counted from the FIRST click, would report the
      // new trip as abandoned, and its exit would clear the newer one's
      // "waiting" state.
      const generation = (pollGenerations.current.get(serverId) ?? 0) + 1;
      pollGenerations.current.set(serverId, generation);
      const superseded = (): boolean =>
        !mountedRef.current || pollGenerations.current.get(serverId) !== generation;
      const deadline = Date.now() + CONNECT_POLL_TIMEOUT_MS;
      setAwaiting((current) => (current.includes(serverId) ? current : [...current, serverId]));
      try {
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, CONNECT_POLL_INTERVAL_MS));
          if (superseded()) return;
          const rows = await reload();
          if (superseded()) return;
          const status = rows.find((row) => row.server?.id === serverId)?.server?.status;
          // Anything but CONNECTING is an answer — including the row being
          // gone, which is what an uninstall mid-trip looks like.
          if (status !== 'CONNECTING') return;
          if (Date.now() > deadline) {
            setProblems((current) => ({
              ...current,
              [serverId]: t('plugins.signInLost'),
            }));
            return;
          }
        }
      } finally {
        if (!superseded()) setAwaiting((current) => current.filter((id) => id !== serverId));
      }
    },
    [reload],
  );

  const connect = useCallback(
    async (row: PluginRow): Promise<void> => {
      const server = row.server;
      if (server === null) return;
      const connected = await run(row.key, async () => {
        const authorizeUrl = await actions.connect(server.id);
        if (authorizeUrl === null) return;
        const open = openBrowser ?? systemBrowser.open;
        const result = await open(authorizeUrl);
        if (result.status !== 'opened') {
          // Named rather than swallowed: the person is about to wait for a
          // browser that never opened, and this is the one moment they can
          // still be told.
          throw new Error(t('plugins.browserFailed'));
        }
      });
      if (connected) void pollUntilSettled(server.id);
    },
    [actions, openBrowser, pollUntilSettled, run],
  );

  const toggleForBot = useCallback(
    async (rows: readonly PluginRow[], row: PluginRow): Promise<void> => {
      const server = row.server;
      if (server === null || row.enabledForBot === null) return;
      // The route REPLACES the set, so the body is the whole desired
      // state — computed from what is on screen rather than from a diff
      // nobody holds.
      const next = rows
        .filter((candidate) =>
          candidate.server === null
            ? false
            : candidate.server.id === server.id
              ? !row.enabledForBot
              : candidate.enabledForBot === true,
        )
        .map((candidate) => candidate.server?.id ?? '');
      await run(row.key, () => actions.setEnabled(next));
    },
    [actions, run],
  );

  if (state.status === 'loading') {
    return (
      <div className="flex justify-center py-10">
        <Spinner aria-label={t('plugins.loading')} />
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <div className="flex items-start gap-2 rounded-card bg-surface-secondary p-4 text-[13px] text-foreground">
        <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" stroke={1.8} />
        <span>{state.message}</span>
      </div>
    );
  }

  const rows = state.rows;
  const edited = rows.find((row) => row.server?.id === editingAccess);
  if (edited?.server)
    return (
      <PluginAccessEditor
        key={edited.server.id}
        name={edited.name}
        access={edited.server.access}
        bots={state.bots}
        backend={edited.server.backend}
        busy={busyKey === edited.key}
        problem={problems[edited.key] ?? ''}
        onCancel={() => setEditingAccess(null)}
        onSave={(access) => {
          void (async () => {
            const id = edited.server?.id;
            if (id === undefined) return;
            const ok = await run(edited.key, () => actions.setAccess(id, access));
            if (ok) setEditingAccess(null);
          })();
        }}
      />
    );
  return (
    <PluginsPaneView
      adding={adding}
      onAdd={() => {
        // The failure from a previous attempt goes with the form that is
        // closing, or the next one opens with a stale sentence on it.
        setProblems((current) => {
          const { [ADD_KEY]: _dropped, ...rest } = current;
          return rest;
        });
        setAdding('custom');
      }}
      onCancelAdd={() => setAdding(null)}
      onSubmitAdd={(draft) => {
        void (async () => {
          // The grid closes only on success: a refused install leaves the form
          // open with everything the operator typed still in it, because the
          // fix is usually one character in the URL.
          const ok = await run(ADD_KEY, () => actions.addCustom(draft));
          if (ok) setAdding(null);
        })();
      }}
      onSetToken={(row, token) => {
        void withServer(row, (id) => run(row.key, () => actions.setToken(id, token)));
      }}
      rows={rows}
      onManageAccess={(row) => setEditingAccess(row.server?.id ?? null)}
      botName={botName}
      query={query}
      onQuery={setQuery}
      category={category}
      onCategory={setCategory}
      busyKey={busyKey}
      awaiting={awaiting}
      problems={problems}
      onInstall={(row) => void run(row.key, () => actions.install(row))}
      onUninstall={(row) => void withServer(row, (id) => run(row.key, () => actions.uninstall(id)))}
      onConnect={(row) => void connect(row)}
      onRetry={(row) => void withServer(row, (id) => run(row.key, () => actions.retry(id)))}
      onToggle={(row) => void toggleForBot(rows, row)}
    />
  );
}

/**
 * Stateless view of the plugins pane (installed + available two-column card grid).
 * Kept separate from `PluginsPane` so static-markup tests can assert controls
 * without running data-loading effects.
 */
export function PluginsPaneView({
  rows,
  botName,
  query,
  onQuery,
  category,
  onCategory,
  busyKey = null,
  awaiting = [],
  problems = {},
  adding = null,
  onAdd,
  onCancelAdd,
  onSubmitAdd,
  onInstall,
  onUninstall,
  onConnect,
  onRetry,
  onToggle,
  onSetToken,
  onManageAccess,
}: {
  readonly rows: readonly PluginRow[];
  readonly onManageAccess?: (row: PluginRow) => void;
  readonly botName?: string | null;
  readonly query: string;
  readonly onQuery: (value: string) => void;
  readonly category: string | null;
  readonly onCategory: (value: string | null) => void;
  readonly busyKey?: string | null;
  readonly awaiting?: readonly string[];
  readonly problems?: Readonly<Record<string, string>>;
  /** The form that is open, or `null` for the grid. */
  readonly adding?: AddingView | null;
  readonly onAdd?: (() => void) | undefined;
  readonly onCancelAdd?: (() => void) | undefined;
  readonly onSubmitAdd?: ((draft: CustomServerDraft) => void) | undefined;
  readonly onInstall: (row: PluginRow) => void;
  readonly onUninstall: (row: PluginRow) => void;
  readonly onConnect: (row: PluginRow) => void;
  readonly onRetry: (row: PluginRow) => void;
  readonly onToggle: (row: PluginRow) => void;
  readonly onSetToken?: ((row: PluginRow, token: string) => void) | undefined;
}) {
  const t = useT();
  const options = categoryOptions(rows);
  const shown = filterPlugins(rows, query, category);
  const { installed, available } = splitRows(shown);
  const shownInstalled = capRows(installed);
  const shownAvailable = capRows(available);
  const hidden = shownInstalled.hidden + shownAvailable.hidden;
  const perBot = rows.some((row) => row.enabledForBot !== null);

  if (adding !== null && adding !== undefined) {
    return (
      <CustomServerFormView
        busy={busyKey === ADD_KEY}
        problem={problems[ADD_KEY] ?? ''}
        onCancel={onCancelAdd ?? (() => undefined)}
        onSubmit={onSubmitAdd ?? (() => undefined)}
      />
    );
  }

  const card = (row: PluginRow) => (
    <PluginCard
      key={row.key}
      row={row}
      busy={busyKey === row.key}
      awaiting={row.server !== null && awaiting.includes(row.server.id)}
      problem={problems[row.key] ?? ''}
      onInstall={() => onInstall(row)}
      onUninstall={() => onUninstall(row)}
      onConnect={() => onConnect(row)}
      onRetry={() => onRetry(row)}
      onManageAccess={onManageAccess === undefined ? undefined : () => onManageAccess(row)}
      onToggle={() => onToggle(row)}
      onSetToken={(token) => onSetToken?.(row, token)}
    />
  );

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-3 px-1">
        <p className="text-[12px] text-muted" data-testid="plugins-summary">
          {installedSummary(rows)}
        </p>
        {/* One button, not a menu. The references this follows carry an
            "Add ▾" dropdown because they have several things behind it —
            an app, an MCP, a skill. This build has exactly one, and a menu
            that opens to reveal a single item is a click spent on nothing. */}
        {onAdd === undefined ? null : (
          <Button size="sm" variant="secondary" onPress={onAdd} data-testid="plugins-add">
            <IconPlus className="size-3.5" stroke={1.8} />
            {t('plugins.addServer')}
          </Button>
        )}
      </div>

      <div className="mb-3">
        <SearchField
          aria-label={t('plugins.search')}
          variant="secondary"
          value={query}
          onChange={onQuery}
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={t('plugins.search')} />
          </SearchField.Group>
        </SearchField>
      </div>

      {/* One dropdown, not a wall of chips. live catalog carries the
          vendor's whole category taxonomy — dozens of them, lowercase, beside
          the curated entries' own — and a chip per category turned the filter
          into the tallest thing on the screen. A select reaches every category
          in one row; "All categories" is the sentinel that clears it. */}
      {options.length === 1 ? null : (
        <div className="mb-4">
          <CategoryFilter options={options} category={category} onCategory={onCategory} />
        </div>
      )}

      {shown.length === 0 ? (
        <SettingsSection title={t('plugins.available')}>
          <SettingsRow
            label={t('plugins.nothingMatches')}
            description={t('plugins.nothingMatches.hint')}
          />
        </SettingsSection>
      ) : (
        <>
          {/* Installed goes first even when it is empty of matches, so the
              section a person is looking for does not move depending on what
              they typed. */}
          {shownInstalled.visible.length === 0 ? null : (
            <CardSection
              title={t('plugins.installed')}
              // The bot is named in the HINT, not the heading. "Available to
              // Quill" used to head a list that included everything this build
              // curates, most of which was not installed at all and none of
              // which was Quill's — the split made that visible. A heading
              // states what the section IS; which bot the switches are about
              // is a different fact and gets its own line.
              hint={
                onManageAccess
                  ? t('plugins.installed.manageHint')
                  : perBot
                    ? t('plugins.installed.switchHint', { bot: botName ?? t('plugins.thisBot') })
                    : ''
              }
            >
              {shownInstalled.visible.map(card)}
            </CardSection>
          )}
          {shownAvailable.visible.length === 0 ? null : (
            <CardSection
              title={
                shownInstalled.visible.length === 0
                  ? t('plugins.available')
                  : t('plugins.moreToAdd')
              }
            >
              {shownAvailable.visible.map(card)}
            </CardSection>
          )}
          {hidden === 0 ? null : (
            <p className="px-1 text-[12px] text-muted" data-testid="plugins-hidden">
              {t('plugins.hidden', { count: hidden })}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** A titled two-column grid, with an optional line under the title. */
function CardSection({
  title,
  hint = '',
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-6">
      <h3 className="px-1 text-[12px] font-medium text-muted">{title}</h3>
      {hint === '' ? null : <p className="px-1 text-[12px] text-muted">{hint}</p>}
      <div className="mb-2" />
      {/* One column below ~520px so a narrowed window degrades to the list
          this replaced rather than to two unreadable columns. */}
      <div className="grid grid-cols-1 gap-2 min-[520px]:grid-cols-2">{children}</div>
    </section>
  );
}

/**
 * The square that stands in for a plugin.
 *
 * `iconUrl` is rendered when the directory has one and is null for every
 * curated entry today, on purpose (see `tileOf`). The initial is not a
 * fallback for a failed image — it is what this build actually knows.
 */
function PluginTileView({ row }: { row: PluginRow }) {
  // Three rungs, most specific first: a mark this build ships, then an icon
  // the directory verified, then the initial. Each is a real answer rather
  // than a fallback for the one above failing — `iconUrl` is null for every
  // curated entry today, and a brand simple-icons does not carry has
  // no mark to ship.
  const mark = markFor(row.slug);
  if (mark !== undefined) {
    return (
      <div
        className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-separator bg-white"
        aria-hidden
      >
        {/* Drawn rather than masked. A mask paints one flat colour, which is
            right for a monochrome glyph and ruins a full-colour logo — Canva
            came out as a white circle. The tile is white and bordered so a
            mark with its own light background still reads as a tile, and an
            `<img>` keeps a third-party SVG out of the DOM, where an inlined
            one would execute script. */}
        <img src={mark} alt="" className="size-[22px] object-contain" />
      </div>
    );
  }
  const tile = tileOf(row);
  if (row.iconUrl !== null) {
    return (
      <img
        src={row.iconUrl}
        alt=""
        className="size-8 shrink-0 rounded-[8px] object-cover"
        // Decorative: the name is right beside it, so a screen reader that
        // announced the icon too would say everything twice.
        aria-hidden
      />
    );
  }
  return (
    <div
      className="flex size-8 shrink-0 items-center justify-center rounded-[8px] text-[11px] font-semibold text-white"
      style={{ backgroundColor: tile.color }}
      aria-hidden
    >
      {tile.initial}
    </div>
  );
}

/** Shapes of a server's name and address, shown in empty fields; not words. */
const NAME_EXAMPLE = 'Acme';
const URL_EXAMPLE = 'https://mcp.example.com/mcp';

const TONE_CLASS: Record<ReturnType<typeof statusView>['tone'], string> = {
  neutral: 'text-muted',
  progress: 'text-muted',
  good: 'text-success',
  attention: 'text-warning',
};

const ACTION_LABEL = {
  connect: 'plugins.action.connect',
  reconnect: 'plugins.action.reconnect',
  retry: 'plugins.action.retry',
  'set-token': 'plugins.action.setToken',
  restart: 'plugins.action.restart',
} as const satisfies Record<NonNullable<ReturnType<typeof statusView>['action']>, MessageKey>;

function PluginCard({
  row,
  busy,
  awaiting,
  problem,
  onInstall,
  onUninstall,
  onConnect,
  onRetry,
  onToggle,
  onSetToken,
  onManageAccess,
}: {
  onManageAccess?: (() => void) | undefined;
  row: PluginRow;
  busy: boolean;
  awaiting: boolean;
  problem: string;
  onInstall: () => void;
  onUninstall: () => void;
  onConnect: () => void;
  onRetry: () => void;
  onToggle: () => void;
  onSetToken: (token: string) => void;
}) {
  const t = useT();
  const view = statusView(row.server);
  const [token, setToken] = useState('');
  const [asking, setAsking] = useState(false);

  return (
    <div className="flex flex-col gap-2 rounded-card bg-surface-secondary p-3">
      <div className="flex items-start gap-2.5">
        <PluginTileView row={row} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-foreground">{row.name}</div>
          <div className="truncate text-[12px]">
            <span className={TONE_CLASS[view.tone]}>{view.label}</span>
            {row.category === null ? null : <span className="text-muted"> · {row.category}</span>}
            {/* An available card's one "what is this" fact beyond the
                category: this one connects through the deployment's Composio
                account rather than a direct MCP endpoint. Once it is
                installed the summary's status sentence takes over the line. */}
            {row.server === null && row.backend === 'COMPOSIO' ? (
              <span className="text-muted"> · {t('plugins.viaComposio')}</span>
            ) : null}
          </div>
        </div>
        {/* The install affordance is a `+` on the card rather than a button in
            the action row: an uninstalled plugin has exactly one thing you can
            do to it, and a full-width button for it would make the catalogue
            read as eleven decisions instead of a list. */}
        {row.server === null ? (
          <Button
            size="sm"
            variant="ghost"
            isDisabled={busy}
            onPress={onInstall}
            aria-label={t('plugins.install', { name: row.name })}
            className="-me-1 -mt-1 size-7 shrink-0 rounded-full p-0"
          >
            <IconPlus className="size-4" stroke={1.8} />
          </Button>
        ) : null}
      </div>

      {view.sentence === '' ? null : (
        <div className="text-[12px] leading-[16px] text-muted">
          {awaiting ? t('plugins.waitingForBrowser') : view.sentence}
        </div>
      )}

      {/* The server's own words, UNDER the sentence rather than instead of it
. Useful to whoever is debugging, useless to whoever has to
          press something — so it is never the headline. */}
      {row.server?.lastError == null || view.action === null ? null : (
        <div className="text-[11px] leading-[15px] text-muted opacity-80">
          {row.server.lastError}
        </div>
      )}
      {problem === '' ? null : <div className="text-[12px] text-warning">{problem}</div>}

      {row.server && onManageAccess ? (
        <div className="mt-1 flex items-center justify-between gap-2 border-t border-separator pt-2">
          <div className="min-w-0 text-[12px] text-muted">{accessSummary(row.server.access)}</div>
          <Button
            size="sm"
            variant="ghost"
            isDisabled={busy}
            onPress={onManageAccess}
            aria-label={t('plugins.manageAccess', { name: row.name })}
          >
            {t('plugins.botAccess')}
          </Button>
        </div>
      ) : null}
      {asking ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`token-${row.key}`} className="text-[12px] text-muted">
            {t('plugins.newToken', { name: row.name })}
          </label>
          <input
            id={`token-${row.key}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('plugins.token.placeholder')}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            className={SETTINGS_INPUT_CLASS}
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onPress={() => {
                setAsking(false);
                setToken('');
              }}
            >
              {t('settings.cancel')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy || token.trim() === ''}
              onPress={() => {
                onSetToken(token.trim());
                setAsking(false);
                setToken('');
              }}
            >
              {t('plugins.saveToken')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          {onManageAccess || row.enabledForBot === null || row.server === null ? null : (
            // `Switch.Content` is not decoration: HeroUI's Switch is React
            // Aria's SwitchField, a div with no control of its own, and the
            // interactive element lives in the content slot. Composed without
            // it this is a PICTURE of a switch — it reflects state, honours
            // disabled, and does nothing when pressed (see ModelForm).
            <Switch
              size="sm"
              isSelected={row.enabledForBot}
              isDisabled={busy || row.server.status !== 'CONNECTED'}
              onChange={onToggle}
              aria-label={t('plugins.useOnBot', { name: row.name })}
              className="me-auto"
            >
              <Switch.Content>
                <span className="text-[12px] text-muted">{t('plugins.use')}</span>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          )}
          {row.server === null ? null : (
            <>
              {view.action === null ? null : (
                <Button
                  size="sm"
                  variant="secondary"
                  // Starting over is for exactly the moment a trip is out.
                  isDisabled={busy || (awaiting && view.action !== 'restart')}
                  onPress={
                    view.action === 'retry'
                      ? onRetry
                      : view.action === 'set-token'
                        ? () => setAsking(true)
                        : onConnect
                  }
                >
                  {t(ACTION_LABEL[view.action])}
                </Button>
              )}
              {/* Muted on purpose. `ghost` renders at full foreground weight,
                  which put Remove level with the button that FIXES the card —
                  and on a row that needs attention, the destructive action was
                  reading as the suggested one. */}
              <Button
                size="sm"
                variant="ghost"
                isDisabled={busy}
                onPress={onUninstall}
                className="font-normal text-muted"
              >
                {t('plugins.remove')}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Connect a server this build does not curate (CC-57, D-114).
 *
 * ── STDIO IS NOT OFFERED, AND THAT IS THE CONTRACT RATHER THAN A CHOICE ────
 *
 * `McpTransportSchema` is `['HTTP', 'SSE']`: v1 is remote-only (PRD §2.5), so
 * there is no STDIO to offer and no toggle to grey out. The references this
 * screen follows show STDIO beside Streamable HTTP because their builds run a
 * local process; this one would be offering a transport nothing implements.
 *
 * ── THE TOKEN IS OPTIONAL AND THE FORM SAYS WHY ───────────────────────────
 *
 * A blank token installs the server with `authType: NONE` and a filled one
 * makes it `HEADER` (D-114). That is a real fork with a consequence an
 * operator cannot see later — a NONE server has no token to rotate — so the
 * field says what leaving it empty means rather than letting the absence
 * decide silently.
 */
export function CustomServerFormView({
  busy,
  problem,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  problem: string;
  onCancel: () => void;
  onSubmit: (draft: CustomServerDraft) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<CustomServerDraft>(EMPTY_CUSTOM_SERVER);
  const [touched, setTouched] = useState(false);
  const problems = validateCustomServer(draft);
  const invalid = Object.keys(problems).length > 0;

  return (
    <div>
      <Button
        size="sm"
        variant="ghost"
        onPress={onCancel}
        className="mb-3 -ms-1 h-7 px-2 text-[12px] text-muted"
      >
        {t('plugins.back')}
      </Button>

      <SettingsSection title={t('plugins.custom.title')}>
        <SettingsRow
          label={t('plugins.custom.name')}
          htmlFor="custom-mcp-name"
          stacked
          description={t('plugins.custom.name.hint')}
          control={
            <input
              id="custom-mcp-name"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={NAME_EXAMPLE}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              className={SETTINGS_INPUT_CLASS}
            />
          }
        />
        <SettingsRow
          label={t('plugins.custom.url')}
          htmlFor="custom-mcp-url"
          stacked
          description={t('plugins.custom.url.hint')}
          control={
            <input
              id="custom-mcp-url"
              type="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={URL_EXAMPLE}
              value={draft.url}
              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              className={SETTINGS_INPUT_CLASS}
            />
          }
        />
        <SettingsRow
          label={t('plugins.custom.transport')}
          description={t('plugins.custom.transport.hint')}
          control={
            <div className="flex gap-1.5">
              {(['HTTP', 'SSE'] as const).map((transport) => (
                <CategoryChip
                  key={transport}
                  label={transport === 'HTTP' ? t('plugins.custom.transport.http') : 'SSE'}
                  selected={draft.transport === transport}
                  onPress={() => setDraft({ ...draft, transport })}
                />
              ))}
            </div>
          }
        />
        <SettingsRow
          label={t('plugins.custom.token')}
          htmlFor="custom-mcp-token"
          stacked
          description={t('plugins.custom.token.hint')}
          control={
            <input
              id="custom-mcp-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('plugins.custom.token.placeholder')}
              value={draft.bearerToken}
              onChange={(event) => setDraft({ ...draft, bearerToken: event.target.value })}
              className={SETTINGS_INPUT_CLASS}
            />
          }
        />
      </SettingsSection>

      {touched && problems.name !== undefined ? (
        <p className="mb-2 px-1 text-[12px] text-warning">{problems.name}</p>
      ) : null}
      {touched && problems.url !== undefined ? (
        <p className="mb-2 px-1 text-[12px] text-warning">{problems.url}</p>
      ) : null}
      {problem === '' ? null : <p className="mb-2 px-1 text-[12px] text-warning">{problem}</p>}

      <div className="flex justify-end gap-2 px-1">
        <Button size="sm" variant="ghost" isDisabled={busy} onPress={onCancel}>
          {t('settings.cancel')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          isDisabled={busy}
          onPress={() => {
            setTouched(true);
            if (!invalid) onSubmit(draft);
          }}
          data-testid="custom-mcp-submit"
        >
          {t('plugins.custom.add')}
        </Button>
      </div>
    </div>
  );
}

function CategoryChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onPress={onPress}
      aria-pressed={selected}
      className={`h-7 rounded-full px-3 text-[12px] font-normal ${
        selected
          ? 'bg-background-tertiary text-foreground'
          : 'text-muted data-[hovered]:bg-background-secondary'
      }`}
    >
      {label}
    </Button>
  );
}

/**
 * The category filter, as one dropdown.
 *
 * HeroUI's `Select` is React Aria's — the popover, the keyboard handling and
 * the hidden native select for forms are its, so the composition here is
 * trigger chrome and item styling only. "All categories" is a real option
 * rather than a missing selection, because a filter whose cleared state is
 * indistinguishable from "nothing chosen yet" reads as broken when the list
 * under it is long.
 */
function CategoryFilter({
  options,
  category,
  onCategory,
}: {
  options: readonly CategoryOption[];
  category: string | null;
  onCategory: (value: string | null) => void;
}) {
  const t = useT();
  return (
    <Select
      selectedKey={category ?? ALL_CATEGORY_KEY}
      onSelectionChange={(key) =>
        onCategory(key === null || key === ALL_CATEGORY_KEY ? null : String(key))
      }
      aria-label={t('plugins.filterByCategory')}
    >
      <Select.Trigger
        data-testid="plugins-category"
        className="h-9 w-full max-w-72 items-center justify-between rounded-card border border-separator bg-surface-secondary px-3 text-[13px] text-foreground"
      >
        {/* The label from props, not from SelectValue: the selected category is
            this component's own state, and reading it here keeps the trigger's
            sentence identical in the app and in a static render — the popover
            that carries the collection has not mounted yet in either. */}
        <span className="truncate">{category ?? t('plugins.allCategories')}</span>
        <Select.Indicator className="text-muted" />
      </Select.Trigger>
      <Select.Popover className="max-h-72 min-w-56 overflow-auto">
        <ListBox items={options}>
          {(option: CategoryOption) => (
            <ListBoxItem
              key={option.id}
              id={option.id}
              textValue={option.label}
              className="cursor-default rounded-[6px] px-2.5 py-1.5 text-[13px] text-foreground data-[focused]:bg-background-secondary"
            >
              {option.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/**
 * Run something that needs an installed server's id, or nothing.
 *
 * A helper rather than a non-null assertion at three call sites: the row's
 * `server` is legitimately null (an uninstalled catalog entry), and the
 * buttons that need one are only rendered when it is not — which is a fact
 * about the JSX that TypeScript cannot see from here.
 */
function withServer<T>(
  row: PluginRow,
  work: (serverId: string) => Promise<T>,
): Promise<T | undefined> {
  return row.server === null ? Promise.resolve(undefined) : work(row.server.id);
}
