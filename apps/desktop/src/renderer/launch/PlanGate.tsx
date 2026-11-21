import { Button } from '@heroui/react';
import { IconLoader2 } from '@tabler/icons-react';
import type { BillingResponse, Edition, PurchasablePlan } from '@crewaid/shared';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { failureOf, type ApiFailure } from '../api/apiError';
import { getBilling, openBillingPortal, startCheckout } from '../api/billing';
import { useApiClient } from '../api/useApiClient';
import { systemBrowser } from '../bridge';
import { WelcomeCrew } from '../bots/FirstBotWelcome';
import { billingProblem, planActions, planOffers, planSummary } from '../settings/billingState';
import { PlanOfferCard } from '../settings/PlanOfferCard';
import { useAppEdition } from '../state/useAppEdition';
import { GateFrame } from './GateFrame';
import type { LaunchSession } from './LaunchGate';
import { useT } from '../i18n/i18n';

/**
 * The step after sign-up on a hosted build: choose a plan.
 *
 * Without it a new account lands in an app where nothing works — its computer
 * is refused and the included models have no allowance — and the way out is a
 * Settings pane it has to find from the error. So an account with no plan
 * meets the plans first, and the shell mounts once Stripe's webhook has given
 * it one.
 *
 * Only on the way in. Once the shell is up it stays up: a plan that ends
 * mid-session is the shell's to explain (the 402 on a start, the usage notice,
 * Plan & usage), not a reason to unmount a conversation someone is reading.
 *
 * A server that does not bill — self-hosted, or hosted before Stripe is
 * configured — answers `GET /billing` with 404, and the gate opens: there is
 * nothing to choose.
 */

export type PlanGateState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'open' }
  | { readonly kind: 'choose'; readonly billing: BillingResponse }
  | { readonly kind: 'problem'; readonly message: string };

/** What one read of `GET /billing` means for the gate. Pure, so every outcome is testable. */
export function planGateState(
  outcome: { readonly billing: BillingResponse } | { readonly failure: ApiFailure },
): PlanGateState {
  if ('billing' in outcome) {
    return outcome.billing.plan === 'none'
      ? { kind: 'choose', billing: outcome.billing }
      : { kind: 'open' };
  }
  if (outcome.failure.code === 'NOT_FOUND') return { kind: 'open' };
  return { kind: 'problem', message: billingProblem(outcome.failure) };
}

export type PlanGateProps = {
  readonly session: LaunchSession;
  readonly children: ReactNode;
  /** Which build this is; read from the main process when not given (tests give it). */
  readonly edition?: Edition | null;
  /** Rendered instead of reading the plan; used by the tests. */
  readonly initialState?: PlanGateState;
};

export function PlanGate({ session, children, edition: editionProp, initialState }: PlanGateProps) {
  const t = useT();
  const detected = useAppEdition();
  const edition = editionProp === undefined ? detected : editionProp;
  if (edition === 'selfhosted') return <>{children}</>;
  // Not the shell while the edition is unknown: mounting it and then taking it
  // away would open the socket and fetch for an account that may not get in.
  if (edition === null) return <Reading label={t('launch.launchGate.connecting')} />;
  return (
    <HostedPlanGate session={session} initialState={initialState}>
      {children}
    </HostedPlanGate>
  );
}

