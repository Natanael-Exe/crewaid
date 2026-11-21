import { Button, Skeleton } from '@heroui/react';
import { IconExternalLink } from '@tabler/icons-react';
import type { BillingResponse, PurchasablePlan } from '@crewaid/shared';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { failureOf } from '../api/apiError';
import { getBilling, openBillingPortal, startCheckout } from '../api/billing';
import { useApiClient } from '../api/useApiClient';
import { systemBrowser } from '../bridge';
import {
  billingProblem,
  meters,
  planActions,
  planOffers,
  planSummary,
  type Meter,
} from './billingState';
import { PlanOfferCard } from './PlanOfferCard';
import { SettingsRow, SettingsSection } from './SettingsLayout';
import { useT } from '../i18n/i18n';

/**
 * Plan & usage — the hosted service's plans. Cloud builds only.
 *
 * Buying and managing happen on Stripe's pages in the system browser, never
 * here: the app holds no card, and a plan changes when Stripe's webhook says
 * so. That is why the pane reads the plan again whenever the window is focused
 * — the person is most likely coming back from the browser, and a pane that
 * still says "No plan" after they paid sends them to pay twice.
 */
export function PlanPane() {
  const t = useT();
  const client = useApiClient();
  const [billing, setBilling] = useState<BillingResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentToStripe, setSentToStripe] = useState(false);

  const load = useCallback(async () => {
    try {
      setBilling(await getBilling(client));
      setProblem(null);
    } catch (error) {
      setProblem(billingProblem(failureOf(error)));
    }
  }, [client]);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const openStripe = useCallback(
    async (request: () => Promise<{ url: string }>) => {
      setBusy(true);
      try {
        const { url } = await request();
        const opened = await systemBrowser.open(url);
        setSentToStripe(opened.status === 'opened');
        setProblem(opened.status === 'opened' ? null : t('settings.plan.browserDidNotOpen'));
      } catch (error) {
        const failure = failureOf(error);
        // A 409 means the plan changed since this pane last read it — another
        // window, or a webhook that landed meanwhile. Show what is true now.
        if (failure.code === 'CONFLICT') await load();
        else setProblem(t('settings.plan.stripeUnreachable'));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  return (
    <PlanView
      billing={billing}
      problem={problem}
      busy={busy}
      sentToStripe={sentToStripe}
      onChoose={(plan) => void openStripe(() => startCheckout(client, plan))}
      onManage={() => void openStripe(() => openBillingPortal(client))}
    />
  );
}

export type PlanViewProps = {
  readonly billing: BillingResponse | null;
  readonly problem: string | null;
  readonly busy: boolean;
  /** A Stripe page was opened in the browser; the pane catches up when the window is focused. */
  readonly sentToStripe?: boolean;
  readonly onChoose: (plan: PurchasablePlan) => void;
  readonly onManage: () => void;
  /** The clock the countdowns are read against; the tests pin it. */
  readonly now?: Date;
};

/** Presentational, so every plan state renders in a test without a server. */
export function PlanView({
  billing,
  problem,
  busy,
  sentToStripe = false,
  onChoose,
  onManage,
  now,
}: PlanViewProps) {
  const t = useT();
  if (billing === null) {
    if (problem === null) return <PlanLoading />;
    return (
      <SettingsSection title={t('settings.plan.title')}>
        <SettingsRow label={problem} />
      </SettingsSection>
    );
  }

  const summary = planSummary(billing);
  const actions = planActions(billing);
  const offers = planOffers(billing);
  const manage = (
    <Button size="sm" variant="secondary" isDisabled={busy} onPress={onManage}>
      {t('settings.plan.manage')}
      <IconExternalLink className="size-3.5 text-muted" stroke={1.8} aria-hidden />
    </Button>
  );

  return (
    <>
      {offers.length > 0 ? (
        // No plan to describe, so the plans are the content — not a card that
        // says "No plan" over a row of buttons.
        <PlanSection title={t('settings.plan.title')} description={summary.line}>
          <ul className="grid gap-3 sm:grid-cols-2">
            {offers.map((offer) => (
              <PlanOfferCard key={offer.plan} offer={offer} busy={busy} onChoose={onChoose} />
            ))}
          </ul>
          {actions.manage ? (
            <div className="mt-3 flex items-center justify-between gap-4 text-[12px] text-muted">
              <span>{t('settings.plan.invoices')}</span>
              {manage}
            </div>
          ) : null}
        </PlanSection>
      ) : (
        <PlanSection
          title={t('settings.plan.title')}
          description={actions.manage ? t('settings.plan.manageHint') : undefined}
        >
          <div className="crewaid-settings-surface flex items-center justify-between gap-4 rounded-card bg-surface-secondary px-5 py-4">
            <div className="min-w-0">
              <div
                className={`text-[14px] font-medium ${summary.tone === 'danger' ? 'text-danger' : 'text-foreground'}`}
              >
                {summary.title}
              </div>
              <div className="mt-1 text-[13px] leading-[18px] text-muted">{summary.line}</div>
            </div>
            {actions.manage ? <div className="shrink-0">{manage}</div> : null}
          </div>
        </PlanSection>
      )}

      {sentToStripe ? (
        <p role="status" className="-mt-4 mb-6 text-[12px] text-muted">
          {t('settings.plan.finishInBrowser')}
        </p>
      ) : null}

      {/* An account with no plan has no allowance; "0 h of 0 h" says nothing. */}
      {billing.plan === 'none' ? null : (
        <PlanSection
          title={t('settings.plan.usage')}
          description={
            billing.model.allowanceUsd === null ? undefined : t('settings.plan.usageHint')
          }
        >
          <div className="crewaid-settings-surface rounded-card bg-surface-secondary px-5 py-1">
            {meters(billing, now).map((meter) => (
              <MeterRow key={meter.label} meter={meter} />
            ))}
          </div>
        </PlanSection>
      )}

      {problem === null ? null : <p className="text-[12px] text-danger">{problem}</p>}
    </>
  );
}

function PlanLoading() {
  const t = useT();
  return (
    <div aria-busy="true" aria-label={t('settings.plan.loading')}>
      <span role="status" className="sr-only">
        {t('settings.plan.loadingStatus')}
      </span>
      <div aria-hidden="true">
        <PlanSection title={t('settings.plan.title')} description={undefined}>
          <div className="crewaid-settings-surface flex items-center justify-between gap-4 rounded-card bg-surface-secondary px-5 py-4">
            <div className="min-w-0 flex-1 space-y-2.5">
              <Skeleton
                animationType="pulse"
                className="h-4 w-28 rounded-full motion-reduce:animate-none"
              />
              <Skeleton
                animationType="pulse"
                className="h-3 w-4/5 rounded-full motion-reduce:animate-none"
              />
              <Skeleton
                animationType="pulse"
                className="h-3 w-3/5 rounded-full motion-reduce:animate-none"
              />
            </div>
            <Skeleton
              animationType="pulse"
              className="h-8 w-28 shrink-0 rounded-full motion-reduce:animate-none"
            />
          </div>
        </PlanSection>
        <PlanSection title={t('settings.plan.usage')} description={undefined}>
          <div className="crewaid-settings-surface rounded-card bg-surface-secondary px-5 py-1">
            {[0, 1].map((row) => (
              <div key={row} className="space-y-2.5 py-3.5">
                <Skeleton
                  animationType="pulse"
                  className="h-3.5 w-32 rounded-full motion-reduce:animate-none"
                />
                <div className="flex items-center justify-between gap-4">
                  <Skeleton
                    animationType="pulse"
                    className="h-3 w-1/3 rounded-full motion-reduce:animate-none"
                  />
                  <Skeleton
                    animationType="pulse"
                    className="h-3 w-1/4 rounded-full motion-reduce:animate-none"
                  />
                </div>
                <Skeleton
                  animationType="pulse"
                  className="h-1.5 w-full rounded-full motion-reduce:animate-none"
                />
              </div>
            ))}
          </div>
        </PlanSection>
      </div>
    </div>
  );
}

function PlanSection({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section className="mb-8">
      <h3 className="text-[15px] font-semibold text-foreground">{title}</h3>
      {description === undefined ? null : (
        <p className="mt-1 text-[13px] leading-[18px] text-muted">{description}</p>
      )}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function MeterRow({ meter }: { meter: Meter }) {
  const t = useT();
  const empty = meter.fraction === 0;
  return (
    <div className="py-3.5">
      <div className="text-[13px] font-medium text-foreground">{meter.label}</div>
      <div className="mt-1 flex items-center justify-between gap-4 text-[12px] text-muted">
        <span>{meter.detail}</span>
        <span className={empty ? 'font-medium text-danger' : undefined}>{meter.remaining}</span>
      </div>
      {meter.fraction === null ? null : (
        <div
          role="meter"
          aria-label={t('settings.meter.leftLabel', { meter: meter.label })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(meter.fraction * 100)}
          className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-background-tertiary"
        >
          <div
            className={`h-full rounded-full ${meter.fraction <= 0.2 ? 'bg-warning' : 'bg-foreground'}`}
            style={{ width: `${meter.fraction * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
