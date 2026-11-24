import { useEffect, useRef, useState } from 'react';
import { Button, Popover, Spinner, Tooltip } from '@heroui/react';
import type { Edition } from '@crewaid/shared';
import {
  IconMicrophone,
  IconMicrophoneOff,
  IconPhone,
  IconPhoneOff,
  IconX,
} from '@tabler/icons-react';
import type { PendingApproval } from '../../state/chatReducer';
import type { TranscriptMessage } from '../../state/viewTypes';
import { systemBrowser } from '../../bridge';
import { formatClipTime } from '../../voice/recorder';
import type { BotCall } from '../../voice/useBotCall';
import { liveBotProgress } from '../../voice/callProgress';
import { IconButtonTooltip } from '../ui';
import { useT } from '../../i18n/i18n';

/** Where "Learn about Cloud" leads: the plans on the public site. */
export const CLOUD_PLANS_URL = 'https://crewaid.io/#pricing';

/**
 * What pressing Call does for this account. `pro` explains that Starter plans
 * do not include call minutes; when calls are absent (including self-hosted
 * servers, which have no hosted call relay), the button is hidden.
 */
export type CallOffer = 'call' | 'pro' | 'cloud' | 'none';

export function callOffer(
  availability: BotCall['availability'],
  _edition: Edition | null,
): CallOffer {
  if (availability.kind === 'absent') return 'none';
  return availability.allowance.limitSeconds === 0 ? 'pro' : 'call';
}

/**
 * calling the bot the rail shows. It heads the rail, named for the bot,
 * and is the collapsed rail's only control besides expanding it (`iconOnly`).
 * Absent where calls cannot reach this account at all: a cloud server without
 * a voice agent.
 */