function HostedPlanGate({
  session,
  children,
  initialState,
}: {
  readonly session: LaunchSession;
  readonly children: ReactNode;
  readonly initialState: PlanGateState | undefined;
}) {
  const t = useT();
  const client = useApiClient();
  const [state, setState] = useState<PlanGateState>(initialState ?? { kind: 'checking' });
  const [busy, setBusy] = useState(false);
  const [sentToStripe, setSentToStripe] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const gated = state.kind !== 'open';

  const load = useCallback(async () => {
    let next: PlanGateState;
    try {
      next = planGateState({ billing: await getBilling(client) });
    } catch (error) {
      next = planGateState({ failure: failureOf(error) });
    }
    setState((current) => (current.kind === 'open' ? current : next));
  }, [client]);

  // Read again whenever the window is focused: the person is most likely back
  // from paying in the browser, and the webhook may have landed meanwhile.
  useEffect(() => {
    if (initialState !== undefined || !gated) return;
    void load();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [gated, initialState, load]);

  const openStripe = useCallback(
    async (request: () => Promise<{ url: string }>) => {
      setBusy(true);
      setProblem(null);
      try {
        const { url } = await request();
        const opened = await systemBrowser.open(url);
        if (opened.status === 'opened') setSentToStripe(true);
        else setProblem(t('launch.planGate.theBrowserDidNotOpen'));
      } catch (error) {
        // A 409 is a plan that arrived since this screen read it.
        if (failureOf(error).code === 'CONFLICT') await load();
        else setProblem(t('launch.planGate.stripeCouldNotBeReached'));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  switch (state.kind) {
    case 'open':
      return <>{children}</>;
    case 'checking':
      return <Reading label={t('launch.planGate.readingYourPlan')} />;
    case 'problem':
      return (
        <GateFrame>
          <div className="text-center">
            <h1>{t('launch.planGate.yourPlanCouldNotBe')}</h1>
            <p className="mt-2.5 text-[14px] leading-[21px] text-muted">{state.message}</p>
            <Button
              variant="primary"
              onPress={() => {
                setState({ kind: 'checking' });
                void load();
              }}
              className="mt-6 h-11 w-full text-[14px] font-medium"
            >
              {t('launch.planGate.tryAgain')}
            </Button>
            <SignedInAs email={session.user.email} onSignOut={session.signOut} className="mt-6" />
          </div>
        </GateFrame>
      );
    case 'choose':
      return (
        <PlanGateView
          billing={state.billing}
          email={session.user.email}
          busy={busy}
          sentToStripe={sentToStripe}
          problem={problem}
          onChoose={(plan) => void openStripe(() => startCheckout(client, plan))}
          onManage={() => void openStripe(() => openBillingPortal(client))}
          onCheckAgain={() => void load()}
          onSignOut={session.signOut}
        />
      );
  }
}

export type PlanGateViewProps = {
  readonly billing: BillingResponse;
  readonly email: string;
  readonly busy: boolean;
  /** Stripe's page has been opened in the browser and the plan has not arrived yet. */
  readonly sentToStripe: boolean;
  readonly problem: string | null;
  readonly onChoose: (plan: PurchasablePlan) => void;
  readonly onManage: () => void;
  readonly onCheckAgain: () => void;
  readonly onSignOut: () => void;
};

/** Presentational, so every plan state renders in a test without a server. */
export function PlanGateView({
  billing,
  email,
  busy,
  sentToStripe,
  problem,
  onChoose,
  onManage,
  onCheckAgain,
  onSignOut,
}: PlanGateViewProps) {
  const t = useT();
  const offers = planOffers(billing);
  const { manage } = planActions(billing);
  return (
    <GateFrame width="wide">
      <WelcomeCrew />
      <h1 className="mt-6">
        {offers.length > 0
          ? t('launch.planGate.chooseYourPlan')
          : t('launch.planGate.yourPlanNeedsAttention')}
      </h1>
      <p className="mt-2.5 text-[15px] leading-[22px] text-muted">{planSummary(billing).line}</p>

      {offers.length === 0 ? null : (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {offers.map((offer) => (
            <PlanOfferCard key={offer.plan} offer={offer} busy={busy} onChoose={onChoose} />
          ))}
        </ul>
      )}

      {manage ? (
        <Button
          variant={offers.length === 0 ? 'primary' : 'tertiary'}
          isDisabled={busy}
          onPress={onManage}
          className="mt-5 h-10 px-5 text-[13px] font-medium"
        >
          {t('launch.planGate.manageBilling')}
        </Button>
      ) : null}

      {sentToStripe ? (
        <p role="status" className="mt-5 text-[13px] leading-[19px] text-muted">
          {t('launch.planGate.finishInYourBrowser')}{' '}
          <button
            type="button"
            onClick={onCheckAgain}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            {t('launch.planGate.checkAgain')}
          </button>
        </p>
      ) : null}

      {problem === null ? null : <p className="mt-4 text-[12px] text-danger">{problem}</p>}

      <SignedInAs
        email={email}
        onSignOut={onSignOut}
        className="mt-7 border-t border-separator pt-4"
      />
    </GateFrame>
  );
}

/** The way out for someone who signed in with the wrong account, or is not ready to pay. */
function SignedInAs({
  email,
  onSignOut,
  className,
}: {
  readonly email: string;
  readonly onSignOut: () => void;
  readonly className: string;
}) {
  const t = useT();
  return (
    <p className={`text-[12px] text-muted ${className}`}>
      {t('launch.planGate.signedInAs', { email })}{' '}
      <button
        type="button"
        onClick={onSignOut}
        className="font-medium text-foreground underline-offset-2 hover:underline"
      >
        {t('launch.planGate.signOut')}
      </button>
    </p>
  );
}

function Reading({ label }: { readonly label: string }) {
  return (
    <GateFrame>
      <div className="flex items-center justify-center gap-2.5" role="status" aria-live="polite">
        <IconLoader2 className="size-4 animate-spin text-muted" stroke={2} aria-hidden />
        <span className="text-[13px] font-medium">{label}</span>
      </div>
    </GateFrame>
  );
}
