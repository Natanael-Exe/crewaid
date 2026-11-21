/**
 * The Settings modal's pane registry.
 *
 * A list rather than a switch in the component so the nav, the routing and the
 * tests read the same source: a pane that exists in the nav but has no body is
 * a `planned` entry with the copy it will be replaced by, which is what keeps a
 * shell from quietly looking like a finished screen.
 */

import type { Edition } from '@crewaid/shared';
import { t } from '../i18n/i18n';

export type SettingsPaneId = 'general' | 'connections' | 'channels' | 'plan' | 'computer';

export type SettingsPane = {
  readonly id: SettingsPaneId;
  readonly label: string;
  /** `planned` panes render their shell and say what will fill them. */
  readonly status: 'ready' | 'planned';
  /** Rendered in the shell, so the promise stays honest and dated. */
  readonly summary: string;
  /** Only these builds show the pane; absent means every build. */
  readonly editions?: readonly Edition[];
};

// Getters, not values: the list is built once at import, and a label read
// then would stay in whatever language was active at that moment.
export const SETTINGS_PANES: readonly SettingsPane[] = [
  {
    id: 'general',
    get label() {
      return t('settings.pane.general');
    },
    status: 'ready',
    // Appearance lives here as a section rather than as its own nav entry.
    // It holds one control that cannot move yet, and a nav entry whose pane
    // says "coming soon" spends a permanent slot on a promise — the section
    // says the same thing in one row, next to the settings it belongs with.
    get summary() {
      return t('settings.pane.general.summary');
    },
  },
  {
    id: 'connections',
    get label() {
      return t('settings.pane.connections');
    },
    status: 'ready',
    // ONE pane, not two. `Connections` listed each provider account and the
    // models under it; `Model` listed the same models grouped by the same
    // connections, read-only, plus a per-model line saying it could not run
    // because its connection had no key — which the connection's own status
    // chip already says once instead of once per model. Two panes over one
    // subject is how an operator ends up looking for the key field on the
    // screen that does not have it.
    get summary() {
      return t('settings.pane.connections.summary');
    },
  },
  {
    id: 'channels',
    get label() {
      return t('settings.pane.channels');
    },
    status: 'ready',
    get summary() {
      return t('settings.pane.channels.summary');
    },
  },
  {
    id: 'plan',
    get label() {
      return t('settings.pane.plan');
    },
    status: 'ready',
    // The hosted service's plans. A self-hosted server bills nothing,
    // so its build has no pane to show — not one that says "none".
    editions: ['cloud'],
    get summary() {
      return t('settings.pane.plan.summary');
    },
  },
  {
    id: 'computer',
    get label() {
      return t('settings.pane.computer');
    },
    status: 'ready',
    get summary() {
      return t('settings.pane.computer.summary');
    },
  },
];

export const DEFAULT_SETTINGS_PANE: SettingsPaneId = 'general';

/**
 * The panes a build shows. Before the edition is known (`null`) only the panes
 * every build has: a guess either way flashes a pane at someone who should
 * never see it.
 */
export function panesFor(edition: Edition | null): readonly SettingsPane[] {
  return SETTINGS_PANES.filter(
    (pane) => pane.editions === undefined || (edition !== null && pane.editions.includes(edition)),
  );
}

export function settingsPane(id: SettingsPaneId): SettingsPane {
  const pane = SETTINGS_PANES.find((candidate) => candidate.id === id);
  // Unreachable via SettingsPaneId, but the array is the source of truth and a
  // find is optional by type; falling back beats a non-null assertion.
  return pane ?? { id, label: id, status: 'planned', summary: '' };
}
