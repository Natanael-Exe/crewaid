import type { BotStatus } from '@crewaid/shared';
import { type PlainKey, useT } from '../i18n/i18n';

/**
 * Role + status presentation for sidebar rows.
 *
 * The ROLE chip is the tiny bordered pill from ref-01. Truncates FIRST so the
 * bot name stays readable ("Warden — Pipeline M…").
 *
 * The STATUS dot uses the contractual BotStatus enum (D-006 vocabulary):
 * IDLE/THINKING/ACTING/AWAITING_APPROVAL/ERROR. ref-01's shell only shows
 * presence implicitly; the PRD makes status a first-class field, so the row
 * renders a small colored dot next to the timestamp.
 */

export function RoleChip({ role }: { role: string }) {
  return (
    <span
      className="min-w-0 max-w-[92px] shrink-2 truncate rounded-md bg-background-tertiary px-1.5 py-px text-[10px] leading-[16px] text-muted"
      title={role}
    >
      {role}
    </span>
  );
}

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

export function StatusDot({ status }: { status: BotStatus }) {
  const t = useT();
  return (
    // `role="img"`: an `aria-label` on a plain span is not announced, so the
    // status was visible and silent.
    <span
      role="img"
      aria-label={t(STATUS_TITLE[status])}
      title={t(STATUS_TITLE[status])}
      className={`inline-block size-1.5 shrink-0 rounded-full ${STATUS_STYLE[status]} ${
        status === 'THINKING' || status === 'ACTING' ? 'motion-safe:animate-pulse' : ''
      }`}
    />
  );
}
