import { Button } from '@heroui/react';
import { IconPuzzle, IconSearch } from '@tabler/icons-react';
import type { LaunchSession } from '../../launch/LaunchGate';
import { accountLabel } from '../../launch/launchState';
import { useBillingGlance } from '../../settings/useBillingGlance';
import { useAppEdition } from '../../state/useAppEdition';
import { AccountMenu } from '../AccountMenu';
import { UpdateButton } from '../UpdateButton';
import { WorkNav } from '../../work/WorkNav';
import type { WorkView } from '../../work/workState';
import { useT } from '../../i18n/i18n';

/** The product's name, never translated. */
const WORDMARK = 'Crewaid';

export function RoomTopBar({
  session,
  view,
  attention,
  onView,
  onSearch,
  onPlugins,
  onSettings,
  onOpenPlan,
}: {
  session: LaunchSession;
  view: WorkView | null;
  attention: number;
  onView: (view: WorkView | null) => void;
  onSearch: () => void;
  onPlugins: () => void;
  onSettings: () => void;
  onOpenPlan: () => void;
}) {
  const t = useT();
  const account = accountLabel(session.user);
  // Only a hosted build has a plan to read; a self-hosted one never asks.
  const plan = useBillingGlance(useAppEdition() === 'cloud');
  return (
    <header className="crewaid-room-topbar window-drag">
      <span className="crewaid-wordmark">{WORDMARK}</span>
      <WorkNav active={view} attention={attention} onSelect={onView} onCrew={() => onView(null)} />
      <div className="crewaid-topbar-actions window-no-drag">
        <Button
          variant="ghost"
          size="sm"
          onPress={onSearch}
          aria-keyshortcuts="Meta+K Control+K"
          className="crewaid-topbar-trigger"
        >
          <IconSearch className="size-3.5" stroke={1.8} aria-hidden /> {t('topbar.search')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onPress={onPlugins}
          aria-haspopup="dialog"
          className="crewaid-topbar-trigger"
        >
          <IconPuzzle className="size-3.5" stroke={1.8} aria-hidden /> {t('topbar.plugins')}
        </Button>
        <UpdateButton />
        <AccountMenu
          {...account}
          email={session.user.email}
          image={session.user.image}
          billing={plan.billing}
          onOpenSettings={onSettings}
          onOpenPlan={onOpenPlan}
          onOpen={plan.refresh}
          onSignOut={session.signOut}
          compact
        />
      </div>
    </header>
  );
}
