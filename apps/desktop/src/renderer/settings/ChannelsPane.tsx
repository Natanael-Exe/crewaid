import { Button } from '@heroui/react';
import { IconBrandTelegram, IconCheck } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { encode } from 'uqr';
import {
  formatTelegramPairingCode,
  type TelegramBotRegistered,
  type TelegramLinkResponse,
  type TelegramStatus,
} from '@crewaid/shared';
import {
  confirmTelegram,
  connectTelegram,
  disconnectTelegram,
  failureOf,
  registerTelegramBot,
  telegramStatus,
  useApiClient,
} from '../api';
import { systemBrowser } from '../bridge';
import { SETTINGS_INPUT_CLASS, SettingsRow, SettingsSection } from './SettingsLayout';
import { useT } from '../i18n/i18n';

/** The product's name, and the shape of a bot token; neither is a word to translate. */
const TELEGRAM = 'Telegram';
const TOKEN_EXAMPLE = '123456789:AA…';

/** `t.me/{bot}?start={code}`: opening it presses Start with the code already in it. */
const openBotUrl = (botUsername: string, code: string): string =>
  `https://t.me/${botUsername}?start=${code}`;

export function ChannelsPane() {
  const t = useT();
  const client = useApiClient();
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [link, setLink] = useState<TelegramLinkResponse | null>(null);
  const [registered, setRegistered] = useState<TelegramBotRegistered | null>(null);
  const [tokenForm, setTokenForm] = useState(false);
  const [busy, setBusy] = useState(false);
  // A poll answers only for its own failure: clearing an action's error on the
  // next successful status read would hide it seconds after it appeared.
  const [checkProblem, setCheckProblem] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const waiting = Boolean(link ?? registered ?? status?.pending);
  const codeExpiresAt = (registered ?? link)?.expiresAt.getTime() ?? null;

  useEffect(() => {
    const abort = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const next = await telegramStatus(client, abort.signal);
        if (abort.signal.aborted) return;
        setStatus(next);
        if (next.connection) {
          setLink(null);
          setRegistered(null);
          setTokenForm(false);
        }
        setCheckProblem(null);
      } catch {
        if (!abort.signal.aborted) setCheckProblem(t('channels.checkFailed'));
      } finally {
        loading = false;
      }
    };
    void refresh();
    // Fast while a bot is on its way, so the Confirm appears soon after the code is sent.
    const timer = setInterval(
      () => {
        void refresh();
      },
      waiting ? 2500 : 15_000,
    );
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [client, waiting]);

  // A code past its ten minutes can no longer claim anything, so it leaves the screen.
  useEffect(() => {
    if (codeExpiresAt === null) return;
    const expiry = setTimeout(
      () => {
        setLink(null);
        setRegistered(null);
        if (!statusRef.current?.pending?.telegramName) setProblem(t('channels.codeExpired'));
      },
      Math.max(0, codeExpiresAt - Date.now()),
    );
    return () => clearTimeout(expiry);
  }, [codeExpiresAt]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  const openExternal = (url: string) => {
    void systemBrowser.open(url).then((result) => {
      if (result.status !== 'opened') setProblem(t('channels.openFailed'));
    });
  };
  const requestCode = () =>
    run(async () => {
      try {
        setLink(await connectTelegram(client));
        setTokenForm(false);
      } catch {
        setProblem(t('channels.startFailed'));
      }
    });
  const connect = () => {
    // Without a manager bot there is no QR code: the person brings a bot from @BotFather.
    if (status?.canCreateBots) void requestCode();
    else {
      setProblem(null);
      setTokenForm(true);
    }
  };
  const submitToken = (token: string) =>
    run(async () => {
      try {
        const next = await registerTelegramBot(client, token);
        setRegistered(next);
        setLink(null);
        setTokenForm(false);
        setStatus((previous) =>
          previous
            ? {
                ...previous,
                pending: {
                  botUsername: next.botUsername,
                  telegramName: null,
                  expiresAt: next.expiresAt,
                },
              }
            : previous,
        );
        openExternal(next.openUrl);
      } catch (error) {
        const { code } = failureOf(error);
        setProblem(
          code === 'INVALID_REQUEST'
            ? t('channels.token.rejected')
            : code === 'CONFLICT'
              ? t('channels.token.conflict')
              : t('channels.token.unreachable'),
        );
      }
    });
  const confirm = () =>
    run(async () => {
      try {
        await confirmTelegram(client);
        setLink(null);
        setRegistered(null);
        setStatus(await telegramStatus(client));
      } catch (error) {
        setProblem(
          failureOf(error).code === 'NOT_FOUND'
            ? t('channels.confirm.gone')
            : t('channels.confirm.failed'),
        );
      }
    });
  const disconnect = (failure: string) =>
    run(async () => {
      try {
        await disconnectTelegram(client);
        setLink(null);
        setRegistered(null);
        setTokenForm(false);
        setStatus((previous) =>
          previous ? { ...previous, connection: null, pending: null } : previous,
        );
      } catch {
        setProblem(failure);
      }
    });
  return (
    <TelegramChannelView
      status={status}
      link={link}
      registered={registered}
      tokenForm={tokenForm}
      busy={busy}
      problem={problem ?? checkProblem}
      onConnect={connect}
      onNewCode={() => {
        void requestCode();
      }}
      onShowTokenForm={(open) => {
        setProblem(null);
        setTokenForm(open);
      }}
      onSubmitToken={(token) => {
        void submitToken(token);
      }}
      onOpen={openExternal}
      onConfirm={() => {
        void confirm();
      }}
      onCancel={() => {
        setProblem(null);
        // Nothing reached the server yet: closing the form is all Cancel means.
        if (!link && !registered && !status?.pending) setTokenForm(false);
        else void disconnect(t('channels.cancel.failed'));
      }}
      onDisconnect={() => {
        void disconnect(t('channels.disconnect.failed'));
      }}
    />
  );
}

