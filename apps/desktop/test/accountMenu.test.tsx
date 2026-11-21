import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import { vi } from 'vitest';
import {
  ACCOUNT_MENU_ITEMS,
  AccountMenu,
  AccountMenuHeader,
  AccountUsage,
  accountMenuHandler,
} from '../src/renderer/components/AccountMenu';
import type { BillingResponse } from '@crewaid/shared';
import { BotSidebar, type GroupActions } from '../src/renderer/components/BotSidebar';
import { RoomTopBar } from '../src/renderer/components/layout/RoomTopBar';
import type { LaunchSession } from '../src/renderer/launch/LaunchGate';

const NO_GROUP_ACTIONS: GroupActions = {
  toggleCollapsed: () => undefined,
  edit: () => undefined,
  remove: () => undefined,
};

const SESSION: LaunchSession = {
  user: { id: 'usr_1', email: 'ada@example.com', name: 'Ada Lovelace' },
  signOut: () => undefined,
};

function render(onOpenSettings: () => void = () => undefined) {
  return renderToStaticMarkup(
    <I18nProvider>
      <AccountMenu
        name="Ada Lovelace"
        email="ada@example.com"
        initials="AL"
        image={undefined}
        onOpenSettings={onOpenSettings}
        onSignOut={() => undefined}
      />
    </I18nProvider>,
  );
}

describe('AccountMenu', () => {
  it('names the trigger for a screen reader, not just visually', () => {
    expect(render()).toContain('account menu');
  });

  it('offers Log out, which V1 finally gave something to end', () => {
    // Disabled until V1-18. Pre-V1 the CC-07 bearer was the whole credential,
    // so there was no session to end; V1-11 created one and V1-15 gave it a
    // sign-out that ends the row at the orchestrator first.
    const enabled = ACCOUNT_MENU_ITEMS.filter((item) => item.enabled).map((item) => item.id);
    expect(enabled).toContain('logout');
    expect(enabled).toContain('settings');
  });

  it('routes every enabled entry somewhere, so none is a silent click', () => {
    // The failure the disabled rows were guarding against, and one no render
    // test can catch: React Aria builds the popover on open, so these items
    // never appear in static markup. An entry marked enabled but missing from
    // the handler looks live and does nothing.
    for (const item of ACCOUNT_MENU_ITEMS.filter((entry) => entry.enabled)) {
      const plan = vi.fn();
      const settings = vi.fn();
      const logout = vi.fn();
      accountMenuHandler({ plan, settings, logout })(item.id);
      expect(
        plan.mock.calls.length + settings.mock.calls.length + logout.mock.calls.length,
        `"${item.label}" is enabled but routes nowhere`,
      ).toBe(1);
    }
  });

  it('leaves disabled entries unrouted', () => {
    const plan = vi.fn();
    const settings = vi.fn();
    const logout = vi.fn();
    const route = accountMenuHandler({ plan, settings, logout });
    for (const item of ACCOUNT_MENU_ITEMS.filter((entry) => !entry.enabled)) route(item.id);
    expect(plan).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });
});

const PHOTO = 'https://lh3.googleusercontent.com/a/photo=s96-c';

