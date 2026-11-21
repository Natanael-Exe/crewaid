import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { BillingResponse, Edition } from '@crewaid/shared';
import {
  PlanGate,
  PlanGateView,
  planGateState,
  type PlanGateState,
} from '../src/renderer/launch/PlanGate';
import { planOffers } from '../src/renderer/settings/billingState';

/**
 * D-156 — the plan step between sign-up and the shell, on a hosted build.
 *
 * Like the launch gate, the one thing a pure function cannot show is that the
 * shell is NOT THERE while the account has no plan: an account let into a
 * shell where its computer is refused is the first impression this exists to
 * replace.
 */
const SHELL = 'CREWAID-SHELL-SENTINEL';

const SESSION = {
  user: { id: 'u1', email: 'ada@example.com', name: 'Ada' },
  signOut: () => {},
};

const NEVER: BillingResponse = {
  plan: 'none',
  status: null,
  period: null,
  cancelAtPeriodEnd: false,
  trialEligible: true,
  compute: { usedSeconds: 0, limitSeconds: 0 },
  model: { usedUsd: 0, allowanceUsd: 0 },
  voice: {
    listen: { usedSeconds: 0, limitSeconds: 0 },
    speak: { usedSeconds: 0, limitSeconds: 0 },
  },
};

const STARTER: BillingResponse = {
  ...NEVER,
  plan: 'starter',
  status: 'active',
  trialEligible: false,
  period: { start: '2026-10-01T10:00:00.000Z', end: '2026-11-01T10:00:00.000Z' },
  compute: { usedSeconds: 0, limitSeconds: 360_000 },
  model: { usedUsd: 0, allowanceUsd: 5 },
};

function gate(initialState: PlanGateState | undefined, edition: Edition | null) {
  return renderToStaticMarkup(
    <I18nProvider>
      <PlanGate session={SESSION} edition={edition} {...(initialState ? { initialState } : {})}>
        <div>{SHELL}</div>
      </PlanGate>
    </I18nProvider>,
  );
}

function view(billing: BillingResponse, sentToStripe = false) {
  return renderToStaticMarkup(
    <I18nProvider>
      <PlanGateView
        billing={billing}
        email="ada@example.com"
        busy={false}
        sentToStripe={sentToStripe}
        problem={null}
        onChoose={() => {}}
        onManage={() => {}}
        onCheckAgain={() => {}}
        onSignOut={() => {}}
      />
    </I18nProvider>,
  );
}

describe('D-156 — what one read of the plan means for the gate', () => {
  it('holds an account with no plan at the plans', () => {
    expect(planGateState({ billing: NEVER })).toEqual({ kind: 'choose', billing: NEVER });
  });

  it('lets in an account with a plan, and an admin', () => {
    expect(planGateState({ billing: STARTER })).toEqual({ kind: 'open' });
    expect(planGateState({ billing: { ...STARTER, plan: 'internal' } })).toEqual({ kind: 'open' });
  });

  it('lets everyone in on a server that does not bill (404)', () => {
    expect(planGateState({ failure: { code: 'NOT_FOUND', message: 'Not found.' } })).toEqual({
      kind: 'open',
    });
  });

  it('says what went wrong rather than guessing, for any other failure', () => {
    const state = planGateState({ failure: { code: 'NETWORK', message: 'offline' } });
    expect(state.kind).toBe('problem');
  });
});

describe('D-156 — the gate, as it renders', () => {
  it('never holds a self-hosted build, which has no plans', () => {
    expect(gate({ kind: 'choose', billing: NEVER }, 'selfhosted')).toContain(SHELL);
  });

  it('keeps the shell unmounted while the plan is being read, missing, or unreadable', () => {
    const closed: PlanGateState[] = [
      { kind: 'checking' },
      { kind: 'choose', billing: NEVER },
      { kind: 'problem', message: 'Could not reach the server to read your plan.' },
    ];
    for (const state of closed) {
      expect(gate(state, 'cloud'), `${state.kind} rendered the shell`).not.toContain(SHELL);
    }
    // And before the edition is known, since mounting the shell only to take
    // it away would still open its socket.
    expect(gate(undefined, null)).not.toContain(SHELL);
  });

  it('mounts the shell once there is a plan — the presence the cases above are measured against', () => {
    expect(gate({ kind: 'open' }, 'cloud')).toContain(SHELL);
  });

  it('keeps the window draggable and offers a way out on every closed screen', () => {
    const choose = gate({ kind: 'choose', billing: NEVER }, 'cloud');
    const problem = gate({ kind: 'problem', message: 'x' }, 'cloud');
    for (const html of [choose, problem]) {
      expect(html).toContain('window-drag');
      expect(html).toContain('Sign out');
      expect(html).toContain('ada@example.com');
    }
    expect(problem).toContain('Try again');
  });
});

describe('D-156 — the plans it offers', () => {
  it('leads a first-time account with the $1 trial, quoting what follows it', () => {
    const [starter, pro] = planOffers(NEVER);
    expect(starter).toMatchObject({
      plan: 'starter',
      price: '$1',
      then: 'for 7 days, then $20 a month',
      cta: 'Start the 7-day trial',
      recommended: true,
    });
    expect(starter?.points[0]).toBe('10 hours of computer time in the trial, then 100 a month');
    expect(pro).toMatchObject({ plan: 'pro', price: '$100', then: 'a month', cta: 'Choose Pro' });
  });

  it('offers Starter at its own price to an account that has had its trial', () => {
    const [starter] = planOffers({ ...NEVER, trialEligible: false, status: 'canceled' });
    expect(starter).toMatchObject({ price: '$20', then: 'a month', cta: 'Choose Starter' });
    expect(starter?.points[0]).toBe('100 hours of computer time a month');
  });

  it('offers nothing to buy while Stripe is still collecting, only the portal', () => {
    const pastDue: BillingResponse = { ...NEVER, status: 'past_due', trialEligible: false };
    expect(planOffers(pastDue)).toEqual([]);
    const html = view(pastDue);
    expect(html).toContain('Your plan needs attention');
    expect(html).toContain('Manage billing');
    expect(html).toContain('did not go through');
    expect(html).not.toContain('Choose Pro');
  });

  it('renders both plans for a new account, with nothing to manage yet', () => {
    const html = view(NEVER);
    expect(html).toContain('Choose your plan');
    expect(html).toContain('Start the 7-day trial');
    expect(html).toContain('Choose Pro');
    expect(html).not.toContain('Manage billing');
  });

  it('says where to finish once Stripe has been opened, and how to look again', () => {
    expect(view(NEVER)).not.toContain('Finish in your browser');
    const html = view(NEVER, true);
    expect(html).toContain('Finish in your browser');
    expect(html).toContain('Check again');
  });
});
