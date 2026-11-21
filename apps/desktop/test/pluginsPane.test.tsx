import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { BotPlugin, McpDirectoryEntry, McpServerSummary } from '@crewaid/shared';

import {
  CustomServerFormView,
  PluginsPane,
  PluginsPaneView,
} from '../src/renderer/settings/PluginsPane';
import { mergePlugins } from '../src/renderer/settings/pluginsState';
import { SETTINGS_PANES } from '../src/renderer/settings/settingsPanes';

/**
 * M6-FE-01 … FE-03 — the Plugins pane as it renders.
 *
 * `pluginsState.test.ts` holds the decisions; this holds the CONTROLS, because
 * what M6-FE-03 asks for is a property of what is on screen: a server whose
 * sign-in expired must offer a button, not a red box with the server's own
 * words in it.
 *
 * ⚠️ `renderToStaticMarkup` runs no effects, so a component that fetches in
 * `useEffect` renders its spinner and stops — a test of this pane's container
 * could only ever assert the spinner. That is why the screen is a separate
 * component (`PluginsPaneView`): the container owns the round trips, this owns
 * what is on screen, and the cases below render the second one over rows the
 * real merge produced.
 */

const ENTRY: McpDirectoryEntry = {
  name: 'GitHub',
  slug: 'github',
  category: 'Developer Tools',
  iconUrl: null,
  authType: 'OAUTH2',
};

const LINEAR: McpDirectoryEntry = {
  name: 'Linear',
  slug: 'linear',
  category: 'Project Tracking',
  iconUrl: null,
  authType: 'OAUTH2',
};

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

/**
 * Render the screen over rows the REAL merge produced.
 *
 * Through `mergePlugins` rather than hand-written rows, so a case cannot
 * describe a row shape the pane will never actually be given — the join, the
 * private-server append and the per-bot flag are all decided there.
 */
function render(options: {
  directory?: readonly McpDirectoryEntry[];
  servers?: readonly McpServerSummary[];
  botPlugins?: readonly BotPlugin[] | null;
  botName?: string | null;
  query?: string;
  category?: string | null;
  awaiting?: readonly string[];
  adding?: 'custom' | null;
  onAdd?: () => void;
}): string {
  const rows = mergePlugins(
    options.directory ?? [ENTRY],
    options.servers ?? [],
    options.botPlugins ?? null,
  );
  return renderToStaticMarkup(
    <I18nProvider locale="en-US">
      <PluginsPaneView
        rows={rows}
        botName={options.botName ?? null}
        query={options.query ?? ''}
        onQuery={() => undefined}
        category={options.category ?? null}
        onCategory={() => undefined}
        awaiting={options.awaiting ?? []}
        adding={options.adding ?? null}
        onAdd={options.onAdd ?? (() => undefined)}
        onCancelAdd={() => undefined}
        onSubmitAdd={() => undefined}
        onSetToken={() => undefined}
        onInstall={() => undefined}
        onUninstall={() => undefined}
        onConnect={() => undefined}
        onRetry={() => undefined}
        onToggle={() => undefined}
      />
    </I18nProvider>,
  );
}

describe('M6-FE-01 the pane is reachable', () => {
  it('has moved out of Settings', () => {
    expect(SETTINGS_PANES.map((entry) => entry.label)).not.toContain('Plugins');
  });

  it('renders the live plugin pane while its catalog loads', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="en-US">
        <PluginsPane botId={null} botName={null} />
      </I18nProvider>,
    );
    // The fetch has not resolved, so this is the spinner — which is itself the
    // assertion that the pane, and not `PlannedPane`, is what mounted.
    expect(markup).toContain('Loading plugins');
    expect(markup).not.toContain('coming soon');
  });
});

