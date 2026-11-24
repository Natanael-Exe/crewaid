import { Alert, Button, Input } from '@heroui/react';
import { useState } from 'react';
import type { AuthStatus } from '../../preload';
import { AccountAvatar } from '../components/AccountAvatar';
import { accountLabel } from '../launch/launchState';
import { accountSummary, canSignIn, readPastedCode, type AccountTone } from './accountState';
import { SettingsSection } from './SettingsLayout';
import { useT } from '../i18n/i18n';

/**
 * Account — who this install is signed in as.
 *
 * Why the signed-in case is a row and not a form
 *
 * It was a Status row with a sentence, then a button strip: "Sign in again",
 * "Sign out", "Paste a code instead" — three controls, two of which only exist
 * for a sign-in that has not happened. Signed in, there is exactly one thing a
 * person comes here to do, and it is leave.
 *
 * So when there is an account, this renders the account: avatar, name, address,
 * and Sign out. The sign-in machinery appears only when there is no session,
 * which is the state it belongs to — and with session sign-in that state is rare here,
 * because the gate handles it before the shell ever opens.
 *
 * Presentational on purpose. It owns the paste field's local text and nothing
 * else; the status, the busy flag and every round trip belong to `GeneralPane`,
 * because a successful sign-in also changes what is in the token store and the
 * pane above has a form bound to it. Two components reading that store
 * independently is how a Save button ends up writing back the token a sign-in
 * just replaced.
 *
 * Why there is one button and not three
 *
 * Google, GitHub and the magic link are offered by the ORCHESTRATOR's sign-in
 * page, which is the only place that knows which of them are configured. A
 * provider menu here would be this app guessing at another machine's
 * environment, and guessing wrong produces a button that redirects into a 500.
 */

export type AccountSectionProps = {
  readonly status: AuthStatus;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onSignIn: () => void;
  readonly onSignOut: () => void;
  readonly onPasteCode: (code: string) => void;
};

const TONE_CLASS: Record<AccountTone, string> = {
  ok: 'text-muted',
  muted: 'text-muted',
  danger: 'text-danger',
};

export function AccountSection({
  status,
  busy,
  problem,
  onSignIn,
  onSignOut,
  onPasteCode,
}: AccountSectionProps) {
  const t = useT();
  const [code, setCode] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const summary = accountSummary(status);
  const pasted = readPastedCode(code);

  if (status.status === 'signed-in') {
    const account = accountLabel(status.user);
    return (
      <SettingsSection title={t('settings.account.title')}>
        <div className="flex items-center gap-3 px-4 py-3.5">
          <AccountAvatar
            initials={account.initials}
            image={status.user.image}
            className="crewaid-settings-account-avatar size-10 text-footnote"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-footnote font-medium text-foreground">{account.name}</div>
            {/* The address only when it is not already the name: a magic-link
                account with no name falls back to its email, and printing it
                twice reads as two different facts about the same person. */}
            {status.user.email === '' || status.user.email === account.name ? null : (
              <div className="truncate text-caption text-muted">{status.user.email}</div>
            )}
          </div>
          <Button
            variant="tertiary"
            size="sm"
            isDisabled={busy}
            onPress={onSignOut}
            className="h-8 shrink-0 rounded-[10px] px-3.5 text-caption font-medium"
          >
            {t('settings.account.signOut')}
          </Button>
        </div>
        {problem === null ? null : (
          <div className="px-4 pb-3.5">
            <Alert status="danger" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{problem}</Alert.Description>
              </Alert.Content>
            </Alert>
          </div>
        )}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={t('settings.account.title')}>
      <div className="px-4 py-3.5">
        <p className={`text-caption leading-[17px] ${TONE_CLASS[summary.tone]}`}>{summary.line}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            isDisabled={busy || !canSignIn(status)}
            onPress={onSignIn}
            className="h-8 rounded-[10px] px-3.5 text-caption font-medium"
          >
            {t('settings.account.signIn')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onPress={() => setShowPaste((open) => !open)}
            className="h-8 rounded-[10px] px-3 text-caption font-medium text-muted"
          >
            {showPaste ? t('settings.account.hideCode') : t('settings.account.pasteInstead')}
          </Button>
        </div>

        {problem === null ? null : (
          <Alert status="danger" role="alert" className="mt-2.5">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{problem}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        {showPaste ? (
          <div className="mt-3">
            {/* Said plainly, because someone only reaches this field after the
                browser failed to hand back — and the reason it failed is almost
                always that the OS has no handler for a custom scheme, which is
                not something they did wrong. */}
            <p className="mb-2 text-caption leading-[17px] text-muted">
              {t('settings.account.pasteHint')}
            </p>
            <div className="flex items-center gap-2">
              <Input
                id="settings-auth-code"
                variant="secondary"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={t('settings.account.codePlaceholder')}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="w-full"
                aria-label={t('settings.account.codeLabel')}
              />
              <Button
                variant="tertiary"
                size="sm"
                isDisabled={busy || pasted === null}
                onPress={() => {
                  if (pasted === null) return;
                  setCode('');
                  onPasteCode(pasted);
                }}
                className="h-9 shrink-0 rounded-[10px] px-3.5 text-caption font-medium"
              >
                {t('settings.account.useCode')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
