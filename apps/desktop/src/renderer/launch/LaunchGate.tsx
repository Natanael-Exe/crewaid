import { Alert, Button, Input, Skeleton, Spinner } from '@heroui/react';
import { IconArrowRight } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Edition } from '@crewaid/shared';
import markUrl from '@crewaid/brand/assets/logos/app-mark.png';
import { GateFrame } from './GateFrame';
import type { AuthStatus, SignInUser } from '../../preload';
import { authBridge, tokenStore, type AuthPort } from '../bridge';
import { readPastedCode, signInProblem } from '../settings/accountState';
import { probeReachable } from './probeReachable';
import { useAppEdition } from '../state/useAppEdition';
import {
  addressIssue,
  addressVerdict,
  isReady,
  launchCopy,
  resolveLaunchState,
  type LaunchState,
} from './launchState';
import { useT } from '../i18n/i18n';

/**
 * The first interaction.
 *
 * Why the shell is behind this
 *
 * V1 made an account mandatory. Without one, every REST route 401s and the
 * WebSocket is refused at the HTTP upgrade — so the shell renders a
 * bot list that cannot list, a composer that cannot send and a details rail
 * with nothing to detail. It shipped that way, and what it produced was an
 * empty app beside a red banner: an operator's first impression of Crewaid
 * was a product that looked broken rather than one that had not been set up.
 *
 * So `children` are not rendered, not mounted, and not given a chance to fetch
 * until there is a session. That is stricter than hiding them, deliberately:
 * `useChat` subscribes and fetches on mount, and a shell mounted behind an
 * overlay would still open a socket, still be refused, and still write a
 * connection error into a state nobody can see.
 *
 * Why it asks every time
 *
 * The status is a live question to the orchestrator, never a remembered
 * answer. A session revoked from somewhere else must not leave this app
 * showing a name and a working sidebar until the first frame is refused.
 */

/**
 * What the shell is handed once the gate opens.
 *
 * The account and the way to end it travel together, from the one component
 * that owns the session. The sidebar previously carried a build-time constant
 * for the first and had the second disabled, which is what a shell that is
 * never told who it is renders.
 */
export type LaunchSession = {
  readonly user: SignInUser;
  readonly signOut: () => void;
};

export type LaunchGateProps = {
  /**
   * A function, not a node: the shell cannot be built before there is an
   * account to build it for, and a node would have to be constructed by a
   * caller that does not have one yet.
   */
  readonly children: (session: LaunchSession) => ReactNode;
  /** Seams for tests; production uses the token-store bridge and a real round trip. */
  readonly auth?: AuthPort;
  readonly saveAddress?: (baseUrl: string) => Promise<boolean>;
  readonly probeAddress?: (baseUrl: string) => Promise<'unreachable' | number>;
  /** Rendered instead of the form; used by the tests to assert the gate is closed. */
  readonly initialState?: LaunchState;
  /** Which build this is; read from the main process when not given (tests give it). */
  readonly edition?: Edition | null;
};

async function saveOverBridge(baseUrl: string): Promise<boolean> {
  // Only the address. The token is what signing in is about to produce, and
  // writing an empty one here would clear the bag rather than seed it.
  const result = await tokenStore.set({ orchestratorBaseUrl: baseUrl.replace(/\/+$/, '') });
  return result.status === 'saved';
}

const ORCHESTRATOR_ADDRESS_EXAMPLE = 'http://localhost:3000';

