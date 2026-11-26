import { Button, ScrollShadow } from '@heroui/react';
import {
  IconBrandTelegram,
  IconChevronLeft,
  IconCreditCard,
  IconDeviceDesktop,
  IconInfoCircle,
  IconLogout,
  IconPlugConnected,
  IconSettings,
  IconTerminal2,
} from '@tabler/icons-react';
import type { BillingResponse } from '@crewaid/shared';
import { useEffect, useRef, useState } from 'react';
import { ListView, Sheet, SheetButton } from '../components/ui';
import { ConnectionsPane } from './ConnectionsPane';
import { GeneralPane } from './GeneralPane';
import { PlanPane } from './PlanPane';
import { ComputerPane } from './ComputerPane';
import { LocalHarnessesPane } from './LocalHarnessesPane';
import { ChannelsPane } from './ChannelsPane';
import { AboutPane } from './AboutPane';
import { AccountIdentity, AccountUsage } from './AccountSummary';
import { useBillingGlance } from './useBillingGlance';
import { useAppEdition } from '../state/useAppEdition';
import { panesFor, settingsPane, type SettingsPaneId } from './settingsPanes';
import { useT } from '../i18n/i18n';

/**
 * The Settings sheet: a full-window frosted overlay with a grouped index and
 * one screen per pane.
 *
 * Open state is owned by the shell and passed in, because several things open
 * it — the account avatar, the right rail's gear, the plan-use notice — and a
 * sheet that owned its own flag would need each of them to reach inside it.
 *
 * Escape walks back the way the user came: from a pane to the index, then
 * closed. The ✕ always closes.
 */

const PANE_ICONS: Record<SettingsPaneId, typeof IconSettings> = {
  channels: IconBrandTelegram,
  general: IconSettings,
  connections: IconPlugConnected,
  plan: IconCreditCard,
  computer: IconDeviceDesktop,
  localHarnesses: IconTerminal2,
  about: IconInfoCircle,
};

/** The index's main group; Plan has its own card and About its own group. */
const MAIN_GROUP: readonly SettingsPaneId[] = [
  'general',
  'connections',
  'channels',
  'computer',
  'localHarnesses',
];

type SettingsView = 'index' | SettingsPaneId;

export type SettingsAccount = {
  readonly name: string;
  readonly email: string;
  readonly initials: string;
  readonly image: string | undefined;
};

export type SettingsModalProps = {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The pane to open straight onto; the index when absent. */
  readonly initialPane?: SettingsPaneId;
  /** Fired after credentials are stored, so the shell can reconnect. */
  readonly onCredentialsSaved?: () => void;
  /** Who is signed in; the index leads with it. */
  readonly account?: SettingsAccount;
  readonly onSignOut?: () => void;
  /** Bumped on `connector.status` WS frames so Local harnesses refreshes live. */
  readonly connectorsVersion?: number | undefined;
};

function rowId(id: SettingsPaneId): string {
  return `crewaid-settings-row-${id}`;
}

