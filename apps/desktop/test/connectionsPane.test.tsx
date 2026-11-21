import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { ProviderConnectionWithModels, ProviderModel } from '@crewaid/shared';
import type { ApiClient } from '../src/renderer/api';
import { liveActions } from '../src/renderer/settings/ConnectionsPane';
import {
  ConnectionCard,
  connectionMenuDisabledKeys,
  connectionMenuHandler,
  CONNECTION_MENU_ITEMS,
} from '../src/renderer/settings/ConnectionCard';
import {
  keyIsWriteOnly,
  modelDraftFrom,
  toUpdateModelBody,
} from '../src/renderer/settings/connectionsState';
import { SETTINGS_PANES } from '../src/renderer/settings/settingsPanes';

/**
 * V1-12 — the Connections pane as it actually renders.
 *
 * `connectionsState.test.ts` holds the sentences and the validation; this
 * holds the CONTROLS, because the headline property of this pane is about
 * something that must not be on screen.
 *
 * ── THE PROPERTY WORTH A TEST ───────────────────────────────────────────────
 *
 * A connection with a stored key renders NO INPUT FOR THAT KEY. Not a masked
 * one, not a disabled one, not a placeholder full of dots. The server never
 * sends a key back (D-083), so any field pre-filled to look like one would be
 * this app inventing a value — and it teaches the operator that the key is
 * sitting there and could be revealed, which is exactly what makes rotating
 * feel like a chance to lose it.
 */

const MODEL: ProviderModel = {
  id: 'clx4m5n6o7p8q9r0s1t2u3v4',
  connectionId: 'clx1a2b3c4d5e6f7g8h9i0j1',
  upstreamModelId: 'claude-opus-4-5',
  label: 'Claude Opus 4.5',
  contextWindow: 200_000,
  capabilities: { tools: true, vision: true, reasoning: true },
  createdAt: '2026-09-01T12:00:00.000Z',
};

const CONNECTION: ProviderConnectionWithModels = {
  id: 'clx1a2b3c4d5e6f7g8h9i0j1',
  userId: 'clx9z8y7x6w5v4u3t2s1r0q9',
  kind: 'anthropic',
  name: 'Work Anthropic',
  endpoint: null,
  authKind: 'api_key',
  state: 'ACTIVE',
  hasCredential: true,
  credentialSetAt: '2026-09-03T10:00:00.000Z',
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-03T10:00:00.000Z',
  models: [MODEL],
};

/**
 * Is the button with this label disabled?
 *
 * Scoped to one button rather than searching the whole card for the word,
 * because something in this card is ALWAYS disabled: Rename starts that way
 * and stays until the name is edited. A card-wide `toContain('disabled')`
 * therefore passes for every state and asserts nothing — which is how a
 * `disabled` assertion usually goes wrong.
 */
/**
 * Whether the card's enable switch is unavailable.
 *
 * Read off the FIELD (`data-slot="switch"`) rather than the control, because
 * the field is what carries `data-disabled` in every state, selected or not.
 * The control itself — the checkbox `switchControls` finds — is where the press
 * lands, and it is asserted separately: for a while this switch was composed
 * without `Switch.Content`, which renders a field with no control in it at all,
 * and a `data-disabled` assertion is perfectly happy about that.
 */
function switchIsDisabled(html: string): boolean {
  const control = /<div[^>]*data-slot="switch"[^>]*>/.exec(html)?.[0] ?? '';
  return control.includes('data-disabled="true"');
}

/** The checkbox behind every switch on the card — the part you can press. */
function switchControls(html: string): readonly string[] {
  return [...html.matchAll(/<input[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => tag.includes('role="switch"'));
}

function buttonIsDisabled(html: string, label: string): boolean {
  const end = html.indexOf(`>${label}</button>`);
  if (end === -1) throw new Error(`no button labelled "${label}" in the markup`);
  const start = html.lastIndexOf('<button', end);
  return html.slice(start, end).includes('disabled');
}

function render(patch: Partial<ProviderConnectionWithModels> = {}, busy = false, expanded = true) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ConnectionCard
        connection={{ ...CONNECTION, ...patch }}
        busy={busy}
        defaultExpanded={expanded}
        problem={null}
        onRename={() => undefined}
        onSetEndpoint={() => undefined}
        onToggleEnabled={() => undefined}
        onSetKey={() => undefined}
        onClearKey={() => undefined}
        onRemove={() => undefined}
        onAddModel={() => undefined}
        onUpdateModel={() => undefined}
        onRemoveModel={() => undefined}
      />
    </I18nProvider>,
  );
}

