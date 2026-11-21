import { Button, Switch, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import {
  IconCheck,
  IconAlertTriangle,
  IconSun,
  IconMoon,
  IconDeviceDesktop,
} from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Edition } from '@crewaid/shared';
import type {
  AuthStatus,
  TokenBag,
  TokenStoreReadResult,
  TokenStoreWriteResult,
} from '../../preload';
import { ApiClient, failureOf, fetchModelCatalog } from '../api';
import { appInfo, authBridge, tokenStore, type AuthPort } from '../bridge';
import { fetchServerVersion, serverIsOlder } from './serverVersion';
import { AccountSection } from './AccountSection';
import { signInProblem } from './accountState';
import { addressIssue, addressVerdict } from '../launch/launchState';
import { probeReachable } from '../launch/probeReachable';
import {
  checkFailureMessage,
  draftChanged,
  draftFromStore,
  EMPTY_DRAFT,
  saveFailureMessage,
  storeIssue,
  toTokenBag,
  type ConnectionCheck,
  type ConnectionDraft,
} from './connectionForm';
import { setShowBotWork, useShowBotWork } from '../state/transcriptPrefs';
import { setThemePreference, useThemePreference } from '../styles/themePreference';
import { useAppEdition } from '../state/useAppEdition';
import { SettingsRow, SettingsSection, SETTINGS_INPUT_CLASS } from './SettingsLayout';
import { BotsSection, LanguageRow, SystemSection } from './PreferenceRows';
import { useT } from '../i18n/i18n';
import { rich } from '../i18n/rich';

/**
 * General — the orchestrator connection.
 *
 * This pane is the reason the modal exists. `ApiClient` and `WsClient` both
 * fail closed on an empty CC-07 store rather than guessing at localhost, which
 * is the right behaviour and was also, until now, a dead end: nothing in the
 * renderer ever called `tokenStore.set`, so a fresh install could not be
 * pointed at anything.
 *
 * The check is one authenticated call to `GET /models` — static, boot-cached
 * and touching neither Postgres nor Docker, so a green result means
 * "this address is an orchestrator and it accepts this token" and nothing
 * broader. `GET /health` looks like the natural probe and is not: it is the one
 * route excluded from the `/api/v1` prefix (main.ts), so `API_ROUTES.health`
 * resolves through `ApiClient` to a path the server does not serve.
 */
export type GeneralPaneProps = {
  /** Called after credentials are stored, so the shell can reconnect. */
  readonly onSaved?: () => void;
  /** Seams for tests; production uses the CC-07 bridge and the real catalog. */
  readonly readStore?: () => Promise<TokenStoreReadResult>;
  readonly writeStore?: (bag: TokenBag) => Promise<TokenStoreWriteResult>;
  readonly probe?: (draft: ConnectionDraft) => Promise<number>;
  readonly reachAddress?: (baseUrl: string) => Promise<'unreachable' | number>;
  /** V1-11's sign-in, as one injectable port rather than four props. */
  readonly auth?: AuthPort;
  /** Which build this is; read from the main process when not given (tests give it). */
  readonly edition?: Edition | null;
  /** Seams for the D-155 version notice; production asks the server and the main process. */
  readonly readServerVersion?: (baseUrl: string) => Promise<string | null>;
  readonly readAppVersion?: () => Promise<string | null>;
};

/** The shape of an address, shown in the empty field; not a word, so not in the catalog. */
const ADDRESS_EXAMPLE = 'http://localhost:3000';

/** One authenticated round trip against the address being typed, not the stored one. */
function probeWithDraft(draft: ConnectionDraft): Promise<number> {
  const client = new ApiClient({
    credentialsProvider: () =>
      Promise.resolve({
        orchestratorBaseUrl: draft.baseUrl.trim(),
        orchestratorToken: draft.token.trim(),
      }),
  });
  return fetchModelCatalog(client).then((response) => response.models.length);
}

