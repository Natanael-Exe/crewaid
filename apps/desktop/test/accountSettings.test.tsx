import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { BillingResponse } from '@crewaid/shared';
import { BotSidebar, type GroupActions } from '../src/renderer/components/BotSidebar';
import { RoomTopBar } from '../src/renderer/components/layout/RoomTopBar';
import type { LaunchSession } from '../src/renderer/launch/LaunchGate';
import { AccountIdentity, AccountUsage } from '../src/renderer/settings/AccountSummary';
import { SettingsIndex } from '../src/renderer/settings/SettingsModal';

const NO_GROUP_ACTIONS: GroupActions = {
  toggleCollapsed: () => undefined,
  edit: () => undefined,
  remove: () => undefined,
};

const SESSION: LaunchSession = {
  user: { id: 'usr_1', email: 'ada@example.com', name: 'Ada Lovelace' },
  signOut: () => undefined,
};

const ACCOUNT = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  initials: 'AL',
  image: undefined,
};

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

function index(props: Partial<Parameters<typeof SettingsIndex>[0]> = {}) {
  return renderToStaticMarkup(
    <I18nProvider>
      <SettingsIndex
        edition="selfhosted"
        account={ACCOUNT}
        billing={null}
        onOpen={() => undefined}
        onSignOut={() => undefined}
        {...props}
      />
    </I18nProvider>,
  );
}

describe('SettingsIndex', () => {
  it('leads with who is signed in, then every pane as a row, then sign out', () => {
    const html = index();
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('ada@example.com');
    for (const label of ['General', 'Models', 'Channels', 'Computer', 'About', 'Log out']) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html.indexOf('Ada Lovelace')).toBeLessThan(html.indexOf('>General<'));
    expect(html.indexOf('>About<')).toBeLessThan(html.indexOf('>Log out<'));
  });

  it('shows no plan on a self-hosted server, which bills nothing', () => {
    const html = index();
    expect(html).not.toContain('Plan &amp; usage');
    expect(html).not.toContain('Usage remaining');
  });

  it('puts the plan glance first on a hosted server that answered', () => {
    const html = index({ edition: 'cloud', billing: STARTER });
    expect(html).toContain('Usage remaining');
    expect(html).toContain('Plan &amp; usage');
    expect(html.indexOf('Usage remaining')).toBeLessThan(html.indexOf('>General<'));
  });

  it('keeps Plan reachable as a row when the hosted server has not answered', () => {
    const html = index({ edition: 'cloud', billing: null });
    expect(html).not.toContain('Usage remaining');
    expect(html).toContain('Plan &amp; usage');
  });

  it('omits sign out where there is no session to end', () => {
    expect(index({ onSignOut: undefined })).not.toContain('Log out');
  });
});

const PHOTO = 'https://lh3.googleusercontent.com/a/photo=s96-c';

describe('AccountIdentity', () => {
  it('leads with who the settings belong to: photo, name and address', () => {
    const html = renderToStaticMarkup(
      <AccountIdentity name="Ada Lovelace" email="ada@example.com" initials="AL" image={PHOTO} />,
    );
    expect(html).toContain(`src="${PHOTO}"`);
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('ada@example.com');
    expect(html).not.toContain('>AL<');
  });

  it('shows initials when there is no photo', () => {
    const html = renderToStaticMarkup(
      <AccountIdentity
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
      <AccountIdentity
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
  it('renders the sidebar without putting bare text in a collection', () => {
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

  it('shows the account photo on the top bar avatar, which opens settings', () => {
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
        />
      </I18nProvider>,
    );
    expect(html).toContain(`src="${PHOTO}"`);
    expect(html).toContain('aria-label="Account and settings for Ada Lovelace"');
    expect(html).toContain('aria-haspopup="dialog"');
  });
});
