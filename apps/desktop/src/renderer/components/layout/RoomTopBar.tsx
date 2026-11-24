import { Button, Tooltip } from '@heroui/react';
import type { LaunchSession } from '../../launch/LaunchGate';
import { accountLabel } from '../../launch/launchState';
import { AccountAvatar } from '../AccountAvatar';
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
}: {
  session: LaunchSession;
  view: WorkView | null;
  attention: number;
  onView: (view: WorkView | null) => void;
  onSearch: () => void;
  onPlugins: () => void;
  onSettings: () => void;
}) {
  const t = useT();
  const account = accountLabel(session.user);
  return (
    <header className="crewaid-room-topbar window-drag">
      <span className="crewaid-wordmark">{WORDMARK}</span>
      <WorkNav active={view} attention={attention} onSelect={onView} onCrew={() => onView(null)} />
      <div className="crewaid-topbar-actions window-no-drag">
        {/* Text only: an icon beside "Search" and "Plugins" says nothing the
            word does not, and doubles the weight of the bar. */}
        <Button
          variant="ghost"
          size="sm"
          onPress={onSearch}
          aria-keyshortcuts="Meta+K Control+K"
          className="crewaid-topbar-trigger"
        >
          {t('topbar.search')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onPress={onPlugins}
          aria-haspopup="dialog"
          className="crewaid-topbar-trigger"
        >
          {t('topbar.plugins')}
        </Button>
        <UpdateButton />
        {/* The account lives in the settings sheet — plan, usage and sign out
            included — so the avatar opens it directly rather than a menu that
            only points into it. */}
        <Tooltip delay={400}>
          <Button
            isIconOnly
            variant="ghost"
            aria-label={t('account.open', { name: account.name })}
            aria-haspopup="dialog"
            onPress={onSettings}
            className="crewaid-account-trigger size-9 min-w-9 p-0"
          >
            <AccountAvatar
              initials={account.initials}
              image={session.user.image}
              className="size-9 text-caption"
            />
          </Button>
          <Tooltip.Content placement="bottom">{t('account.settings')}</Tooltip.Content>
        </Tooltip>
      </div>
    </header>
  );
}