export function GeneralPane({
  onSaved,
  readStore,
  writeStore,
  probe,
  reachAddress,
  auth,
  edition: editionProp,
  readServerVersion,
  readAppVersion,
}: GeneralPaneProps) {
  const t = useT();
  const detectedEdition = useAppEdition();
  const edition = editionProp === undefined ? detectedEdition : editionProp;
  const [versions, setVersions] = useState<{ server: string; app: string | null } | null>(null);
  const read = readStore ?? tokenStore.getState;
  const write = writeStore ?? tokenStore.set;
  const check = probe ?? probeWithDraft;
  const reach = reachAddress ?? probeReachable;
  const account = auth ?? authBridge;

  const [draft, setDraft] = useState<ConnectionDraft>(EMPTY_DRAFT);
  const [saved, setSaved] = useState<ConnectionDraft>(EMPTY_DRAFT);
  const [storeProblem, setStoreProblem] = useState<string | null>(null);
  const [result, setResult] = useState<ConnectionCheck>({ kind: 'idle' });
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ status: 'unconfigured' });
  const [authBusy, setAuthBusy] = useState(false);
  const [authProblem, setAuthProblem] = useState<string | null>(null);

  // The seams are read through a ref, not depended on: an inline `readStore`
  // from a parent would otherwise make the load effect re-run every render.
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  }, [read]);

  /**
   * Pull the form back to what is actually stored.
   *
   * Called on mount AND after every sign-in, because V1-11 gave the store a
   * second writer: the main process puts the session token in it when a
   * browser hands one back. Without this, the form keeps the token it read at
   * mount and Save quietly writes that stale one back over the new session —
   * which fails later, as a 401 from an app that was signed in a moment ago.
   */
  const reloadFromStore = useCallback((): Promise<void> => {
    return readRef.current().then((state) => {
      const stored = draftFromStore(state);
      setDraft(stored);
      setSaved(stored);
      setStoreProblem(storeIssue(state));
    });
  }, []);

  useEffect(() => {
    let live = true;
    void readRef.current().then((state) => {
      if (!live) return;
      const stored = draftFromStore(state);
      setDraft(stored);
      setSaved(stored);
      setStoreProblem(storeIssue(state));
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * The sign-in that finishes somewhere else.
   *
   * A browser round trip does not return to the click that started it, so the
   * result arrives on the bridge's event instead — and the subscription is set
   * up BEFORE the first status read, so a sign-in that completes while this
   * pane is opening is not dropped in the gap between the two.
   */
  const accountRef = useRef(account);
  useEffect(() => {
    accountRef.current = account;
  }, [account]);

  // Held in a ref for the same reason the seams are: the shell passes an
  // inline closure, and depending on it would tear the subscription below down
  // and set it up again on every render of the parent.
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  useEffect(() => {
    let live = true;
    const unsubscribe = accountRef.current.onChanged((status) => {
      if (!live) return;
      setAuthStatus(status);
      setAuthBusy(false);
      setAuthProblem(null);
      void reloadFromStore().then(() => onSavedRef.current?.());
    });
    void accountRef.current.status().then((status) => {
      if (live) setAuthStatus(status);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [reloadFromStore]);

  const signIn = useCallback(async () => {
    setAuthProblem(null);
    setAuthBusy(true);
    const outcome = await accountRef.current.start();
    const problem = signInProblem(outcome);
    setAuthProblem(problem);
    // Stay busy only while the browser is expected to answer. `opened` is not
    // success — the person still has to sign in over there — so the buttons
    // remain disabled until the change event arrives or they give up and
    // reopen the pane.
    if (problem !== null) setAuthBusy(false);
  }, []);

  const signOut = useCallback(async () => {
    setAuthProblem(null);
    setAuthBusy(true);
    const status = await accountRef.current.signOut();
    setAuthStatus(status);
    setAuthBusy(false);
    await reloadFromStore();
    onSavedRef.current?.();
  }, [reloadFromStore]);

  const useCode = useCallback(
    async (code: string) => {
      setAuthProblem(null);
      setAuthBusy(true);
      const status = await accountRef.current.complete(code);
      setAuthStatus(status);
      setAuthBusy(false);
      await reloadFromStore();
      if (status.status === 'signed-in') onSavedRef.current?.();
    },
    [reloadFromStore],
  );

  // Any edit invalidates the previous verdict: a green tick under a changed
  // address is a claim about credentials that were never tried.
  const edit = useCallback((next: Partial<ConnectionDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setResult({ kind: 'idle' });
    setSaveProblem(null);
    setJustSaved(false);
  }, []);

  const runCheck = useCallback(async () => {
    const issue = addressIssue(draft.baseUrl);
    if (issue !== null) {
      setResult({ kind: 'failed', message: issue });
      return;
    }
    setResult({ kind: 'checking' });

    // Signed out, the authenticated probe can only ever answer 401, which
    // reads as "it rejected this token" about a token that does not exist.
    // The unauthenticated probe answers the question actually being asked
    // here, which is whether anything is listening at this address.
    if (draft.token.trim() === '') {
      const address = draft.baseUrl.trim();
      const verdict = addressVerdict(await reach(address), address);
      setResult(verdict === null ? { kind: 'reachable' } : { kind: 'failed', message: verdict });
      return;
    }

    try {
      setResult({ kind: 'ok', modelCount: await check(draft) });
    } catch (error: unknown) {
      setResult({ kind: 'failed', message: checkFailureMessage(failureOf(error)) });
    }
  }, [check, draft, reach]);

  const save = useCallback(async () => {
    // Address-only. `draftIssue` also demands a token, which was right while
    // the token was something an operator typed and is wrong now that signing
    // in mints it — refusing to save an address until a session exists is a
    // deadlock, because the session cannot be obtained without the address.
    const issue = addressIssue(draft.baseUrl);
    if (issue !== null) {
      setSaveProblem(issue);
      return;
    }
    const outcome = await write(toTokenBag(draft));
    const problem = saveFailureMessage(outcome);
    setSaveProblem(problem);
    if (problem !== null) return;
    setSaved(draft);
    setJustSaved(true);
    onSaved?.();
  }, [draft, onSaved, write]);

  const dirty = draftChanged(draft, saved);

  // Ask the saved server which release it runs. Self-hosted only, and
  // only for the address actually in use — not one half-typed in the field.
  const savedBaseUrl = saved.baseUrl.trim();
  useEffect(() => {
    if (edition !== 'selfhosted' || savedBaseUrl === '') return;
    let live = true;
    void Promise.all([
      (readServerVersion ?? fetchServerVersion)(savedBaseUrl),
      (readAppVersion ?? appInfo.version)(),
    ]).then(([server, app]) => {
      if (live) setVersions(server === null ? null : { server, app });
    });
    return () => {
      live = false;
    };
  }, [edition, savedBaseUrl, readServerVersion, readAppVersion]);

  return (
    <div className="crewaid-general-settings">
      {storeProblem === null ? null : <PaneAlert>{storeProblem}</PaneAlert>}

      <AccountSection
        status={authStatus}
        busy={authBusy}
        problem={authProblem}
        onSignIn={() => void signIn()}
        onSignOut={() => void signOut()}
        onPasteCode={(code) => void useCode(code)}
      />

      {/* Self-hosted only. A hosted build's orchestrator is compiled in
          and the main process refuses any other address, so a field here
          would be one that can only ever fail to save. */}
      {edition !== 'selfhosted' ? null : (
        <SettingsSection title={t('settings.general.orchestrator.title')}>
          <SettingsRow
            label={t('settings.general.address.label')}
            htmlFor="settings-base-url"
            description={t('settings.general.address.description')}
            stacked
            control={
              <input
                id="settings-base-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder={ADDRESS_EXAMPLE}
                value={draft.baseUrl}
                onChange={(event) => edit({ baseUrl: event.target.value })}
                className={SETTINGS_INPUT_CLASS}
              />
            }
          />
          {versions === null ? null : (
            <ServerVersionNote server={versions.server} app={versions.app} />
          )}
          <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
            <Button
              variant="tertiary"
              size="sm"
              isDisabled={result.kind === 'checking'}
              onPress={() => void runCheck()}
              className="h-8 rounded-[10px] px-3.5 text-[12px] font-medium"
            >
              {result.kind === 'checking'
                ? t('settings.general.checking')
                : t('settings.general.testConnection')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              isDisabled={!dirty}
              onPress={() => void save()}
              className="h-8 rounded-[10px] px-3.5 text-[12px] font-medium"
            >
              {t('settings.general.save')}
            </Button>
            <CheckResult result={result} />
          </div>
        </SettingsSection>
      )}

      {saveProblem === null ? null : <PaneAlert>{saveProblem}</PaneAlert>}
      {justSaved && !dirty ? (
        <p className="-mt-3 mb-6 px-1 text-[12px] text-muted">{t('settings.general.saved')}</p>
      ) : null}

      <div className="crewaid-settings-preferences">
        <ConversationsSection />
        <AppearanceSection />
        <SystemSection />
        <BotsSection />
      </div>
    </div>
  );
}

/**
 * How a conversation reads. One switch: a bot's thinking and the actions it
 * took are hidden unless asked for, since the reply says what was done; the
 * people who want to check the work can see all of it.
 */
export function ConversationsSection() {
  const t = useT();
  const showBotWork = useShowBotWork();
  return (
    <SettingsSection title={t('settings.general.conversations.title')}>
      <SettingsRow
        label={t('settings.general.showBotWork.label')}
        description={t('settings.general.showBotWork.description')}
        control={
          <Switch
            aria-label={t('settings.general.showBotWork.label')}
            data-show-bot-work
            isSelected={showBotWork}
            onChange={setShowBotWork}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        }
      />
    </SettingsSection>
  );
}

/**
 * The self-hosted server's release, and a nudge when it is behind the app
 * (D-155). The app updates itself; the server updates when its operator runs
 * the installer, so the two drift — and a newer app can call routes an older
 * server does not have yet.
 */
export function ServerVersionNote({ server, app }: { server: string; app: string | null }) {
  const t = useT();
  const behind = app !== null && serverIsOlder(server, app);
  return (
    <div className="px-4 pb-1 text-[12px] text-muted">
      <p>{t('settings.general.serverVersion', { version: server })}</p>
      {behind ? (
        <p className="mt-1 text-warning">
          {rich(t('settings.general.serverBehind', { app: app ?? '' }), {
            code: (command) => <code>{command}</code>,
          })}
        </p>
      ) : null}
    </div>
  );
}

function CheckResult({ result }: { result: ConnectionCheck }) {
  const t = useT();
  if (result.kind === 'idle' || result.kind === 'checking') return null;
  if (result.kind === 'reachable') {
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-muted">
        <IconCheck className="size-4 shrink-0 text-accent" stroke={2.2} />
        {t('settings.general.reachable')}
      </span>
    );
  }
  if (result.kind === 'ok') {
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-muted">
        <IconCheck className="size-4 shrink-0 text-accent" stroke={2.2} />
        {t('settings.general.connected', { count: result.modelCount })}
      </span>
    );
  }
  return (
    <span className="flex items-start gap-1.5 text-[12px] text-danger">
      <IconAlertTriangle className="mt-px size-4 shrink-0" stroke={1.8} />
      {result.message}
    </span>
  );
}

function PaneAlert({ children }: { children: ReactNode }) {
  return (
    <div className="mb-6 flex items-start gap-2 rounded-card border border-danger/25 bg-danger/5 px-3.5 py-3 text-[12px] leading-[17px] text-danger">
      <IconAlertTriangle className="mt-px size-4 shrink-0" stroke={1.8} />
      <span>{children}</span>
    </div>
  );
}

export function AppearanceSection() {
  const t = useT();
  const theme = useThemePreference();
  return (
    <SettingsSection title={t('settings.appearance.title')}>
      <SettingsRow
        label={t('settings.theme.label')}
        description={t('settings.theme.description')}
        control={
          <ToggleButtonGroup
            aria-label={t('settings.theme.label')}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={new Set([theme])}
            onSelectionChange={(keys) => {
              const [value] = keys;
              if (value === 'light' || value === 'dark' || value === 'system')
                setThemePreference(value);
            }}
            fullWidth
            size="sm"
            className="crewaid-theme-segments w-[264px]"
          >
            <ToggleButton id="light" aria-label={t('settings.theme.light')}>
              <IconSun className="size-3.5" stroke={1.6} aria-hidden />
              {t('settings.theme.light')}
            </ToggleButton>
            <ToggleButton id="dark" aria-label={t('settings.theme.night')}>
              <IconMoon className="size-3.5" stroke={1.6} aria-hidden />
              {t('settings.theme.night')}
            </ToggleButton>
            <ToggleButton id="system" aria-label={t('settings.theme.system')}>
              <IconDeviceDesktop className="size-3.5" stroke={1.6} aria-hidden />
              {t('settings.theme.system')}
            </ToggleButton>
          </ToggleButtonGroup>
        }
      />
      <LanguageRow />
    </SettingsSection>
  );
}