export function SettingsModal({
  isOpen,
  onOpenChange,
  onCredentialsSaved,
  initialPane,
  account,
  onSignOut,
  connectorsVersion,
}: SettingsModalProps) {
  const t = useT();
  const edition = useAppEdition();
  const plan = useBillingGlance(edition === 'cloud');
  const [active, setActive] = useState<SettingsView>('index');
  // The pane the index was left for, so coming back puts focus on its row
  // instead of dropping it on the document, where Escape would reach nothing.
  const leftFor = useRef<SettingsPaneId | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const { refresh } = plan;

  useEffect(() => {
    if (!isOpen) return;
    setActive(initialPane ?? 'index');
    leftFor.current = null;
    refresh();
  }, [isOpen, initialPane, refresh]);

  useEffect(() => {
    if (!isOpen) return;
    const focusTarget = () => {
      if (active !== 'index') backRef.current?.focus();
      else if (leftFor.current !== null) document.getElementById(rowId(leftFor.current))?.focus();
    };
    focusTarget();
    const frame = requestAnimationFrame(focusTarget);
    return () => cancelAnimationFrame(frame);
  }, [active, isOpen]);

  const open = (id: SettingsPaneId) => {
    leftFor.current = id;
    setActive(id);
  };
  const back = () => setActive('index');

  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      aria-label={t('settings.title')}
      onEscape={active === 'index' ? undefined : back}
      className="crewaid-settings-dialog"
    >
      <div className="crewaid-sheet-bar window-drag flex h-16 shrink-0 items-center gap-3 px-6 pt-4">
        {active === 'index' ? null : (
          <Button
            ref={backRef}
            variant="secondary"
            size="sm"
            onPress={back}
            aria-label={t('settings.backLabel')}
            className="crewaid-sheet-button h-10 gap-1.5 rounded-full ps-3 pe-4"
          >
            <IconChevronLeft className="size-4 rtl:-scale-x-100" stroke={1.8} aria-hidden />
            {t('settings.title')}
          </Button>
        )}
        <SheetButton
          label={t('settings.close')}
          onPress={() => onOpenChange(false)}
          className="ms-auto"
        />
      </div>
      <ScrollShadow hideScrollBar={false} className="min-h-0 flex-1 overflow-y-auto">
        {active === 'index' ? (
          <SettingsIndex
            edition={edition}
            account={account}
            billing={plan.billing}
            onOpen={open}
            {...(onSignOut === undefined
              ? {}
              : {
                  onSignOut: () => {
                    onOpenChange(false);
                    onSignOut();
                  },
                })}
          />
        ) : (
          <div className="mx-auto flex w-full max-w-[640px] flex-col px-6 pt-2 pb-16">
            <div className="crewaid-settings-header mb-5 px-1">
              <h2>{settingsPane(active).label}</h2>
              <p className="mt-1">{settingsPane(active).summary}</p>
            </div>
            <SettingsPaneBody
              id={active}
              onCredentialsSaved={onCredentialsSaved}
              connectorsVersion={connectorsVersion}
            />
          </div>
        )}
      </ScrollShadow>
    </Sheet>
  );
}

/**
 * The sheet's first screen: who is signed in, the plan, then every pane as a
 * row. Exported so it can be rendered — and asserted — without the overlay.
 */
export function SettingsIndex({
  edition,
  account,
  billing,
  onOpen,
  onSignOut,
}: {
  readonly edition: Parameters<typeof panesFor>[0];
  readonly account?: SettingsAccount | undefined;
  readonly billing: BillingResponse | null;
  readonly onOpen: (id: SettingsPaneId) => void;
  readonly onSignOut?: () => void;
}) {
  const t = useT();
  const panes = panesFor(edition);
  const has = (id: SettingsPaneId) => panes.some((pane) => pane.id === id);
  const row = (id: SettingsPaneId) => (
    <ListView.Item
      key={id}
      id={rowId(id)}
      icon={PANE_ICONS[id]}
      label={settingsPane(id).label}
      onPress={() => onOpen(id)}
    />
  );
  return (
    <div className="mx-auto flex w-full max-w-[580px] flex-col gap-4 px-6 pt-4 pb-16">
      <h2 className="sr-only">{t('settings.title')}</h2>
      {account === undefined ? null : <AccountIdentity {...account} />}

      {/* The plan glance, where the plan pane exists and the server answered.
          Without an answer the pane is still a row in the main group. */}
      {!has('plan') || billing === null ? null : (
        <ListView aria-label={t('account.planAndUsage')}>
          <li className="crewaid-list-view-item">
            <AccountUsage billing={billing} />
          </li>
          {row('plan')}
        </ListView>
      )}

      <ListView aria-label={t('settings.sections')}>
        {MAIN_GROUP.filter(has).map(row)}
        {has('plan') && billing === null ? row('plan') : null}
      </ListView>

      <ListView aria-label={t('settings.pane.about')}>{row('about')}</ListView>

      {onSignOut === undefined ? null : (
        <ListView aria-label={t('account.logout')}>
          <ListView.Item icon={IconLogout} label={t('account.logout')} onPress={onSignOut} />
        </ListView>
      )}
    </div>
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
  connectorsVersion,
}: {
  id: SettingsPaneId;
  onCredentialsSaved?: (() => void) | undefined;
  connectorsVersion?: number | undefined;
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
    case 'localHarnesses':
      return <LocalHarnessesPane connectorsVersion={connectorsVersion} />;
    case 'about':
      return <AboutPane />;
  }
}