describe('V1-12 — the key is write-only on screen too', () => {
  it('renders no key input at all for a connection that has one', () => {
    const html = render({ hasCredential: true });

    // Not "an empty password field" — none. The field is opened by a button
    // press and exists only while it is being typed into.
    expect(html).not.toContain('type="password"');
    expect(html).not.toMatch(/•{3,}/);
  });

  it('offers Replace rather than Show for a stored key', () => {
    const html = render({ hasCredential: true });

    expect(html).toContain('Replace key');
    // Removing a key lives in the overflow menu now — React Aria builds those
    // items on open, so it is asserted as data below rather than as markup.
    expect(CONNECTION_MENU_ITEMS.map((item) => item.label)).toContain('Remove key');
    // The General pane has an eye toggle for the session token. This one must
    // not: there is nothing behind it to reveal.
    expect(html).not.toContain('Show key');
    expect(html).not.toContain('Reveal');
  });

  it('says a key is stored and when, without saying anything about its value', () => {
    const html = render({ hasCredential: true });
    expect(html).toContain('A key is stored');
    // The guarantee is on screen as a chip whose title carries the sentence.
    expect(html).toContain('Write-only');
    expect(keyIsWriteOnly()).toContain('never sends it back');
  });

  it('offers Set, and nothing to remove, when there is no key', () => {
    const html = render({ hasCredential: false, state: 'NEEDS_CREDENTIAL' });

    expect(html).toContain('Set key');
    expect(html).not.toContain('Replace key');
    // Removing a key that does not exist is an action that can only fail.
    expect(connectionMenuDisabledKeys(false)).toContain('clear-key');
    expect(connectionMenuDisabledKeys(true)).not.toContain('clear-key');
  });
});

describe('V1-12 — what each connection shows', () => {
  it('shows the base URL only for a custom connection', () => {
    expect(render({ kind: 'anthropic' })).not.toContain('Base URL');
    expect(render({ kind: 'custom', endpoint: 'https://api.example.com/v1' })).toContain(
      'Base URL',
    );
  });

  it('names the provider’s own model id, not the row id', () => {
    // `Bot.modelId` stores the row id (D-082) and a cuid tells an operator
    // nothing. What they check against a provider dashboard is this.
    const html = render();
    expect(html).toContain('claude-opus-4-5');
    expect(html).not.toContain(MODEL.id);
  });

  it('will not let a keyless connection be disabled', () => {
    // NEEDS_CREDENTIAL is owned by the credential routes, and `PATCH` refuses
    // to set it. A live Disable button here would be offering a request the
    // server answers 400 — and the state it would move to is the one it is
    // already in.
    // It is a switch now rather than a Disable button, so the refusal is the
    // control being unavailable instead of a click the server answers 400.
    const keyless = render({ hasCredential: false, state: 'NEEDS_CREDENTIAL' });
    expect(switchIsDisabled(keyless)).toBe(true);

    // Against the presence, so this cannot pass on a card where every control
    // happens to be disabled.
    expect(switchIsDisabled(render({ state: 'ACTIVE' }))).toBe(false);
  });

  it('renders the enable switch as a control, not a picture of one', () => {
    // HeroUI's `Switch` is React Aria's `SwitchField` — a div with no control
    // in it. Composed without `Switch.Content` the card still rendered a track
    // and a thumb reflecting the connection's state, and no press could change
    // anything: the checkbox carrying `role="switch"` and `onChange` is
    // rendered by `Switch.Content` and nowhere else. The capability toggles in
    // the model form were built the same way, which is why Vision could not be
    // switched on.
    const controls = switchControls(render());

    expect(controls).toHaveLength(1);
    expect(controls[0]).toContain('Work Anthropic enabled');
    expect(controls[0]).toContain('type="checkbox"');
    // Off is a state the operator can be in, not a broken control.
    expect(controls[0]).not.toContain('disabled');
    expect(switchControls(render({ state: 'DISABLED' }))[0]).not.toContain('disabled');
  });

  it('carries the state the header shows', () => {
    // `checked` is the browser's, not this app's: a control that reflects a
    // state it cannot change is exactly the shape this test is here to catch,
    // so the reflection is asserted on the control itself.
    expect(switchControls(render({ state: 'ACTIVE' }))[0]).toContain('checked');
    expect(switchControls(render({ state: 'DISABLED' }))[0]).not.toContain('checked');
    expect(
      switchControls(render({ hasCredential: false, state: 'NEEDS_CREDENTIAL' }))[0],
    ).toContain('disabled');
  });

  it('starts collapsed, and exposes a control that opens the card', () => {
    // The disclosure is a button rather than the whole header: the header holds
    // a switch, an overflow menu and, while renaming, a text field, and a click
    // target containing three other controls swallows their presses.
    const collapsed = render({}, false, false);
    const expanded = render();

    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain('Work Anthropic details');
    expect(collapsed).not.toContain('A key is stored');
    expect(collapsed).not.toContain('Claude Opus 4.5');

    expect(expanded).toContain('aria-expanded="true"');
    // The body it governs — which is the part an operator came for.
    expect(expanded).toContain('A key is stored');
    expect(expanded).toContain('Claude Opus 4.5');
  });

  it('says so when a connection has no models', () => {
    // A connection with a key and no models is complete as far as the server
    // is concerned and useless to a bot, so the pane has to say it.
    const html = render({ models: [] });
    expect(html).toContain('No models yet');
  });

  it('disables every action while one is in flight', () => {
    // A second Remove while the first is still going would send a request
    // against a row the server may have deleted, and the 404 that comes back
    // reads as "someone removed it from another window".
    for (const label of ['Replace key', 'Add model']) {
      expect(buttonIsDisabled(render({}, true), label)).toBe(true);
      expect(buttonIsDisabled(render({}, false), label)).toBe(false);
    }
  });
});

