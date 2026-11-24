import type { Bot, ProviderExplanation } from '@crewaid/shared';
import { Alert, Button, Spinner } from '@heroui/react';
import { IconArrowDown } from '@tabler/icons-react';
import { useT } from '../../i18n/i18n';
import { BotAvatar } from '../BotAvatar';
import { IconButtonTooltip } from '../ui';

/** Centered prompt shown once history has loaded and the thread is empty. */
export function EmptyConversation({ bot }: { bot: Bot }) {
  const t = useT();
  return (
    <div className="crewaid-empty-conversation m-auto flex flex-col items-center gap-4 px-6 py-10 text-center">
      <BotAvatar bot={bot} size="md" />
      <div>
        <h2 className="text-heading font-medium tracking-[-0.01em] text-foreground">
          {t('transcript.empty.title', { bot: bot.name })}
        </h2>
        <p className="mt-1.5 text-footnote text-muted">{t('transcript.empty.hint')}</p>
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
      className="m-auto flex items-center gap-2.5 py-8 text-footnote text-room-muted"
    >
      <Spinner size="sm" aria-hidden="true" />
      <span>{t('transcript.loading')}</span>
    </div>
  );
}

/**
 * Last send or turn failure rendered above the composer. Uses HeroUI Alert so
 * recoverable failures share semantic styling and screen-reader semantics.
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
    <Alert
      status="danger"
      role="alert"
      data-transcript-error
      className="mb-2 rounded-message text-footnote leading-[19px]"
    >
      <Alert.Indicator />
      <Alert.Content className="min-w-0 select-text">
        <Alert.Description className="text-footnote leading-[19px] text-foreground">
          <p>{message}</p>
          {explanation ? (
            <p data-provider-explanation className="mt-1 text-muted [overflow-wrap:anywhere]">
              {t('transcript.providerSays', { source: explanation.source, text: explanation.text })}
            </p>
          ) : null}
        </Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

/** Muted note placed under a reply that stopped before normal completion. */
export function IncompleteNote({ text }: { text: string }) {
  return (
    <div data-incomplete-reason className="px-2 text-micro italic text-muted">
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
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
      <IconButtonTooltip
        variant="secondary"
        size="sm"
        data-transcript-jump
        label={t('transcript.jump')}
        placement="top"
        onPress={onClick}
        className="pointer-events-auto size-8 min-w-8 rounded-full border border-border bg-surface text-foreground shadow-overlay"
      >
        <IconArrowDown aria-hidden="true" className="size-4" stroke={1.8} />
      </IconButtonTooltip>
    </div>
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
        className="pointer-events-auto flex items-center gap-2 rounded-full border border-glass-border bg-glass-strong px-4 py-2 text-caption text-room-muted shadow-surface backdrop-blur-xl"
      >
        {loading ? (
          <>
            <Spinner size="sm" aria-hidden="true" />
            <span>{t('transcript.loadingOlder')}</span>
          </>
        ) : (
          <>
            <span>{error}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 rounded-md px-1.5 text-caption font-medium text-room-foreground underline underline-offset-2"
              onPress={onRetry}
            >
              {t('transcript.retry')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