describe('M6-FE-01 search, filters and the installed count', () => {
  it('offers a search box and one category dropdown, not a chip wall (D-204)', () => {
    const markup = render({ directory: [ENTRY, LINEAR] });

    expect(markup).toContain('Search plugins');
    // The live catalog carries the vendor's whole category taxonomy, so the
    // filter is one select that reaches every category; a chip per category
    // was the tallest thing on the screen. The cleared state is a real option
    // a person can pick again, not an invisible default.
    expect(markup).toContain('data-testid="plugins-category"');
    expect(markup).toContain('All categories');

    // The trigger names whichever filter is applied.
    const filtered = render({ directory: [ENTRY, LINEAR], category: 'Developer Tools' });
    expect(filtered).toContain('Developer Tools');
  });

  it('caps the grid and says how many it hid', () => {
    const catalogue: McpDirectoryEntry[] = Array.from({ length: 70 }, (_unused, index) => ({
      name: `App ${String(index)}`,
      slug: `app-${String(index)}`,
      category: 'Developer Tools',
      iconUrl: null,
      authType: 'OAUTH2',
    }));
    const markup = render({ directory: catalogue });
    expect(markup).toContain('data-testid="plugins-hidden"');
    expect(markup).toContain('10 more plugins');
  });

  it('marks an available toolkit as reached through Composio', () => {
    const toolkit: McpDirectoryEntry = {
      name: 'Googlesheets',
      slug: 'googlesheets',
      category: 'spreadsheets',
      iconUrl: 'https://logos.composio.dev/api/googlesheets',
      authType: 'OAUTH2',
      backend: 'COMPOSIO',
    };
    const markup = render({ directory: [toolkit] });
    expect(markup).toContain('via Composio');
    // A curated entry (no backend) carries no such mark.
    expect(render({ directory: [ENTRY] })).not.toContain('via Composio');
  });

  it('summarises what is installed, connected, and how many tools', () => {
    const markup = render({
      directory: [ENTRY, LINEAR],
      servers: [SERVER()],
    });

    expect(markup).toContain('1 plugin installed');
    expect(markup).toContain('1 connected');
    expect(markup).toContain('12 tools');
  });

  it('offers Install for a catalog entry and Remove for an installed one', () => {
    const uninstalled = render({ directory: [LINEAR] });
    expect(uninstalled).toContain('Install');
    expect(uninstalled).not.toContain('Remove');

    const installed = render({ directory: [ENTRY], servers: [SERVER()] });
    expect(installed).toContain('Remove');
  });
});

describe('M6-FE-03 a state an operator can act on', () => {
  it('offers Reconnect and a sentence, not the server’s own words as the headline', () => {
    const markup = render({
      directory: [ENTRY],
      servers: [SERVER({ status: 'NEEDS_REAUTH', lastError: 'invalid_grant: token revoked' })],
    });

    expect(markup).toContain('Reconnect');
    expect(markup).toContain('Sign in again');
    expect(markup).toContain('its tools are paused');
    // The raw error is still THERE — it is useful to whoever is debugging —
    // but it is not what the operator reads first. Asserted by both being
    // present, so "the sentence is there" cannot pass by the detail having
    // been dropped.
    expect(markup).toContain('invalid_grant');
    expect(markup.indexOf('its tools are paused')).toBeLessThan(markup.indexOf('invalid_grant'));
  });

  it('offers Try again for a server that stopped answering', () => {
    const markup = render({
      directory: [ENTRY],
      servers: [SERVER({ status: 'ERROR', lastError: 'ECONNREFUSED' })],
    });

    expect(markup).toContain('Try again');
    expect(markup).toContain('It stopped answering');
  });

  it('offers only a way to start over while a browser trip is out', () => {
    const markup = render({
      directory: [ENTRY],
      servers: [SERVER({ status: 'CONNECTING' })],
    });

    expect(markup).toContain('Finish signing in in your browser');
    expect(markup).toContain('Start over');
    expect(markup).not.toContain('>Connect<');
    expect(markup).not.toContain('Reconnect');
  });
});

describe('M6-FE-01 per-bot enablement', () => {
  it('offers a switch only when a bot is selected and the server is installed', () => {
    const server = SERVER();
    const withBot = render({
      directory: [ENTRY],
      servers: [server],
      botPlugins: [
        { serverId: server.id, slug: 'github', name: 'GitHub', enabled: true, toolCount: 12 },
      ],
      botName: 'Quill',
    });
    expect(withBot).toContain('Use GitHub on this bot');
    expect(withBot).toContain('give it to Quill');

    // No bot: no switch, rather than an unchecked one that would be a lie
    // about a bot that does not exist.
    const withoutBot = render({ directory: [ENTRY], servers: [server] });
    expect(withoutBot).not.toContain('on this bot');
  });

  it('cannot enable a server that is not connected', () => {
    // A switch that turns on a plugin whose tools cannot load is a switch that
    // does nothing, and the operator's next action is Connect — which is the
    // button right beside it.
    const server = SERVER({ status: 'NEEDS_REAUTH' });
    const markup = render({
      directory: [ENTRY],
      servers: [server],
      botPlugins: [
        { serverId: server.id, slug: 'github', name: 'GitHub', enabled: false, toolCount: 12 },
      ],
    });

    const at = markup.indexOf('Use GitHub on this bot');
    expect(at).toBeGreaterThan(-1);
    expect(markup.slice(Math.max(0, at - 400), at + 400)).toContain('disabled');
  });
});

