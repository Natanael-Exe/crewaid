import { Button, Modal, ScrollShadow, useOverlayState } from '@heroui/react';
import {
  IconCreditCard,
  IconDeviceDesktop,
  IconPlugConnected,
  IconSettings,
  IconX,
  IconBrandTelegram,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { IconButtonTooltip } from '../components/ui';
import { ConnectionsPane } from './ConnectionsPane';
import { GeneralPane } from './GeneralPane';
import { PlanPane } from './PlanPane';
import { ComputerPane } from './ComputerPane';
import { ChannelsPane } from './ChannelsPane';
import { useAppEdition } from '../state/useAppEdition';
import {
  DEFAULT_SETTINGS_PANE,
  panesFor,
  settingsPane,
  type SettingsPaneId,
} from './settingsPanes';
import { useT } from '../i18n/i18n';

/**
 * The Settings modal.
 *
 * Open state is owned by the shell and passed in, because two things open it —
 * the account menu and the right rail's gear — and a modal that owned its own
 * flag would need each of them to reach inside it.
 *
 * The nav is buttons under a `<nav>`, deliberately not `role="tab"`: real tab
 * semantics carry an arrow-key contract, and claiming the role without honoring
 * it is worse for a screen reader than the plain landmark.
 */

const PANE_ICONS: Record<SettingsPaneId, typeof IconSettings> = {
  channels: IconBrandTelegram,
  general: IconSettings,
  connections: IconPlugConnected,
  plan: IconCreditCard,
  computer: IconDeviceDesktop,
};

export type SettingsModalProps = {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The pane to show when opened; General when absent. */
  readonly initialPane?: SettingsPaneId;
  /** Fired after credentials are stored, so the shell can reconnect. */
  readonly onCredentialsSaved?: () => void;
};

export function SettingsModal({
  isOpen,
  onOpenChange,
  onCredentialsSaved,
  initialPane,
}: SettingsModalProps) {
  const t = useT();
  const overlay = useOverlayState({ isOpen, onOpenChange });
  const [active, setActive] = useState<SettingsPaneId>(DEFAULT_SETTINGS_PANE);
  // Opened on a particular pane — the plan-use notice's button opens Plan &
  // usage — and otherwise left where the operator last was.
  useEffect(() => {
    if (isOpen && initialPane !== undefined) setActive(initialPane);
  }, [isOpen, initialPane]);
  const pane = settingsPane(active);
  const panes = panesFor(useAppEdition());

  return (
    <Modal state={overlay}>
      <Modal.Backdrop>
        <Modal.Container size="lg" placement="center" className="sm:w-auto">
          {/* `.modal__dialog` is `flex flex-col max-w-lg p-6`, so the direction,
              the width cap and the padding all have to be overridden here — a
              bare `flex` leaves the nav stacked on top of the body. */}
          <Modal.Dialog
            aria-label={t('settings.title')}
            className="crewaid-settings-dialog flex h-[640px] max-h-[90vh] w-[920px] max-w-[94vw] flex-row overflow-hidden rounded-card bg-surface p-0"
          >
            <nav
              aria-label={t('settings.sections')}
              className="crewaid-settings-nav flex w-[212px] shrink-0 flex-col gap-1 px-3.5 py-6"
            >
              <h2 className="crewaid-settings-title px-2.5 pb-3.5">{t('settings.title')}</h2>
              {panes.map((entry) => {
                const Icon = PANE_ICONS[entry.id];
                const selected = entry.id === active;
                return (
                  <Button
                    key={entry.id}
                    variant="ghost"
                    fullWidth
                    {...(selected ? { 'aria-current': 'true' as const } : {})}
                    onPress={() => setActive(entry.id)}
                    className="crewaid-settings-nav-item flex h-[38px] items-center justify-start gap-2.5 rounded-xl px-3 text-callout font-normal"
                  >
                    <Icon className="size-4 shrink-0" stroke={1.8} />
                    {entry.label}
                  </Button>
                );
              })}
            </nav>

            <div className="crewaid-settings-content flex min-w-0 flex-1 flex-col">
              <div className="crewaid-settings-header flex shrink-0 items-start justify-between gap-4 px-[30px] pb-[22px] pt-[26px]">
                <div className="min-w-0">
                  <h2 className="text-heading font-semibold text-foreground">{pane.label}</h2>
                  <p className="mt-1 text-caption leading-[17px] text-muted">{pane.summary}</p>
                </div>
                <IconButtonTooltip
                  label={t('settings.close')}
                  variant="ghost"
                  size="sm"
                  onPress={() => onOpenChange(false)}
                  className="crewaid-settings-close size-8 shrink-0 rounded-full text-muted"
                >
                  <IconX className="size-4" stroke={1.8} aria-hidden />
                </IconButtonTooltip>
              </div>
              <ScrollShadow
                hideScrollBar={false}
                className="crewaid-settings-body min-h-0 flex-1 overflow-y-auto px-[30px] pb-7"
              >
                <SettingsPaneBody id={active} onCredentialsSaved={onCredentialsSaved} />
              </ScrollShadow>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/**
 * Exported so the panes can be rendered — and asserted — without an overlay:
 * React Aria mounts a dialog through a portal, which `renderToStaticMarkup`
 * has nowhere to put.
 */
export function SettingsPaneBody({
  id,
  onCredentialsSaved,
}: {
  id: SettingsPaneId;
  onCredentialsSaved?: (() => void) | undefined;
}) {
  switch (id) {
    case 'channels':
      return <ChannelsPane />;
    case 'general':
      return <GeneralPane {...(onCredentialsSaved ? { onSaved: onCredentialsSaved } : {})} />;
    case 'connections':
      return <ConnectionsPane />;
    case 'plan':
      return <PlanPane />;
    case 'computer':
      return <ComputerPane />;
  }
}