export function LaunchGate({
  children,
  auth,
  saveAddress,
  probeAddress,
  initialState,
  edition: editionProp,
}: LaunchGateProps) {
  const t = useT();
  const detectedEdition = useAppEdition();
  const edition = editionProp === undefined ? detectedEdition : editionProp;
  const account = auth ?? authBridge;
  const save = saveAddress ?? saveOverBridge;
  const probe = probeAddress ?? probeReachable;

  const [state, setState] = useState<LaunchState>(initialState ?? { kind: 'checking' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [editingAddress, setEditingAddress] = useState(false);
  const [address, setAddress] = useState('');
  const [addressProblem, setAddressProblem] = useState<string | null>(null);
  const [savingAddress, setSavingAddress] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [code, setCode] = useState('');

  const accountRef = useRef(account);
  useEffect(() => {
    accountRef.current = account;
  }, [account]);

  const apply = useCallback((status: AuthStatus): void => {
    setState(resolveLaunchState(status));
    setBusy(false);
  }, []);

  /**
   * Subscribe BEFORE the first status read, for the reason `GeneralPane` does:
   * a sign-in that completes while this is mounting would otherwise land in
   * the gap between the two and leave the gate closed over a live session.
   */
  useEffect(() => {
    if (initialState !== undefined) return;
    let live = true;
    const unsubscribe = accountRef.current.onChanged((status) => {
      if (!live) return;
      setProblem(null);
      setEditingAddress(false);
      apply(status);
    });
    void accountRef.current.status().then((status) => {
      if (live) apply(status);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [apply, initialState]);

  const recheck = useCallback(async () => {
    setProblem(null);
    setState({ kind: 'checking' });
    apply(await accountRef.current.status());
  }, [apply]);

  const signIn = useCallback(async () => {
    setProblem(null);
    setBusy(true);
    const outcome = await accountRef.current.start();
    const issue = signInProblem(outcome);
    setProblem(issue);
    // `opened` is not success — the person still has to sign in over there —
    // so this stays busy until the change event arrives.
    if (issue !== null) setBusy(false);
  }, []);

  const useCode = useCallback(
    async (pasted: string) => {
      setProblem(null);
      setBusy(true);
      apply(await accountRef.current.complete(pasted));
    },
    [apply],
  );

  const signOut = useCallback(async () => {
    setProblem(null);
    setBusy(true);
    setShowPaste(false);
    setCode('');
    apply(await accountRef.current.signOut());
  }, [apply]);

  const submitAddress = useCallback(async () => {
    const issue = addressIssue(address);
    if (issue !== null) {
      setAddressProblem(issue);
      return;
    }
    setAddressProblem(null);
    setSavingAddress(true);
    const trimmed = address.trim();
    const verdict = addressVerdict(await probe(trimmed), trimmed);
    if (verdict !== null) {
      setAddressProblem(verdict);
      setSavingAddress(false);
      return;
    }
    if (!(await save(trimmed))) {
      setAddressProblem(t('launch.launchGate.thisMachineCouldNotStore'));
      setSavingAddress(false);
      return;
    }
    setSavingAddress(false);
    setEditingAddress(false);
    await recheck();
  }, [address, probe, recheck, save]);

  if (isReady(state) && !editingAddress) {
    return <>{children({ user: state.user, signOut: () => void signOut() })}</>;
  }

  const copy = launchCopy(state, edition);
  const askingForAddress = editingAddress || state.kind === 'needs-address';
  const pasted = readPastedCode(code);

  return (
    <GateFrame>
      {/* `text-center` here rather than on each child: this screen is one
          centred column, and centring is a property of the column. Inputs opt
          back out through GATE_INPUT_CLASS — a centred caret in a URL field
          looks like a bug, and a half-typed address jumps as it grows. */}
      <div className="text-center">
        <Mark />

        {state.kind === 'checking' ? (
          <Checking />
        ) : (
          <>
            <h1 className="mt-7">
              {askingForAddress ? t('launch.launchGate.pointThisAppAtAn') : copy.title}
            </h1>
            <p className="mt-2.5 text-callout leading-[21px] text-muted">
              {askingForAddress ? t('launch.launchGate.crewaidRunsItsAgentsOn') : copy.body}
            </p>

            {askingForAddress ? (
              <AddressForm
                value={address}
                problem={addressProblem}
                busy={savingAddress}
                onChange={(next) => {
                  setAddress(next);
                  setAddressProblem(null);
                }}
                onSubmit={() => void submitAddress()}
                {...(state.kind === 'needs-address'
                  ? {}
                  : { onCancel: () => setEditingAddress(false) })}
              />
            ) : (
              <div className="mt-6 flex flex-col gap-3">
                <Button
                  variant="primary"
                  isDisabled={busy}
                  onPress={() => void (copy.action === 'sign-in' ? signIn() : recheck())}
                  className="h-11 w-full text-callout font-medium"
                >
                  {busy
                    ? t('launch.launchGate.waitingForTheBrowser')
                    : copy.action === 'sign-in'
                      ? t('launch.launchGate.signInWithBrowser')
                      : t('launch.planGate.tryAgain')}
                </Button>

                {/* Self-hosted only: a hosted build has one orchestrator,
                      compiled in, and the main process refuses any other. */}
                {edition !== 'selfhosted' ? null : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingAddress(true);
                      setProblem(null);
                    }}
                    className="text-caption text-muted underline-offset-2 hover:underline"
                  >
                    {t('launch.launchGate.changeOrchestratorAddress')}
                  </button>
                )}
              </div>
            )}

            {problem === null ? null : <GateAlert>{problem}</GateAlert>}

            {!askingForAddress && copy.action === 'sign-in' ? (
              <div className="mt-8 border-t border-separator pt-5">
                <button
                  type="button"
                  onClick={() => setShowPaste((open) => !open)}
                  className="text-caption text-muted underline-offset-2 hover:underline"
                >
                  {/* Not "the browser could not return to this app": that is a
                        claim about something which has not happened yet, and it
                        reads as a failure notice on a screen where nothing has
                        failed. The explanation belongs inside, once opened. */}
                  {showPaste
                    ? t('launch.launchGate.hideCodeEntry')
                    : t('launch.launchGate.pasteACodeInstead')}
                </button>
                {showPaste ? (
                  <div className="mt-3">
                    <p className="mb-2 text-caption leading-[17px] text-muted">
                      {t('launch.launchGate.theSignInPageShows')}
                    </p>
                    <div className="flex items-center gap-2">
                      <Input
                        id="launch-auth-code"
                        variant="secondary"
                        type="text"
                        aria-label={t('launch.launchGate.pasteTheCodeFromThe')}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={t('launch.launchGate.pasteTheCodeFromThe')}
                        value={code}
                        onChange={(event) => setCode(event.target.value)}
                        className="flex-1 text-start"
                      />
                      <Button
                        variant="tertiary"
                        size="sm"
                        isDisabled={pasted === null || busy}
                        onPress={() => {
                          if (pasted === null) return;
                          setCode('');
                          void useCode(pasted);
                        }}
                        className="h-9 shrink-0 rounded-[10px] px-3.5 text-caption font-medium"
                      >
                        {t('launch.launchGate.useCode')}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </GateFrame>
  );
}

function Mark() {
  const t = useT();
  return (
    <div className="flex flex-col items-center">
      <img
        src={markUrl}
        alt=""
        aria-hidden
        width={64}
        height={64}
        draggable={false}
        className="size-16 select-none drop-shadow-md"
      />
      <span className="crewaid-gate-wordmark mt-3">{t('launch.launchGate.crewaid')}</span>
    </div>
  );
}

/**
 * The loading state, which is a real state and not a blank frame.
 */
function Checking() {
  const t = useT();
  return (
    <div className="mt-7" role="status" aria-live="polite">
      <div className="flex items-center justify-center gap-2.5">
        <Spinner size="sm" aria-hidden />
        <span className="text-footnote font-medium">{t('launch.launchGate.connecting')}</span>
      </div>
      <p className="mt-2 text-footnote leading-[19px] text-muted">
        {t('launch.launchGate.checkingYourOrchestratorAndWho')}
      </p>
      <div className="mt-6 flex flex-col items-center gap-2.5" aria-hidden>
        <Skeleton className="h-2.5 w-full rounded-full" />
        <Skeleton className="h-2.5 w-4/5 rounded-full" />
        <Skeleton className="h-2.5 w-2/3 rounded-full" />
      </div>
    </div>
  );
}

function AddressForm({
  value,
  problem,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: string;
  problem: string | null;
  busy: boolean;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
}) {
  const t = useT();
  return (
    <form
      className="mt-6"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor="launch-base-url" className="mb-1.5 block text-start text-caption font-medium">
        {t('launch.launchGate.orchestratorAddress')}
      </label>
      <Input
        id="launch-base-url"
        variant="secondary"
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder={ORCHESTRATOR_ADDRESS_EXAMPLE}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full text-start"
      />
      {problem === null ? null : <GateAlert>{problem}</GateAlert>}
      <div className="mt-4 flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          isDisabled={busy}
          className="h-11 flex-1 text-callout font-medium"
        >
          {busy ? t('launch.launchGate.checking') : t('launch.launchGate.continue')}
          {busy ? null : (
            <IconArrowRight className="ms-1 size-4 rtl:-scale-x-100" stroke={1.8} aria-hidden />
          )}
        </Button>
        {onCancel === undefined ? null : (
          <Button
            variant="ghost"
            isDisabled={busy}
            onPress={onCancel}
            className="h-11 px-4 text-callout font-medium text-muted"
          >
            {t('launch.launchGate.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

function GateAlert({ children }: { children: ReactNode }) {
  return (
    <Alert status="danger" role="alert" className="mt-3 text-start text-caption">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description className="text-caption leading-[17px]">{children}</Alert.Description>
      </Alert.Content>
    </Alert>
  );
}