export function TelegramChannelView({
  status,
  link,
  registered,
  tokenForm,
  busy,
  problem,
  onConnect,
  onNewCode,
  onShowTokenForm,
  onSubmitToken,
  onOpen,
  onConfirm,
  onCancel,
  onDisconnect,
}: {
  status: TelegramStatus | null;
  link: TelegramLinkResponse | null;
  registered: TelegramBotRegistered | null;
  tokenForm: boolean;
  busy: boolean;
  problem: string | null;
  onConnect: () => void;
  onNewCode: () => void;
  onShowTokenForm: (open: boolean) => void;
  onSubmitToken: (token: string) => void;
  onOpen: (url: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onDisconnect: () => void;
}) {
  const t = useT();
  const connection = status?.connection ?? null;
  const pending = status?.pending ?? null;
  const claimed = pending?.telegramName ? { ...pending, telegramName: pending.telegramName } : null;
  // A bot pasted from @BotFather belongs to this account before its code arrives.
  const pastedBot = pending?.botUsername ?? registered?.botUsername ?? null;
  const code = registered?.code ?? link?.code ?? null;
  const qrUrl =
    !connection && !claimed && !pastedBot && !tokenForm ? (link?.createUrl ?? null) : null;
  const idle = !connection && !claimed && !pastedBot && !tokenForm && !qrUrl;
  const cancel = (
    <Button size="sm" variant="ghost" isDisabled={busy} onPress={onCancel}>
      {t('settings.cancel')}
    </Button>
  );
  return (
    <div>
      <SettingsSection title={t('channels.title')}>
        <SettingsRow
          label={
            <span className="flex items-center gap-2">
              <IconBrandTelegram className="size-5 text-accent" />
              {TELEGRAM}
            </span>
          }
          description={t('channels.telegram.description')}
          control={
            connection ? (
              <Button size="sm" variant="secondary" isDisabled={busy} onPress={onDisconnect}>
                {t('channels.disconnect')}
              </Button>
            ) : idle ? (
              <Button
                size="sm"
                variant="primary"
                isDisabled={busy || !status?.configured}
                onPress={onConnect}
              >
                {busy ? t('channels.connecting') : t('channels.connect')}
              </Button>
            ) : undefined
          }
        />
        {!status && !problem ? <SettingsRow label={t('channels.checking')} /> : null}
        {status && !status.configured ? (
          <SettingsRow label={t('channels.disabled')} description={t('channels.disabled.hint')} />
        ) : null}
        {connection ? (
          <SettingsRow
            label={t('channels.connectedTo', { bot: connection.botUsername })}
            description={
              <span className="flex items-center gap-1.5">
                <IconCheck className="size-3.5" />
                {connection.displayName}
              </span>
            }
          />
        ) : claimed ? (
          <SettingsRow
            label={t('channels.claimed')}
            description={t('channels.claimed.hint', {
              name: claimed.telegramName,
              bot: claimed.botUsername,
            })}
            control={
              <div className="flex gap-2">
                <Button size="sm" variant="primary" isDisabled={busy} onPress={onConfirm}>
                  {t('channels.confirm')}
                </Button>
                {cancel}
              </div>
            }
            stacked
          />
        ) : pastedBot ? (
          <SettingsRow
            label={t('channels.sendCode', { bot: pastedBot })}
            description={
              code ? (
                <>
                  {t('channels.sendCode.hint')} <PairingCode code={code} />
                </>
              ) : (
                t('channels.sendCode.newCodeHint')
              )
            }
            control={
              <div className="flex gap-2">
                {code ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => onOpen(registered?.openUrl ?? openBotUrl(pastedBot, code))}
                  >
                    {t('channels.openBot', { bot: pastedBot })}
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" isDisabled={busy} onPress={onNewCode}>
                    {t('channels.newCode')}
                  </Button>
                )}
                {cancel}
              </div>
            }
            stacked
          />
        ) : tokenForm ? (
          <SettingsRow
            label={t('channels.ownBot')}
            htmlFor="telegram-bot-token"
            description={t('channels.ownBot.hint')}
            control={<TokenForm busy={busy} onSubmit={onSubmitToken} onCancel={onCancel} />}
            stacked
          />
        ) : link && qrUrl ? (
          <SettingsRow
            label={t('channels.create')}
            description={
              <div className="mt-2 flex flex-wrap items-start gap-4">
                <TelegramQr value={qrUrl} />
                <ol className="min-w-[220px] flex-1 list-decimal space-y-1.5 ps-4">
                  <li>{t('channels.create.scan')}</li>
                  <li>{t('channels.create.name')}</li>
                  <li>
                    {t('channels.create.start')} <PairingCode code={link.code} />
                  </li>
                </ol>
              </div>
            }
            control={
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onPress={() => onOpen(qrUrl)}>
                  {t('channels.openHere')}
                </Button>
                <Button size="sm" variant="ghost" onPress={() => onShowTokenForm(true)}>
                  {t('channels.useExisting')}
                </Button>
                {cancel}
              </div>
            }
            stacked
          />
        ) : null}
      </SettingsSection>
      {problem ? (
        <p role="alert" className="mb-4 text-[13px] text-danger">
          {problem}
        </p>
      ) : null}
      {connection ? (
        <p className="px-1 text-[12px] leading-relaxed text-muted">{t('channels.commands')}</p>
      ) : null}
      <p className="mt-4 px-1 text-[12px] leading-relaxed text-muted">{t('channels.privacy')}</p>
    </div>
  );
}