describe('V1-12 — the pane is in the nav', () => {
  it('registers Connections as a ready pane', () => {
    const pane = SETTINGS_PANES.find((entry) => entry.id === 'connections');
    expect(pane?.status).toBe('ready');
  });

  it('has ONE pane over providers and their models, not two', () => {
    // There were two: Connections listed each provider account and the models
    // under it, and Model listed the same models grouped by the same
    // connections, read-only. Two panes over one subject is how an operator
    // ends up looking for the key field on the screen that does not have it.
    const ids = SETTINGS_PANES.map((entry) => entry.id as string);
    expect(ids).not.toContain('model');

    // And the surviving pane owns the whole subject, so nothing was merged
    // away by deleting the half that mentioned models.
    const providers = SETTINGS_PANES.find((entry) => entry.id === 'connections');
    expect(providers?.summary).toContain('models');
    expect(providers?.summary).toContain('keys');
  });
});

describe('V1-19 — the connection overflow menu', () => {
  it('routes every entry somewhere, so none is a silent click', () => {
    // React Aria builds a Dropdown's items when it opens, so none of this is
    // in the markup and no render test can see it. An entry that is listed and
    // missing from the handler looks live and does nothing.
    for (const item of CONNECTION_MENU_ITEMS) {
      const calls: string[] = [];
      connectionMenuHandler({
        rename: () => calls.push('rename'),
        key: () => calls.push('key'),
        clearKey: () => calls.push('clearKey'),
        remove: () => calls.push('remove'),
      })(item.id);
      expect(calls, `"${item.label}" is listed but routes nowhere`).toHaveLength(1);
    }
  });
});

describe('V1-20 — a model can be corrected in place', () => {
  it('offers an edit affordance for every model', () => {
    // Before this there was only delete-and-re-add, and re-adding mints a NEW
    // row id — which is what `Bot.modelId` stores (D-082), so every bot
    // pointing at the old one silently stopped resolving. Correcting a typo
    // cost a fleet-wide repoint.
    const html = render();
    expect(html).toContain(`Edit ${MODEL.label}`);
    expect(html).toContain(`Remove ${MODEL.label}`);
  });

  it('round-trips a model through the form without losing a field', () => {
    // The edit form is populated from the row and sends the whole draft back,
    // so anything this drops is a field silently reset to its default the
    // first time somebody fixes a label.
    const body = toUpdateModelBody(modelDraftFrom(MODEL));

    expect(body.upstreamModelId).toBe(MODEL.upstreamModelId);
    expect(body.label).toBe(MODEL.label);
    expect(body.contextWindow).toBe(MODEL.contextWindow);
    expect(body.capabilities).toEqual(MODEL.capabilities);
  });

  it('carries capabilities that the add form never let anyone set', () => {
    // `ModelDraft` has held these since V1-12 and no form rendered them, so
    // every model created through this app took tools:true, vision:false,
    // reasoning:false — which is why a vision model added here could not be
    // given an image. The picker reads `capabilities`, and it said no.
    const vision = { ...MODEL, capabilities: { tools: false, vision: true, reasoning: true } };
    expect(toUpdateModelBody(modelDraftFrom(vision)).capabilities).toEqual({
      tools: false,
      vision: true,
      reasoning: true,
    });
  });
});

describe('V1-20 — the live wiring, not a fake of it', () => {
  /** Records what would go over the wire. `request` is all ApiClient exposes here. */
  function recordingClient(): { calls: Array<{ route: string; body: unknown }> } & ApiClient {
    const calls: Array<{ route: string; body: unknown }> = [];
    const client = {
      request: (route: string, options: { body?: unknown }) => {
        calls.push({ route, body: options.body });
        return Promise.resolve(MODEL);
      },
      // Not reached by these actions; present so the shape is an ApiClient.
      download: () => Promise.reject(new Error('not used')),
    };
    return Object.assign(client, { calls }) as unknown as { calls: typeof calls } & ApiClient;
  }

  it('sends the WHOLE model on an edit, not just the field that changed', () => {
    // The pane's `act` seam replaces this mapping, so a test that injects one
    // cannot see a draft sent as the wrong body. Shipping only the changed
    // field would reset every other one to its default the first time somebody
    // fixed a label — silently, because PATCH accepts a partial.
    const client = recordingClient();
    void liveActions(client).updateModel(MODEL.id, modelDraftFrom(MODEL));

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.body).toEqual({
      upstreamModelId: MODEL.upstreamModelId,
      label: MODEL.label,
      contextWindow: MODEL.contextWindow,
      capabilities: MODEL.capabilities,
    });
  });
});