export function CallButton({
  call,
  botName,
  edition,
  onOpenPlan,
  iconOnly = false,
}: {
  call: BotCall;
  botName: string | null;
  edition: Edition | null;
  onOpenPlan: () => void;
  iconOnly?: boolean;
}) {
  const t = useT();
  const [explaining, setExplaining] = useState(false);
  const offer = callOffer(call.availability, edition);
  if (offer === 'none') return null;
  const inCall = call.snapshot.phase !== 'idle';
  const allowance = call.availability.kind === 'available' ? call.availability.allowance : null;
  const spent =
    allowance !== null &&
    allowance.limitSeconds !== null &&
    allowance.limitSeconds > 0 &&
    allowance.usedSeconds >= allowance.limitSeconds;
  const left =
    allowance?.limitSeconds == null
      ? null
      : Math.max(0, allowance.limitSeconds - allowance.usedSeconds);
  const name = botName ?? t('call.aBot');
  const label = inCall ? t('call.hangUp') : t('call.call', { name });
  const button = (
    <Button
      variant={inCall ? 'danger' : 'primary'}
      size="sm"
      isIconOnly={iconOnly}
      aria-label={label}
      data-call-button={inCall ? 'in-call' : offer === 'call' ? 'idle' : offer}
      isDisabled={botName === null || (spent && !inCall)}
      onPress={
        offer === 'call' || inCall
          ? () => (inCall ? call.hangUp() : call.start())
          : () => setExplaining(true)
      }
      className={`crewaid-bot-context window-no-drag shrink-0 rounded-full font-medium shadow-sm ${
        iconOnly ? 'size-[34px] min-w-[34px]' : 'h-8 max-w-[220px] gap-1.5 px-3 text-caption'
      }`}
    >
      {inCall ? (
        <IconPhoneOff className="size-4 shrink-0" stroke={1.8} />
      ) : (
        <IconPhone className="size-4 shrink-0" stroke={1.8} />
      )}
      {iconOnly ? null : <span className="truncate">{label}</span>}
    </Button>
  );
  if (offer === 'call' || inCall) {
    return (
      <Tooltip>
        {button}
        <Tooltip.Content>
          {spent && !inCall ? t('call.spent') : label}
          {!inCall && !spent && left !== null
            ? ` · ${t('call.left', { time: formatClipTime(left * 1000) })}`
            : ''}
        </Tooltip.Content>
      </Tooltip>
    );
  }
  const copy =
    offer === 'pro'
      ? {
          title: t('call.pro.title'),
          body: t('call.pro.body', { name }),
          action: t('call.pro.action'),
          act: onOpenPlan,
        }
      : {
          title: t('call.cloud.title'),
          body: t('call.cloud.body', { name }),
          action: t('call.cloud.action'),
          act: () => void systemBrowser.open(CLOUD_PLANS_URL),
        };
  return (
    <Popover isOpen={explaining} onOpenChange={setExplaining}>
      {button}
      <Popover.Content
        placement={iconOnly ? 'start top' : 'bottom start'}
        className="crewaid-bot-context w-[360px] max-w-[calc(100vw-32px)] rounded-[18px]"
      >
        <Popover.Dialog
          aria-label={copy.title}
          data-call-offer={offer}
          className="flex items-start gap-3.5 p-4"
        >
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-soft-foreground"
          >
            <IconPhone className="size-4" stroke={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <Popover.Heading className="text-body leading-[22px] font-semibold">
              {copy.title}
            </Popover.Heading>
            <p className="mt-1 text-callout leading-[21px] text-muted">{copy.body}</p>
            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                className="rounded-full px-4"
                onPress={() => {
                  setExplaining(false);
                  copy.act();
                }}
              >
                {copy.action}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted"
                onPress={() => setExplaining(false)}
              >
                {t('call.notNow')}
              </Button>
            </div>
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

/** Above the composer while a call is on: time, the voice's line, mute, hang up. */
export function CallBar({ call, botName }: { call: BotCall; botName: string }) {
  const t = useT();
  const { snapshot } = call;
  const elapsed = useElapsed(snapshot.connectedAt);
  if (snapshot.phase === 'idle') {
    if (snapshot.error === null) return null;
    return (
      <div
        role="alert"
        className="mx-auto mb-2 flex w-full max-w-[calc(var(--chat-column)+48px)] items-center gap-2 px-(--transcript-gutter) text-caption text-danger"
      >
        <span className="min-w-0 flex-1">{snapshot.error}</span>
        <IconButtonTooltip
          label={t('call.dismiss')}
          placement="top"
          onPress={call.dismissError}
          className="size-5 min-w-5 rounded-full text-muted"
        >
          <IconX className="size-3" stroke={2} />
        </IconButtonTooltip>
      </div>
    );
  }
  const live = snapshot.phase === 'live';
  const left =
    snapshot.maxDurationSeconds === null
      ? null
      : Math.max(0, snapshot.maxDurationSeconds * 1000 - elapsed);
  return (
    <div className="mx-auto mb-2 w-full max-w-[calc(var(--chat-column)+48px)] px-(--transcript-gutter)">
      <div
        data-call-bar={snapshot.phase}
        role="status"
        aria-live="polite"
        className="flex items-center gap-3 rounded-full border border-glass-border bg-glass-strong py-1.5 pe-1.5 ps-4 shadow-surface backdrop-blur-xl"
      >
        {live ? (
          <span
            aria-hidden
            className={`size-2 shrink-0 rounded-full bg-success ${snapshot.speaking ? 'animate-pulse' : ''}`}
          />
        ) : (
          <Spinner size="sm" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-caption">
            <span className="font-medium text-field-foreground">
              {live
                ? t('call.onCall', { name: botName })
                : snapshot.phase === 'ending'
                  ? t('call.hangingUp')
                  : t('call.calling', { name: botName })}
            </span>
            {live ? (
              <span className="tabular-nums text-muted">
                {formatClipTime(elapsed)}
                {left === null ? '' : ` · ${t('call.left', { time: formatClipTime(left) })}`}
              </span>
            ) : null}
          </div>
          <div className="truncate text-caption text-muted">
            {snapshot.waitingOnBot
              ? t('call.working', { name: botName })
              : (snapshot.caption ?? (live ? t('call.listening') : ''))}
          </div>
        </div>
        <IconButtonTooltip
          label={snapshot.muted ? t('call.unmute') : t('call.mute')}
          placement="top"
          aria-pressed={snapshot.muted}
          isDisabled={!live}
          onPress={() => call.setMuted(!snapshot.muted)}
          className="size-8 rounded-full text-muted"
        >
          {snapshot.muted ? (
            <IconMicrophoneOff className="size-4" stroke={1.8} />
          ) : (
            <IconMicrophone className="size-4" stroke={1.8} />
          )}
        </IconButtonTooltip>
        <IconButtonTooltip
          variant="danger"
          label={t('call.hangUp')}
          placement="top"
          isDisabled={snapshot.phase === 'ending'}
          onPress={call.hangUp}
          className="size-8 rounded-full"
        >
          <IconPhoneOff className="size-4" stroke={1.8} />
        </IconButtonTooltip>
      </div>
    </div>
  );
}

/** Milliseconds since `since`, ticking while it is set. */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [since]);
  return since === null ? 0 : Math.max(0, now - since);
}

/**
 * Tells the call what the bot's thread shows: what the bot is visibly doing,
 * and approvals waiting on the person. When a request is answered is the
 * server's to say, so nothing here reads a run's ending. Rendered
 * inside the thread, where these are known; renders nothing.
 */
export function CallBridge({
  call,
  generating,
  messages,
  approvals,
}: {
  call: BotCall;
  generating: boolean;
  messages: readonly TranscriptMessage[];
  approvals: readonly PendingApproval[];
}) {
  const { runProgress, approvalWaiting, approvalsAnswered } = call;
  // Read only while a call waits on the bot: every other render skips it.
  const waiting = call.snapshot.phase === 'live' && call.snapshot.waitingOnBot;
  const progress = waiting && generating ? liveBotProgress(messages) : null;
  useEffect(() => {
    if (waiting) runProgress(progress);
  }, [waiting, progress, runProgress]);

  const told = useRef(new Set<string>());
  const pending = approvals.some((approval) => approval.answered === undefined);
  useEffect(() => {
    for (const approval of approvals) {
      if (approval.answered !== undefined || told.current.has(approval.toolCallId)) continue;
      told.current.add(approval.toolCallId);
      approvalWaiting();
    }
  }, [approvals, approvalWaiting]);
  useEffect(() => {
    if (!pending) approvalsAnswered();
  }, [pending, approvalsAnswered]);
  return null;
}
