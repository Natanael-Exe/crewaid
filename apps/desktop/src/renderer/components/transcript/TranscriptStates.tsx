import type { Bot, ProviderExplanation } from '@crewaid/shared';
import { Spinner } from '@heroui/react';
import { IconAlertCircle, IconArrowDown } from '@tabler/icons-react';
import { useT } from '../../i18n/i18n';
import { BotAvatar } from '../BotAvatar';

/** Centered prompt shown once history has loaded and the thread is empty. */
export function EmptyConversation({ bot }: { bot: Bot }) {
  const t = useT();
  return (
    <div className="crewaid-empty-conversation m-auto flex flex-col items-center gap-4 px-6 py-10 text-center">
      <BotAvatar bot={bot} size="md" />
      <div>
        <h2 className="text-[20px] font-medium tracking-[-0.01em] text-foreground">
          {t('transcript.empty.title', { bot: bot.name })}
        </h2>
        <p className="mt-1.5 text-[13px] text-muted">{t('transcript.empty.hint')}</p>
      </div>
    </div>
  );
}

export function ConversationLoading() {
  const t = useT();
  return (
    <div
      data-transcript-loading
      role="status"
      className="m-auto flex items-center gap-2.5 py-8 text-[13px] text-room-muted"
    >
      <Spinner size="sm" aria-hidden="true" />
      <span>{t('transcript.loading')}</span>
    </div>
  );
}

/**
 * Last send or turn failure rendered above the composer. Keeps the normalized
 * summary in ordinary foreground text so recoverable errors do not read like crashes.
 */
export function ErrorBanner({
  message,
  explanation,
}: {
  message: string;
  explanation?: ProviderExplanation | undefined;
}) {
  const t = useT();
  return (
    <div
      role="status"
      data-transcript-error
      className="mb-2 flex items-start gap-2 rounded-message border border-danger/25 bg-danger/5 px-3.5 py-2.5 text-[13px] leading-[19px] text-foreground"
    >
      <IconAlertCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" stroke={1.8} />
      <div className="min-w-0 select-text">
        <p>{message}</p>
        {explanation ? (
          <p data-provider-explanation className="mt-1 text-muted [overflow-wrap:anywhere]">
            {t('transcript.providerSays', { source: explanation.source, text: explanation.text })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Muted note placed under a reply that stopped before normal completion. */
export function IncompleteNote({ text }: { text: string }) {
  return (
    <div data-incomplete-reason className="px-2 text-[11px] italic text-muted">
      {text}
    </div>
  );
}

/**
 * Floating control to jump back to the newest message. Exported so static-markup
 * tests can assert its accessibility and attributes without scrolling a DOM.
 */
export function JumpToLatestButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      data-transcript-jump
      aria-label={t('transcript.jump')}
      title={t('transcript.jump')}
      onClick={onClick}
      className="absolute inset-x-0 bottom-3 z-10 mx-auto flex size-8 items-center justify-center rounded-full border border-border bg-surface text-foreground shadow-[0_8px_22px_rgba(28,25,23,0.18)] transition-colors hover:bg-background-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <IconArrowDown aria-hidden className="size-4" stroke={1.8} />
    </button>
  );
}

/** Floating status pill at the top of the scroll viewport while paging older history. */
export function OlderHistoryBanner({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
      <div
        data-history-loading={loading ? 'true' : 'false'}
        role="status"
        className="pointer-events-auto flex items-center gap-2 rounded-full border border-room-border bg-room-surface px-4 py-2 text-[12px] text-room-muted shadow-sm backdrop-blur-xl"
      >
        {loading ? (
          <>
            <Spinner size="sm" aria-hidden="true" />
            <span>{t('transcript.loadingOlder')}</span>
          </>
        ) : (
          <>
            <span>{error}</span>
            <button
              type="button"
              className="font-medium text-room-foreground underline underline-offset-2"
              onClick={onRetry}
            >
              {t('transcript.retry')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
