import type { BotStatus } from '@crewaid/shared';
import { type PlainKey, useT } from '../i18n/i18n';

/**
 * Status presentation for sidebar rows, over the contractual BotStatus enum:
 * IDLE/THINKING/ACTING/AWAITING_APPROVAL/ERROR.
 */
/**
 * Colour AND shape, because the palette has four status colours for five
 * states. AWAITING_APPROVAL and ERROR share the danger colour — both want the
 * operator — but a solid dot for both made "waiting for you" read as "broken",
 * so the wait is a ring: the same urgency, visibly a different state.
 */
const STATUS_STYLE: Record<BotStatus, string> = {
  IDLE: 'bg-foreground-faint',
  THINKING: 'bg-warning',
  ACTING: 'bg-accent',
  AWAITING_APPROVAL: 'border-[1.5px] border-danger bg-transparent',
  ERROR: 'bg-danger',
};

const STATUS_TITLE = {
  IDLE: 'status.idle',
  THINKING: 'status.thinking',
  ACTING: 'status.acting',
  AWAITING_APPROVAL: 'status.awaitingApproval',
  ERROR: 'status.error',
} as const satisfies Record<BotStatus, PlainKey>;

export function StatusDot({ status, unread = 0 }: { status: BotStatus; unread?: number }) {
  const t = useT();
  const hasUnread = unread > 0;
  const unreadOnly = status === 'IDLE' && hasUnread;
  const visual = unreadOnly ? 'bg-accent' : STATUS_STYLE[status];
  const pulse = status === 'THINKING' || status === 'ACTING' ? 'motion-safe:animate-pulse' : '';
  const statusLabel = t(STATUS_TITLE[status]);
  const unreadLabel = hasUnread ? t('sidebar.unread', { count: unread }) : null;
  const label = unreadOnly
    ? unreadLabel!
    : unreadLabel === null
      ? statusLabel
      : `${statusLabel} · ${unreadLabel}`;
  return (
    // `role="img"`: an `aria-label` on a plain span is not announced, so the
    // status was visible and silent. One dot carries both status and unread
    // state so rows never stack two indicators side by side.
    <span
      role="img"
      aria-label={label}
      title={label}
      data-bot-status={status}
      data-unread={hasUnread ? 'true' : undefined}
      className={`inline-block size-2 shrink-0 rounded-full ${visual} ${pulse}`}
    />
  );
}
