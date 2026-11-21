import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { Edition } from '@crewaid/shared';
import { GeneralPane } from '../src/renderer/settings/GeneralPane';
import { PlannedPane } from '../src/renderer/settings/PlannedPane';
import { SettingsPaneBody } from '../src/renderer/settings/SettingsModal';
import { SETTINGS_PANES, settingsPane } from '../src/renderer/settings/settingsPanes';

/**
 * Rendered through `SettingsPaneBody` rather than through `SettingsModal`:
 * React Aria mounts a dialog into a portal, which `renderToStaticMarkup` has
 * nowhere to put, so going through the overlay would assert on an empty
 * string and pass no matter what the panes contained.
 */
function render(id: Parameters<typeof SettingsPaneBody>[0]['id']) {
  return renderToStaticMarkup(
    <I18nProvider>
      <SettingsPaneBody id={id} />
    </I18nProvider>,
  );
}

/**
 * General, as a given edition renders it (D-152). Static rendering runs no
 * effects, so the pane would never learn its edition from the main process
 * and would show neither edition's extras; the cases that are about one
 * edition say which.
 */
function renderGeneral(edition: Edition | null) {
  return renderToStaticMarkup(
    <I18nProvider>
      <GeneralPane edition={edition} />
    </I18nProvider>,
  );
}

describe('settings panes', () => {
  it('renders every pane in the nav — a nav entry with no body is a dead click', () => {
    for (const pane of SETTINGS_PANES) {
      expect(render(pane.id).length).toBeGreaterThan(0);
    }
  });

  it('gives General the address, which is the only credential an operator types', () => {
    const html = renderGeneral('selfhosted');
    expect(html).toContain('id="settings-base-url"');
  });

  it('gives a hosted build no address to change, and still its account (D-152)', () => {
    // The main process refuses any other address in a cloud build, so a field
    // here could only ever fail to save. Asserted beside a presence — the
    // account section — so the absence cannot pass by rendering nothing.
    const html = renderGeneral('cloud');
    expect(html).not.toContain('id="settings-base-url"');
    expect(html).not.toContain('Orchestrator');
    expect(html).toContain('Account');
  });

  it('shows no address field before it knows which edition it is', () => {
    // A guess either way is wrong for someone: a flash of an address field in
    // the hosted app, or a self-hosted install briefly with no way to be set up.
    const html = renderGeneral(null);
    expect(html).not.toContain('id="settings-base-url"');
    expect(html).toContain('Account');
  });

  it('offers no field for pasting a session token', () => {
    // Removed in V1-18, and this is the fence against it coming back as a
    // convenience. V1-08 made a Better Auth session the ONLY valid bearer, so
    // the field asked for a string an operator has no way to obtain — while
    // giving them a way to paste a stale one over the session sign-in had just
    // written, which 401s later as an app that was working a moment ago.
    //
    // Asserted against a presence: the address field above proves the pane
    // rendered at all, so this absence cannot pass by rendering nothing.
    const html = renderGeneral('selfhosted');
    expect(html).not.toContain('id="settings-token"');
    expect(html).not.toContain('Session token');
    expect(html).not.toContain('type="password"');
  });

  it('does not claim the credentials are stored before they are', () => {
    // Effects do not run under static rendering, so this is the pre-load
    // state. The pane must not assert a stored address it has not read yet:
    // the field is empty and Save is unavailable until something is typed.
    const html = renderGeneral('selfhosted');
    expect(html).toContain('id="settings-base-url"');
    // Save is unavailable until the draft differs from what was read, and
    // nothing has been read. React Aria writes that as a real attribute.
    const save = /<button[^>]*>\s*Save\s*<\/button>/.exec(html)?.[0] ?? '';
    expect(save).not.toBe('');
    expect(save).toContain('disabled');
  });

  it('no longer points the Models pane reader at a file that configures nothing', () => {
    // The old copy said keys live in `infra/compose/.env` and that nothing
    // here is editable. D-083 moved provider keys into per-user rows and
    // REMOVED the environment fallback, so that sentence is not merely stale —
    // it sends an operator to edit a file that has no effect on which models
    // they can use.
    const html = render('model');
    expect(html).not.toContain('infra/compose/.env');
    expect(html).not.toContain('nothing here is editable');
  });

  it('renders the Models pane pre-load state as loading, not as empty', () => {
    // Effects do not run under static rendering. Without an explicit loading
    // state this pane would render as "no connections", which is the one
    // message that must not appear before the list has been fetched.
    expect(render('connections')).toContain('Loading');
  });

  it('says what a planned pane is waiting on rather than rendering blank', () => {
    // Computer was the last of these; it became a real pane with D-237. The
    // shell stays for the next pane that is promised before it is built.
    expect(SETTINGS_PANES.filter((pane) => pane.status === 'planned')).toEqual([]);
    const html = renderToStaticMarkup(
      <I18nProvider>
        <PlannedPane
          pane={{ id: 'computer', label: 'Later', status: 'planned', summary: 'Soon.' }}
        />
      </I18nProvider>,
    );
    expect(html).toContain('Coming soon');
    expect(html).toContain('Soon.');
  });
});
