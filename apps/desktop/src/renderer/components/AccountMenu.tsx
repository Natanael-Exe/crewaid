import { Dropdown, Separator } from '@heroui/react';
import {
  IconCreditCard,
  IconGauge,
  IconInfoCircle,
  IconLogout,
  IconSettings,
} from '@tabler/icons-react';
import type { BillingResponse } from '@crewaid/shared';
import { planSummary, usageGlance } from '../settings/billingState';
import { AccountAvatar } from './AccountAvatar';
import { t, useT } from '../i18n/i18n';

/**
 * The sidebar's account row, as a menu.
 *
 * About stays disabled — it is a real, named destination the shell will grow,
 * and a menu that gains items later reads as an unfinished one where a
 * disabled row reads as a sequenced one.
 *
 * Why log out is live now
 *
 * It was disabled because there was nothing to end: originally the stored bearer
 * WAS the whole credential, so the honest form of "log out" was "clear the
 * stored credentials", which belonged in Settings beside where they were
 * typed. A real session replaced that, with a sign-out
 * that ends the row at the orchestrator before clearing it locally — so the
 * item now has exactly the thing it was missing, and leaving it greyed out
 * meant the only way to leave an account was to go and delete a token by hand.
 *
 * The name is no longer a local label either: it comes from the session the
 * gate resolved, which is an answer from the orchestrator rather than a guess
 * by this process.
 *
 * The open menu leads with who it belongs to — avatar, name, address — before
 * any action. The trigger row truncates a long name and never shows the
 * address, so without the header two accounts with the same display name look
 * identical right up until one of them logs out.
 *
 * On a server that bills, the plan and what is left of it come next, so
 * "how much do I have" is answered without opening Settings — and Plan & usage
 * is one click from it for the person who wants the detail.
 */

export const ACCOUNT_MENU_ITEMS = [
  {
    id: 'plan',
    get label() {
      return t('account.planAndUsage');
    },
    enabled: true,
  },
  {
    id: 'settings',
    get label() {
      return t('account.settings');
    },
    enabled: true,
  },
  {
    id: 'about',
    get label() {
      return t('account.about');
    },
    enabled: false,
  },
  {
    id: 'logout',
    get label() {
      return t('account.logout');
    },
    enabled: true,
  },
] as const;

const DISABLED_KEYS = ACCOUNT_MENU_ITEMS.filter((item) => !item.enabled).map((item) => item.id);

export type AccountMenuKey = (typeof ACCOUNT_MENU_ITEMS)[number]['id'];

export type AccountMenuHandlers = {
  readonly plan: () => void;
  readonly settings: () => void;
  readonly logout: () => void;
};

/**
 * The routing, lifted out of the JSX so it can be proved.
 *
 * An item can be marked enabled in the list above and missing from this
 * switch, which renders a row that looks live and does nothing when clicked —
 * the exact failure the disabled rows were guarding against, and one no
 * rendering test can see: React Aria builds the popover on open, so the items
 * never appear in static markup at all.
 */
// `string | number` rather than `string`: React Aria types a collection key as
// `Key`, and narrowing here would only move the mismatch to the call site.
export function accountMenuHandler(handlers: AccountMenuHandlers): (key: string | number) => void {
  return (key) => {
    switch (key) {
      case 'plan':
        handlers.plan();
        return;
      case 'settings':
        handlers.settings();
        return;
      case 'logout':
        handlers.logout();
        return;
      default:
        // 'about' and anything added to the list but not yet built. Disabled
        // keys never reach here; this is the fence for one that stops being
        // disabled without gaining a handler.
        return;
    }
  };
}

/**
 * Who the open menu belongs to. Its own component because React Aria builds the
 * popover on open, so nothing inside it reaches static markup — this is the
 * piece that can be rendered and checked on its own.
 */
export function AccountMenuHeader({
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
    <div className="flex items-center gap-2.5 px-3 pt-2.5 pb-2">
      <AccountAvatar initials={initials} image={image} className="size-8 text-micro" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-footnote font-medium text-foreground">{name}</div>
        {/* Not when it is already the name: an account with no name falls back
            to its address, and printing it twice reads as two facts. */}
        {email === '' || email === name ? null : (
          <div className="truncate text-caption text-muted">{email}</div>
        )}
      </div>
    </div>
  );
}

/**
 * The plan and what is left of it. Outside the Menu for the header's reason:
 * it is read, not chosen, and as items its rows would take arrow-key focus.
 */
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
    <div className="px-3 py-2">
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

export function AccountMenu({
  name,
  email,
  initials,
  image,
  billing = null,
  onOpenSettings,
  onOpenPlan,
  onOpen,
  onSignOut,
  compact = false,
}: {
  name: string;
  email: string;
  initials: string;
  image: string | undefined;
  /** The plan, on a server that bills; `null` shows no plan section and no Plan & usage. */
  billing?: BillingResponse | null;
  onOpenSettings: () => void;
  onOpenPlan?: () => void;
  /** Called each time the menu opens, so the plan it shows is current. */
  onOpen?: () => void;
  onSignOut: () => void;
  compact?: boolean;
}) {
  const t = useT();
  return (
    <Dropdown
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <Dropdown.Trigger
        aria-label={t('account.menuFor', { name })}
        className={
          compact
            ? 'crewaid-account-trigger'
            : 'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start outline-none data-[hovered]:bg-background-secondary data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus/40'
        }
      >
        <AccountAvatar
          initials={initials}
          image={image}
          className={compact ? 'size-[34px] text-caption' : 'size-7 text-micro'}
        />
        {compact ? null : <span className="truncate text-footnote font-medium">{name}</span>}
      </Dropdown.Trigger>
      <Dropdown.Popover
        placement={compact ? 'bottom end' : 'top start'}
        className="min-w-[260px] rounded-xl"
      >
        {/* Outside the Menu, not a disabled item inside it: it is a label, and
            as an item it would take arrow-key focus and be read out as an
            option that cannot be chosen. */}
        <AccountMenuHeader name={name} email={email} initials={initials} image={image} />
        <Separator className="mx-3" />
        {billing === null ? null : (
          <>
            <AccountUsage billing={billing} />
            <Separator className="mx-3" />
          </>
        )}
        <Dropdown.Menu
          aria-label={t('account.menu')}
          disabledKeys={DISABLED_KEYS}
          onAction={accountMenuHandler({
            plan: onOpenPlan ?? onOpenSettings,
            settings: onOpenSettings,
            logout: onSignOut,
          })}
        >
          {billing === null ? null : (
            <Dropdown.Item id="plan" textValue={t('account.planAndUsage')} className="rounded-lg">
              <IconCreditCard className="size-4 shrink-0" stroke={1.8} />
              <span>
                {billing.plan === 'none' ? t('account.choosePlan') : t('account.planAndUsage')}
              </span>
            </Dropdown.Item>
          )}
          <Dropdown.Item id="settings" textValue={t('account.settings')} className="rounded-lg">
            <IconSettings className="size-4 shrink-0" stroke={1.8} />
            <span>{t('account.settings')}</span>
          </Dropdown.Item>
          <Dropdown.Item id="about" textValue={t('account.about')} className="rounded-lg">
            <IconInfoCircle className="size-4 shrink-0" stroke={1.8} />
            <span>{t('account.about')}</span>
          </Dropdown.Item>
          <Dropdown.Item id="logout" textValue={t('account.logout')} className="rounded-lg">
            <IconLogout className="size-4 shrink-0" stroke={1.8} />
            <span>{t('account.logout')}</span>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