function PairingCode({ code }: { code: string }) {
  const t = useT();
  return (
    <span
      aria-label={t('channels.pairingCode')}
      className="ms-1 inline-block rounded-[8px] border border-field-border bg-field px-2 py-0.5 font-mono text-[15px] font-semibold tracking-[0.12em] text-foreground"
    >
      {formatTelegramPairingCode(code)}
    </span>
  );
}

/** Cleared as soon as it is sent: the token is the bot, and it shouldn't sit in a field. */
function TokenForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (token: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [token, setToken] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = token.trim();
    if (!value) return;
    setToken('');
    onSubmit(value);
  };
  return (
    <form onSubmit={submit}>
      <input
        id="telegram-bot-token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={TOKEN_EXAMPLE}
        value={token}
        onChange={(event) => setToken(event.target.value)}
        className={SETTINGS_INPUT_CLASS}
      />
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="primary" type="submit" isDisabled={busy || !token.trim()}>
          {busy ? t('channels.connecting') : t('channels.connectBot')}
        </Button>
        <Button size="sm" variant="ghost" isDisabled={busy} onPress={onCancel}>
          {t('channels.back')}
        </Button>
      </div>
    </form>
  );
}

/** Drawn from the matrix, black on a white tile in either theme, so any camera reads it. */
function TelegramQr({ value }: { value: string }) {
  const t = useT();
  const { size, path } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: 2 });
    let d = '';
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { size: qr.size, path: d };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={t('channels.qr')}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-40 shrink-0 rounded-[10px]"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