describe('AccountMenuHeader', () => {
  // The popover is built on open, so the header never reaches the menu's own
  // static markup; it is rendered here on its own instead.
  it('leads with who the menu belongs to: photo, name and address', () => {
    const html = renderToStaticMarkup(
      <AccountMenuHeader name="Ada Lovelace" email="ada@example.com" initials="AL" image={PHOTO} />,
    );
    expect(html).toContain(`src="${PHOTO}"`);
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('ada@example.com');
    expect(html).not.toContain('>AL<');
  });

  it('shows initials when there is no photo', () => {
    const html = renderToStaticMarkup(
      <AccountMenuHeader
        name="Ada Lovelace"
        email="ada@example.com"
        initials="AL"
        image={undefined}
      />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('>AL<');
  });

  it('does not print the address twice when it is the name', () => {
    const html = renderToStaticMarkup(
      <AccountMenuHeader
        name="ada@example.com"
        email="ada@example.com"
        initials="AE"
        image={undefined}
      />,
    );
    expect(html.split('ada@example.com')).toHaveLength(2);
  });
});

describe('AccountUsage', () => {
  // Like the header, it lives in the popover, so it is rendered on its own.
  const STARTER: BillingResponse = {
    plan: 'starter',
    status: 'active',
    period: { start: '2026-10-01T10:00:00.000Z', end: '2026-10-20T10:00:00.000Z' },
    cancelAtPeriodEnd: false,
    trialEligible: false,
    compute: { usedSeconds: 44 * 3600, limitSeconds: 100 * 3600 },
    model: { usedUsd: 5, allowanceUsd: 5 },
    voice: {
      listen: { usedSeconds: 0, limitSeconds: 18000 },
      speak: { usedSeconds: 0, limitSeconds: 1800 },
    },
  };
  const NOW = new Date('2026-10-13T15:00:00.000Z');

  it('shows the plan and the share left of each allowance, with when it resets', () => {
    const html = renderToStaticMarkup(<AccountUsage billing={STARTER} now={NOW} />);
    expect(html).toContain('Usage remaining');
    expect(html).toContain('Starter');
    expect(html).toContain('Computer time');
    expect(html).toContain('56%');
    expect(html).toContain('Oct 20');
  });

  it('marks a used-up allowance', () => {
    const html = renderToStaticMarkup(<AccountUsage billing={STARTER} now={NOW} />);
    expect(html).toMatch(/text-danger">0%</);
  });

  it('shows a lapsed plan by what is wrong, with no meters', () => {
    const html = renderToStaticMarkup(
      <AccountUsage
        billing={{ ...STARTER, plan: 'none', status: 'past_due', period: null }}
        now={NOW}
      />,
    );
    expect(html).toContain('Payment failed');
    expect(html).not.toContain('Usage remaining');
    expect(html).not.toContain('Computer time');
  });
});

describe('Room account and crew collections', () => {
  /**
   * The sidebar's collection trap applies to this row too: it sits inside the
   * same aside as the ListBox, and anything that ends up under a React Aria
   * collection as bare text takes the whole window down rather than one
   * component. Asserting the template stays empty is what caught it before.
   */
  it('renders the menu without putting bare text in a collection', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <BotSidebar
          rows={[]}
          pinned={[]}
          selectedId={null}
          onSelect={() => undefined}
          onCreateBot={() => undefined}
          onRowAction={{
            editProfile: () => undefined,
            togglePin: () => undefined,
            hide: () => undefined,
            duplicate: () => undefined,
            remove: () => undefined,
            moveToGroup: () => undefined,
            newGroupFor: () => undefined,
            markUnread: () => undefined,
          }}
          actionFailure={null}
          onDismissActionFailure={() => undefined}
          onOpenSettings={() => undefined}
          searchInputRef={{ current: null }}
          session={SESSION}
          sections={null}
          groups={[]}
          unreadByBot={{}}
          onGroupAction={NO_GROUP_ACTIONS}
        />
      </I18nProvider>,
    );
    expect(html).toContain('Your crew');
    const templates = [...html.matchAll(/<template[^>]*>([\s\S]*?)<\/template>/g)];
    for (const [, contents] of templates) {
      expect((contents ?? '').replace(/<[^>]*>/g, '').trim()).toBe('');
    }
  });

  it('shows the account photo on the row when the session has one', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <RoomTopBar
          session={{ ...SESSION, user: { ...SESSION.user, image: PHOTO } }}
          view={null}
          attention={0}
          onView={() => undefined}
          onSearch={() => undefined}
          onPlugins={() => undefined}
          onSettings={() => undefined}
          onOpenPlan={() => undefined}
        />
      </I18nProvider>,
    );
    expect(html).toContain(`src="${PHOTO}"`);
  });
});
