import { SettingsSection } from './SettingsLayout';
import type { SettingsPane } from './settingsPanes';
import { useT } from '../i18n/i18n';

/**
 * A pane that exists in the nav but has no controls yet.
 *
 * It states what will live here and what has to land first, the way the right
 * rail's Routines panel names M8-FE-01. An empty pane with no explanation is
 * indistinguishable from a broken one, and the operator has no way to tell.
 */
export function PlannedPane({ pane }: { pane: SettingsPane }) {
  const t = useT();
  return (
    <SettingsSection title={t('settings.comingSoon')}>
      <div className="px-4 py-5 text-[13px] leading-[19px] text-muted">{pane.summary}</div>
    </SettingsSection>
  );
}
