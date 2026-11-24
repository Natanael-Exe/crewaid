import { IconClock } from '@tabler/icons-react';
import { EmptyState } from '../components/ui';
import { SettingsSection } from './SettingsLayout';
import type { SettingsPane } from './settingsPanes';
import { useT } from '../i18n/i18n';

/**
 * A pane that exists in the nav but has no controls yet.
 *
 * It states what will live here and what has to land first, the way the right
 * rail's Routines panel names what it waits on. An empty pane with no explanation is
 * indistinguishable from a broken one, and the operator has no way to tell.
 */
export function PlannedPane({ pane }: { pane: SettingsPane }) {
  const t = useT();
  return (
    <SettingsSection title={t('settings.comingSoon')}>
      <EmptyState size="sm" className="py-6">
        <EmptyState.Header>
          <EmptyState.Media variant="icon">
            <IconClock className="size-4 text-muted" aria-hidden />
          </EmptyState.Media>
          <EmptyState.Description>{pane.summary}</EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    </SettingsSection>
  );
}
