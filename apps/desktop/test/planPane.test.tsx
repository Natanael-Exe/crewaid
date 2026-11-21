import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import type { BillingResponse } from '@crewaid/shared';
import { PlanView } from '../src/renderer/settings/PlanPane';
import {
  billingProblem,
  meters,
  planActions,
  planSummary,
  usageGlance,
} from '../src/renderer/settings/billingState';
import { panesFor } from '../src/renderer/settings/settingsPanes';
import { IncludedModelsCard } from '../src/renderer/settings/IncludedModelsCard';
import { UsageNotice } from '../src/renderer/components/UsageNotice';
import { usageNoticeText } from '../src/renderer/settings/billingState';

/**
 * D-156 — Plan & usage. Every plan state is a fixture rather than a Stripe
 * account: the states worth getting right are a failed renewal, a cancelled
 * plan running out and a used-up allowance, and a test that needs real money
 * to reach them is a test nobody runs.
 */
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

const TRIAL: BillingResponse = {
  plan: 'trial',
  status: 'trialing',
  period: { start: '2026-10-01T10:00:00.000Z', end: '2026-10-08T10:00:00.000Z' },
  cancelAtPeriodEnd: false,
  trialEligible: false,
  compute: { usedSeconds: 9000, limitSeconds: 36000 },
  model: { usedUsd: 0.25, allowanceUsd: 1 },
  voice: {
    listen: { usedSeconds: 600, limitSeconds: 1800 },
    speak: { usedSeconds: 60, limitSeconds: 300 },
  },
};

/** Two days and three hours before TRIAL's period ends. */
const NOW = new Date('2026-10-06T07:00:00.000Z');

function render(billing: BillingResponse | null, problem: string | null = null) {
  return renderToStaticMarkup(
    <I18nProvider>
      <PlanView
        billing={billing}
        problem={problem}
        busy={false}
        onChoose={() => {}}
        onManage={() => {}}
        now={NOW}
      />
    </I18nProvider>,
  );
}

describe('D-156 — what Plan & usage says', () => {
  it('offers a first-time account the plans as cards, with nothing to manage and no usage', () => {
    expect(planActions(NEVER)).toEqual({ choose: ['starter', 'pro'], manage: false });
    const html = render(NEVER);
    expect(html).toContain('Start the 7-day trial');
    expect(html).toContain('Choose Pro');
    expect(html).toContain('Choose a plan to start your computer.');
    expect(html).not.toContain('Manage billing');
    // "0 h of 0 h" is what an account with no allowance used to be shown.
    expect(html).not.toContain('Computer time');
    expect(html).not.toContain('No plan');
  });

  it('offers Starter at full price once the trial has been used', () => {
    const html = render({ ...NEVER, trialEligible: false });
    expect(html).toContain('Choose Starter');
    expect(html).not.toContain('7-day trial');
  });

  it('shows the trial, when it ends and what follows, and sends plan changes to the portal', () => {
    expect(planSummary(TRIAL).title).toBe('Starter trial');
    expect(planSummary(TRIAL).line).toContain('then $20 / month unless you cancel');
    expect(planActions(TRIAL)).toEqual({ choose: [], manage: true });
    const html = render(TRIAL);
    expect(html).toContain('Manage billing');
    expect(html).toContain('Computer time');
    expect(html).not.toContain('Start the 7-day trial');
  });

  it('measures what is left of the trial, and counts down to its end', () => {
    expect(meters(TRIAL, NOW)).toEqual([
      {
        label: 'Computer time',
        remaining: '7.5 h of 10 h left',
        detail: 'Trial ends in 2d 3h',
        fraction: 0.75,
      },
      {
        label: 'Included model use',
        remaining: '$0.75 of $1.00 left',
        detail: 'Trial ends in 2d 3h',
        fraction: 0.75,
      },
      // D-223: voice has its own allowance, in minutes.
      {
        label: 'Dictation and voice messages',
        remaining: '20 min of 30 min left',
        detail: 'Trial ends in 2d 3h',
        fraction: 1200 / 1800,
      },
      {
        label: 'Spoken replies',
        remaining: '4 min of 5 min left',
        detail: 'Trial ends in 2d 3h',
        fraction: 0.8,
      },
    ]);
  });

  it('counts a paid plan down to its reset, in its two largest units', () => {
    const starter: BillingResponse = { ...TRIAL, plan: 'starter', status: 'active' };
    expect(meters(starter, new Date('2026-10-08T06:46:00.000Z'))[0]?.detail).toBe(
      'Resets in 3h 14m',
    );
    expect(meters(starter, new Date('2026-10-08T09:46:00.000Z'))[0]?.detail).toBe('Resets in 14m');
    expect(meters(starter, new Date('2026-10-08T10:00:00.000Z'))[0]?.detail).toBeNull();
  });

  it('draws no bar for a limit that does not exist, and says what was used instead', () => {
    const pro: BillingResponse = {
      ...TRIAL,
      plan: 'pro',
      status: 'active',
      compute: { usedSeconds: 720000, limitSeconds: null },
      model: { usedUsd: 3, allowanceUsd: 10 },
    };
    const [compute, model] = meters(pro, NOW);
    expect(compute).toEqual({
      label: 'Computer time',
      remaining: 'Unlimited',
      detail: '200 h used',
      fraction: null,
    });
    expect(model?.fraction).toBe(0.7);
  });

  it('empties a bar, and says so, when usage ran past the limit', () => {
    const over = { ...TRIAL, compute: { usedSeconds: 40000, limitSeconds: 36000 } };
    expect(meters(over, NOW)[0]).toMatchObject({ remaining: 'Used up', fraction: 0 });
  });

  it('gives the account menu a share left and a reset moment, not hours and dollars', () => {
    const pro: BillingResponse = {
      ...TRIAL,
      plan: 'pro',
      status: 'active',
      compute: { usedSeconds: 720000, limitSeconds: null },
    };
    expect(usageGlance(pro, NOW)).toEqual([
      { label: 'Computer time', left: 'Unlimited', resets: null, exhausted: false },
      { label: 'Model use', left: '75%', resets: 'Oct 8', exhausted: false },
    ]);
    // Within a day of the reset, the time says more than the date.
    expect(usageGlance(pro, new Date('2026-10-08T01:00:00.000Z'))[1]?.resets).not.toBe('Oct 8');
    expect(usageGlance(NEVER, NOW)).toEqual([]);
  });

  it('says a cancelled plan stays active until the period ends', () => {
    const cancelled: BillingResponse = {
      ...TRIAL,
      plan: 'starter',
      status: 'active',
      cancelAtPeriodEnd: true,
    };
    expect(planSummary(cancelled)).toMatchObject({ title: 'Starter', tone: 'muted' });
    expect(planSummary(cancelled).line).toMatch(/^Cancelled\. Active until /);
  });

  it('sends a subscription Stripe is still collecting on to the portal, never a second plan', () => {
    const pastDue: BillingResponse = { ...NEVER, status: 'past_due', trialEligible: false };
    expect(planSummary(pastDue)).toMatchObject({ title: 'Payment failed', tone: 'danger' });
    expect(planSummary(pastDue).line).toContain('Update your card');
    for (const status of ['past_due', 'unpaid', 'paused', 'incomplete'] as const) {
      expect(planActions({ ...pastDue, status })).toEqual({ choose: [], manage: true });
    }
    const html = render(pastDue);
    expect(html).toContain('Manage billing');
    expect(html).not.toContain('Choose Pro');
  });

  it('lets an account whose plan has ended choose again, with its history in the portal', () => {
    for (const status of ['canceled', 'incomplete_expired'] as const) {
      expect(planActions({ ...NEVER, status, trialEligible: false })).toEqual({
        choose: ['starter', 'pro'],
        manage: true,
      });
    }
  });

  it('gives an admin no plan to buy and nothing to manage', () => {
    const internal: BillingResponse = {
      ...NEVER,
      plan: 'internal',
      compute: { usedSeconds: 3600, limitSeconds: null },
      model: { usedUsd: 2, allowanceUsd: null },
    };
    expect(planActions(internal)).toEqual({ choose: [], manage: false });
    const html = render(internal);
    expect(html).toContain('Internal');
    expect(html).toContain('$2.00 used');
    expect(html).toContain('Unlimited');
    expect(html).not.toContain('Manage billing');
    expect(html).not.toContain('Choose Pro');
  });

  it('reads a 404 as a server that does not bill', () => {
    expect(billingProblem({ code: 'NOT_FOUND', message: 'Not found.' })).toContain(
      'does not have billing turned on',
    );
    expect(render(null, billingProblem({ code: 'NOT_FOUND', message: 'Not found.' }))).toContain(
      'does not have billing turned on',
    );
  });
});