describe('CC-57 the grid', () => {
  it('separates what is installed from what is not', () => {
    const markup = render({
      directory: [ENTRY, LINEAR],
      servers: [SERVER({ status: 'CONNECTED', toolCount: 3 })],
    });

    expect(markup).toContain('Installed');
    expect(markup).toContain('More to add');
    // Asserted against a presence: both sections have a row, so the split is
    // doing something rather than one heading sitting over everything.
    expect(markup).toContain('GitHub');
    expect(markup).toContain('Linear');
  });

  it('heads the catalogue "Available" when nothing is installed yet', () => {
    const markup = render({ directory: [ENTRY, LINEAR] });

    expect(markup).toContain('Available');
    expect(markup).not.toContain('More to add');
  });

  it('draws the initial for a slug the folder has no file for', () => {
    const markup = render({
      directory: [{ ...ENTRY, name: 'Nothing Here', slug: 'nothing-here', category: 'Analytics' }],
    });

    expect(markup).toContain('>NO<');
    expect(markup).not.toContain('<img');
  });

  it('draws the brand mark as an image, not a mask (CC-61)', () => {
    const markup = render({ directory: [ENTRY] });

    // Masking paints one flat colour, which ruins a full-colour logo — Canva
    // came out as a white circle. Real marks are drawn.
    expect(markup).toContain('<img');
    expect(markup).not.toContain('mask-image');
    expect(markup).not.toContain('>GI<');
  });

  it('renders the directory’s icon when it has one and the folder has no file', () => {
    // The middle rung: a verified remote icon beats the initial, and loses to
    // a mark shipped in the bundle.
    const markup = render({
      directory: [
        {
          ...ENTRY,
          name: 'Nothing Here',
          slug: 'nothing-here',
          iconUrl: 'https://cdn.example.test/nothing.png',
        },
      ],
    });

    expect(markup).toContain('https://cdn.example.test/nothing.png');
    expect(markup).not.toContain('>NO<');
  });

  it('offers a way to add a server the directory does not have', () => {
    expect(render({})).toContain('Add a server');
  });

  it('names the bot in a line under Installed, not in the heading', () => {
    const markup = render({
      servers: [SERVER({ status: 'CONNECTED' })],
      botPlugins: [
        { serverId: SERVER().id, slug: 'github', name: 'GitHub', enabled: false, toolCount: 0 },
      ],
      botName: 'Quill',
    });

    expect(markup).toContain('give it to Quill');
    // The old heading said "Available to Quill" over a list that included
    // everything this build curates, none of which was Quill's.
    expect(markup).not.toContain('Available to Quill');
  });
});

describe('CC-57 a header server asks for a token, not a browser', () => {
  it('offers "Add token" rather than "Reconnect" when a bearer was refused', () => {
    const markup = render({
      directory: [],
      servers: [
        SERVER({
          slug: 'acme',
          name: 'Acme',
          isPrivate: true,
          authType: 'HEADER',
          status: 'NEEDS_REAUTH',
          lastError: 'the server rejected its bearer token',
        }),
      ],
    });

    expect(markup).toContain('Add token');
    // Reconnect is the one thing that cannot fix it: there is no sign-in to
    // repeat, so sending the operator to a browser would be sending them
    // nowhere (D-114).
    expect(markup).not.toContain('Reconnect');
    expect(markup).toContain('Token rejected');
  });

  it('still sends an OAuth server back to its browser', () => {
    const markup = render({
      servers: [SERVER({ authType: 'OAUTH2', status: 'NEEDS_REAUTH' })],
    });

    expect(markup).toContain('Reconnect');
    expect(markup).not.toContain('Add token');
  });
});

describe('CC-57 the custom server form', () => {
  const form = (): string =>
    renderToStaticMarkup(
      <I18nProvider locale="en-US">
        <CustomServerFormView
          busy={false}
          problem=""
          onCancel={() => undefined}
          onSubmit={() => undefined}
        />
      </I18nProvider>,
    );

  it('asks for the four things an install takes and nothing else', () => {
    const markup = form();

    expect(markup).toContain('custom-mcp-name');
    expect(markup).toContain('custom-mcp-url');
    expect(markup).toContain('custom-mcp-token');
    expect(markup).toContain('Streamable HTTP');
    expect(markup).toContain('SSE');
  });

  it('does not offer STDIO, because the contract has no such transport', () => {
    // Not a product choice this screen makes: McpTransportSchema is
    // ['HTTP','SSE'] and v1 is remote-only (PRD §2.5), so a STDIO control
    // would be offering a transport nothing implements.
    expect(form()).not.toContain('STDIO');
  });

  it('says what leaving the token empty means', () => {
    // The fork is invisible afterwards — a server installed with no token has
    // none to rotate — so the field says it rather than letting the absence
    // decide silently.
    expect(form()).toContain('cannot be given one later');
  });

  it('keeps the token out of the markup as a readable value', () => {
    expect(form()).toContain('type="password"');
  });
});
