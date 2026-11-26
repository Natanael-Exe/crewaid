import { useEffect, useState } from 'react';
import type { BotStatus, ToolInfo } from '@crewaid/shared';
import type { TranscriptMessage } from '../state/viewTypes';
import type { CodingTaskProgress } from '../chat/codingProgress';
import { BotAvatar, type AvatarBot } from './BotAvatar';
import { partField } from './PartRenderer';
import { isFoldedToolPart, type FoldedToolPart } from './tools/toolParts';
import { codingStepAction, readableName } from './tools/toolPresentation';
import { TextShimmer } from './ui';
import { t, useT } from '../i18n/i18n';

/**
 * "it is working", while nothing has arrived to prove it.
 *
 * The gap this fills was the whole of the operator's experience of a slow
 * turn: a message goes, the composer empties, and NOTHING appears until the
 * model's first token — which behind a tool call, on a reasoning model, is
 * tens of seconds. The transcript can only render what has arrived, so this
 * is the one row that is not made of content.
 *
 * It says how LONG, and that is the point rather than decoration: three
 * seconds and three minutes feel completely different, and only one of them
 * is a reason to wonder whether something is broken. (Codex and Zed both
 * settled on the same shape — "Working for 1s" — and it is the elapsed number
 * that does the work.)
 *
 * The clock is the client's. It measures the operator's wait, which is the
 * question being answered, and it starts the instant a send lands rather than
 * when a round trip says so.
 *
 * The marker is the BOT, not a spinner. The mascot already animates
 * what it is doing — eyes scanning and a work ring while a tool runs,
 * eyes up and thought rising while the model has the turn — and this row sits
 * exactly where the reply is about to appear, in the bot's own lane. A
 * generic spinner beside it would be a second, worse answer to the same
 * question, and the sidebar is not where anybody is looking while they wait.
 */

/** What the bot is doing, in the operator's words rather than the enum's. */
function phaseOf(status: BotStatus | undefined): string {
  switch (status) {
    case 'ACTING':
      return t('working.working');
    case 'THINKING':
      return t('working.thinking');
    default:
      // Before the first status frame arrives — which is most of the gap this
      // component exists for — the honest word is the general one.
      return t('working.working');
  }
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t('working.seconds', { s: seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0
    ? t('working.minutes', { m: minutes })
    : t('working.minutesSeconds', { m: minutes, s: rest });
}

/**
 * Ticks once a second while mounted.
 *
 * Mounted ONLY while a turn is in flight, so there is no interval running in
 * an idle window — the cheapest way to hold that guarantee is to let the
 * parent unmount this rather than to guard a long-lived timer.
 */
function useElapsed(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Immediately, then every second: a component that mounts at 999ms into a
    // turn would otherwise show 0s for a whole second.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return Math.max(0, now - startedAt);
}

/** Maps an active tool name to a concise, trusted operator-facing status label. */
export function statusLabelForTool(toolName: string, tools?: readonly ToolInfo[]): string {
  const separator = toolName.indexOf('__');
  if (separator > 0) {
    return t('working.usingTool', { source: readableName(toolName.slice(0, separator)) });
  }
  switch (toolName) {
    case 'fs_read':
    case 'fs_grep':
    case 'fs_glob':
    case 'memory_read':
    case 'memory_search':
      return t('working.reviewingFiles');
    case 'fs_write':
    case 'fs_edit':
    case 'attach_file':
      return t('working.preparingFiles');
    case 'board_read':
      return t('working.checkingBoard');
    case 'board_add':
    case 'board_update':
      return t('working.updatingBoard');
    case 'shell':
    case 'process_start':
    case 'process_output':
    case 'process_stop':
      return t('working.runningCommand');
    case 'code_task':
      return t('working.coding');
    case 'local_code_task':
      return t('working.localCoding');
    case 'list_local_connectors':
      return t('working.checkingLocalConnectors');
    case 'send_message':
      return t('working.messagingTeam');
    case 'present_visual':
      return t('working.preparingSummary');
    default: {
      if (
        toolName.startsWith('browser_') ||
        toolName === 'capture_screen' ||
        toolName === 'screenshot'
      ) {
        return t('working.checkingPage');
      }
      if (/^(task|goal|deliverable)_/.test(toolName)) {
        return t('working.updatingWork');
      }
      const info = tools?.find((tool) => tool.name === toolName);
      return info?.label ?? t('working.working');
    }
  }
}

/**
 * Derives a short, trusted status phrase from the currently executing tool call
 * in the live turn, falling back to the bot's coarse status when no tool is
 * active. Raw pre-tool prose is never used as the live status label.
 */
export function liveWorkPhase(
  messages: readonly TranscriptMessage[],
  status: BotStatus | undefined,
  tools?: readonly ToolInfo[],
  codingProgress?: ReadonlyMap<string, CodingTaskProgress>,
): string {
  const latest = messages.at(-1);
  if (latest?.live === true) {
    const calls: FoldedToolPart[] = [];
    for (const part of latest.parts) {
      if (part.type === 'tool-activity') {
        const inner = partField(part, 'calls');
        if (Array.isArray(inner)) calls.push(...inner.filter(isFoldedToolPart));
      } else if (isFoldedToolPart(part)) {
        calls.push(part);
      }
    }
    const running = [...calls].reverse().find((call) => call.status === 'running');
    if (running !== undefined) {
      if (running.toolName === 'code_task' || running.toolName === 'local_code_task') {
        const progress = codingProgress?.get(running.toolCallId);
        if (progress?.kind === 'waiting_local_permission') {
          return progress.connectorName !== undefined && progress.connectorName !== ''
            ? t('working.waitingLocalPermission', { connector: progress.connectorName })
            : t('working.waitingLocalPermissionGeneric');
        }
        const action = progress?.kind === 'step' ? codingStepAction(progress) : undefined;
        if (progress !== undefined && action !== undefined) {
          return progress.maxSteps > 0
            ? t('working.codingStep', {
                step: progress.step,
                max: progress.maxSteps,
                action,
              })
            : t('working.localCodingStep', {
                step: progress.step,
                action,
              });
        }
      }
      return statusLabelForTool(running.toolName, tools);
    }
    if (status === 'ACTING' && calls.length > 0) {
      const lastCall = calls.at(-1);
      if (lastCall !== undefined) return statusLabelForTool(lastCall.toolName, tools);
    }
  }
  return phaseOf(status);
}

export function WorkingIndicator({
  bot,
  startedAt,
  status,
  phase,
}: {
  bot: AvatarBot;
  startedAt: number;
  status?: BotStatus | undefined;
  /** Optional trusted live status label derived from the active tool. */
  phase?: string | undefined;
}) {
  const t = useT();
  const elapsed = useElapsed(startedAt);
  return (
    <div
      role="status"
      data-working-indicator
      className="flex items-center gap-2.5 px-1 py-1.5 text-caption text-muted"
    >
      {/* `detail` forced on: this avatar is alone on its line with nothing to
          collide with, so it gets the work ring and the thought dots that a
          32px row avatar cannot afford. */}
      <span className="block size-8 shrink-0">
        <BotAvatar bot={bot} size="xs" status={status ?? 'THINKING'} detail />
      </span>
      <TextShimmer className="tabular-nums">
        {t('working.for', { phase: phase ?? phaseOf(status), elapsed: formatElapsed(elapsed) })}
      </TextShimmer>
    </div>
  );
}