describe('D-152 — which builds show Plan & usage', () => {
  const ids = (edition: Parameters<typeof panesFor>[0]) => panesFor(edition).map((pane) => pane.id);

  it('shows it in a hosted build', () => {
    expect(ids('cloud')).toContain('plan');
  });

  it('hides it from a self-hosted build, which still has its other panes', () => {
    expect(ids('selfhosted')).not.toContain('plan');
    expect(ids('selfhosted')).toContain('general');
  });

  it('hides it until the build knows its edition', () => {
    expect(ids(null)).not.toContain('plan');
    expect(ids(null)).toContain('connections');
  });
});

describe('D-157 — the included models and the plan-use notice', () => {
  const resetsAt = '2026-11-01T12:00:00.000Z';

  it('says what each notice means, and what still works at 100%', () => {
    expect(usageNoticeText({ kind: 'compute', level: 80, resetsAt })).toContain(
      '80% of this period’s computer time',
    );
    expect(usageNoticeText({ kind: 'compute', level: 100, resetsAt })).toContain(
      'Your computer has stopped',
    );
    expect(usageNoticeText({ kind: 'model', level: 100, resetsAt })).toContain(
      'Your own keys still work',
    );
  });

  it('renders the notice with a way to the plan and a way to dismiss it', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <UsageNotice
          notice={{ kind: 'model', level: 80, resetsAt }}
          onOpenPlan={() => {}}
          onDismiss={() => {}}
        />
      </I18nProvider>,
    );
    expect(html).toContain('included model use is spent');
    expect(html).toContain('Plan &amp; usage');
    expect(html).toContain('aria-label="Dismiss"');
  });

  it('shows the included connection read-only: its models, and no key or remove control', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <IncludedModelsCard
          connection={{
            id: 'cmconnectionincluded0001',
            kind: 'crewaid',
            name: 'Crewaid',
            endpoint: null,
            authKind: 'api_key',
            state: 'ACTIVE',
            hasCredential: false,
            credentialSetAt: null,
            createdAt: '2026-10-02T00:00:00.000Z',
            models: [
              {
                id: 'cmmodelincluded000000001',
                connectionId: 'cmconnectionincluded0001',
                upstreamModelId: 'google/gemini-3.8-flash',
                label: 'Gemini 3.8 Flash',
                contextWindow: 1_048_576,
                capabilities: { tools: true, vision: true, reasoning: true },
                createdAt: '2026-10-02T00:00:00.000Z',
              },
            ],
          }}
        />
      </I18nProvider>,
    );
    expect(html).toContain('Included with your plan');
    expect(html).toContain('Gemini 3.8 Flash');
    expect(html).not.toContain('Set key');
    expect(html).not.toContain('Remove');
  });
});
