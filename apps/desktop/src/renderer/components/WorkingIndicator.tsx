import { useEffect, useState } from 'react';
import type { BotStatus } from '@crewaid/shared';
import { BotAvatar, type AvatarBot } from './BotAvatar';
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

export function WorkingIndicator({
  bot,
  startedAt,
  status,
}: {
  bot: AvatarBot;
  startedAt: number;
  status?: BotStatus | undefined;
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
        {t('working.for', { phase: phaseOf(status), elapsed: formatElapsed(elapsed) })}
      </TextShimmer>
    </div>
  );
}
