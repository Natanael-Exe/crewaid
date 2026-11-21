import { Button } from '@heroui/react';
import { IconPencil } from '@tabler/icons-react';
import { useState } from 'react';
import { isWelcomeLine, welcomeCopy, type WelcomeCopyData } from '@crewaid/shared';
import { MascotFace, type AvatarBot } from '../components/BotAvatar';
import { textOfPart } from '../state/transcriptRows';
import type { TranscriptMessage } from '../state/viewTypes';
import { t, useLocale, useT } from '../i18n/i18n';

/**
 * Crewaid's welcome is a conversation. Its words are stored messages
 * in Crewaid's thread, so what lives here is only what sits around them: the
 * opening at the top of the thread, the replies the person can tap, and the
 * starting points under Crewaid's question.
 */

/** One example each for the founders, agencies and creators the welcome is written for. */
export function exampleTasks(): readonly string[] {
  return [
    t('experience.welcome.exampleResearchCompetitors'),
    t('experience.welcome.exampleClientUpdate'),
    t('experience.welcome.exampleLinkedInPost'),
  ];
}

export type WelcomeReplyChoice = keyof WelcomeCopyData['replies'];

export type WelcomeOffer =
  | { readonly kind: 'replies'; readonly replies: readonly WelcomeReplyChoice[] }
  | { readonly kind: 'starting-points' };

function textOf(message: TranscriptMessage): string {
  return message.parts.map(textOfPart).join('');
}

/**
 * What the welcome offers under the newest message, read from what the
 * thread already says rather than from state of its own, so a reload, a
 * second window or a retried click all agree. While the welcome is open the
 * person can still reply; once Crewaid has asked for the task, the starting
 * points stay until anything else is said.
 */
export function welcomeOffer(
  welcoming: boolean,
  messages: readonly TranscriptMessage[],
): WelcomeOffer | null {
  const last = messages.at(-1);
  if (last === undefined || last.live === true || last.author !== 'BOT') return null;
  if (welcoming) {
    const toured = messages.some(
      (message) => message.author === 'BOT' && isWelcomeLine('guide', textOf(message)),
    );
    return { kind: 'replies', replies: toured ? ['TASK', 'CREW'] : ['TASK', 'CREW', 'TOUR'] };
  }
  return isWelcomeLine('taskQuestion', textOf(last)) ? { kind: 'starting-points' } : null;
}

/**
 * The top of Crewaid's thread. While the welcome is open its mascot, in the
 * shape and colour the person gave it, waves hello.
 */
export function WelcomeOpening({ bot, greeting }: { bot: AvatarBot; greeting: boolean }) {
  const t = useT();
  return (
    <div
      data-welcome-opening
      className="flex flex-col items-center gap-1.5 px-6 pt-7 pb-5 text-center"
    >
      <div aria-hidden className="crewaid-welcome-mascot">
        <MascotFace
          name={bot.name}
          color={bot.avatarColor}
          shape={bot.avatarShape}
          activity={greeting ? 'greeting' : 'idle'}
        />
      </div>
      <h2 className="crewaid-welcome-title pt-2">{t('experience.welcome.welcome')}</h2>
      <p className="max-w-[380px] text-[14px] leading-[22px] text-room-muted">
        {t('experience.welcome.everyTaskCrewAndResult')}
      </p>
    </div>
  );
}

/** The person's possible answers, on their side of the conversation. */
export function WelcomeReplies({
  replies,
  onReply,
}: {
  replies: readonly WelcomeReplyChoice[];
  onReply: (reply: WelcomeReplyChoice) => Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex flex-col items-end gap-2 pt-2">
      <div
        role="group"
        aria-label={t('experience.welcome.replies')}
        className="flex flex-wrap items-center justify-end gap-2"
      >
        {replies.map((reply) => (
          <Button
            key={reply}
            variant="secondary"
            isDisabled={busy}
            className="crewaid-welcome-choice"
            onPress={() => {
              setBusy(true);
              setFailed(false);
              onReply(reply)
                .catch(() => setFailed(true))
                .finally(() => setBusy(false));
            }}
          >
            {welcomeCopy(locale).replies[reply]}
          </Button>
        ))}
      </div>
      {failed ? (
        <p role="alert" className="text-[13px] text-danger">
          {t('experience.welcome.thatDidnTGoThrough')}
        </p>
      ) : null}
    </div>
  );
}

/** Under Crewaid's question: examples that fill the composer to be edited, never sent. */
export function StartingPoints({ onCompose }: { onCompose: (text: string) => void }) {
  const t = useT();
  return (
    <div
      role="group"
      aria-label={t('experience.welcome.startingPoints')}
      className="flex flex-col items-end gap-2 pt-2"
    >
      {exampleTasks().map((task) => (
        <Button
          key={task}
          variant="secondary"
          className="crewaid-welcome-choice gap-2"
          onPress={() => onCompose(task)}
        >
          <IconPencil aria-hidden className="size-3.5 shrink-0 text-room-muted" stroke={1.8} />
          {task}
        </Button>
      ))}
    </div>
  );
}
