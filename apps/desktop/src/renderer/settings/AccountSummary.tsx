import { IconGauge } from '@tabler/icons-react';
import type { BillingResponse } from '@crewaid/shared';
import { AccountAvatar } from '../components/AccountAvatar';
import { useT } from '../i18n/i18n';
import { planSummary, usageGlance } from './billingState';

/**
 * Who the settings sheet belongs to: photo, name and address. It leads the
 * sheet because two accounts with the same display name otherwise look
 * identical right up until one of them signs out.
 */
export function AccountIdentity({
  name,
  email,
  initials,
  image,
}: {
  name: string;
  email: string;
  initials: string;
  image: string | undefined;
}) {
  return (
    <div className="flex items-center gap-3.5 px-1">
      <AccountAvatar
        initials={initials}
        image={image}
        className="crewaid-settings-account-avatar size-12 text-callout"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-heading font-semibold leading-[26px] tracking-[-0.02em] text-room-foreground">
          {name}
        </div>
        {/* Not when it is already the name: an account with no name falls back
            to its address, and printing it twice reads as two facts. */}
        {email === '' || email === name ? null : (
          <div className="truncate text-footnote text-room-muted">{email}</div>
        )}
      </div>
    </div>
  );
}

/** The plan and what is left of each allowance, read rather than chosen. */
export function AccountUsage({
  billing,
  now,
}: {
  readonly billing: BillingResponse;
  /** The clock the reset times are read against; the tests pin it. */
  readonly now?: Date;
}) {
  const t = useT();
  const summary = planSummary(billing);
  const rows = usageGlance(billing, now);
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2.5 text-footnote">
        <IconGauge className="size-4 shrink-0 text-muted" stroke={1.8} aria-hidden />
        <span className="flex-1 font-medium text-foreground">
          {rows.length === 0 ? t('account.plan') : t('account.usageRemaining')}
        </span>
        <span className={summary.tone === 'danger' ? 'text-danger' : 'text-muted'}>
          {summary.title}
        </span>
      </div>
      {rows.length === 0 ? null : (
        <dl className="mt-1.5 flex flex-col gap-1 ps-[26px] text-footnote">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center gap-3">
              <dt className="flex-1 text-foreground">{row.label}</dt>
              <dd className={`tabular-nums ${row.exhausted ? 'text-danger' : 'text-muted'}`}>
                {row.left}
              </dd>
              {row.resets === null ? null : (
                <dd className="w-[58px] text-end tabular-nums text-muted">{row.resets}</dd>
              )}
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
