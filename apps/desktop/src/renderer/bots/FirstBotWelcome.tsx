import { Button } from '@heroui/react';
import {
  IconCalendarRepeat,
  IconDeviceDesktop,
  IconPlug,
  IconPlus,
  IconVideo,
  type Icon,
} from '@tabler/icons-react';
import { MascotFace } from '../components/BotAvatar';
import { AVATAR_COLORS } from './botProfileForm';
import { useT, t } from '../i18n/i18n';

/**
 * What the transcript pane shows when the orchestrator answered and there are
 * no bots — in practice, a person's first minute in the app.
 *
 * "No bots yet" was true and useless: it named the state and left the reader
 * to guess what a bot is for. This names what one can do, in the order a
 * person meets it, and puts the one action beside it.
 *
 * Capabilities, never roles. Every line is something any bot can do, with no
 * suggestion of what a bot should BE — that is the operator's to write, and a
 * list of example jobs here would be the app deciding it for them.
 *
 * Every line names something that ships. A welcome that promises a feature the
 * next screen cannot find is worse than the blank pane it replaced.
 */

export const WELCOME_POINTS: readonly {
  readonly icon: Icon;
  readonly title: string;
  readonly body: string;
}[] = [
  {
    icon: IconDeviceDesktop,
    get title() {
      return t('bots.firstBotWelcome.itsOwnComputer');
    },
    get body() {
      return t('bots.firstBotWelcome.eachBotWorksOnA');
    },
  },
  {
    icon: IconVideo,
    get title() {
      return t('bots.firstBotWelcome.learnsByWatchingYou');
    },
    get body() {
      return t('bots.firstBotWelcome.doATaskOnceWhile');
    },
  },
  {
    icon: IconPlug,
    get title() {
      return t('bots.firstBotWelcome.connectsToYourTools');
    },
    get body() {
      return t('bots.firstBotWelcome.pluginsGiveItAccessTo');
    },
  },
  {
    icon: IconCalendarRepeat,
    get title() {
      return t('bots.firstBotWelcome.worksOnASchedule');
    },
    get body() {
      return t('bots.firstBotWelcome.routinesLetItCheckReport');
    },
  },
];

export function FirstBotWelcome({ onCreateBot }: { onCreateBot: () => void }) {
  const t = useT();
  return (
    <div className="crewaid-first-bot flex h-full overflow-y-auto px-8 py-10">
      <div className="crewaid-welcome-card m-auto flex w-full max-w-[600px] flex-col">
        <WelcomeCrew />

        <h1 className="mt-6 text-[20px] font-semibold tracking-[-0.01em] text-foreground">
          {t('bots.firstBotWelcome.createYourFirstBot')}
        </h1>
        <p className="mt-1.5 text-[13px] leading-5 text-muted">
          {t('bots.firstBotWelcome.aBotIsAnAi')}
        </p>

        <ul className="mt-6 flex flex-col gap-4">
          {WELCOME_POINTS.map(({ icon: PointIcon, title, body }) => (
            <li key={title} className="flex gap-3">
              <span
                aria-hidden
                className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-surface"
              >
                <PointIcon className="size-4 text-foreground" stroke={1.8} />
              </span>
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-foreground">{title}</div>
                <div className="text-[12.5px] leading-[18px] text-muted">{body}</div>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-7 flex items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            onPress={onCreateBot}
            className="h-9 rounded-[10px] px-4 text-[13px] font-medium"
          >
            <IconPlus className="size-4" stroke={2} />
            {t('bots.firstBotWelcome.createABot')}
          </Button>
          <span className="text-[12px] text-foreground-faint">
            {t('bots.firstBotWelcome.orPressN')}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Three mascots, one of them busy — the product in one picture: several
 * separate creatures, each doing its own thing. Drawn with the same face the
 * sidebar will show once a real bot exists, so the first bot looks like it
 * belongs to the illustration that introduced it. Also heads the plan screen
 * before it, so the two first screens read as one introduction.
 */
export function WelcomeCrew() {
  return (
    <div aria-hidden className="flex items-end">
      <span className="size-12">
        <MascotFace name="Welcome Wren" color={AVATAR_COLORS[6]} shape="egg" />
      </span>
      <span className="-mx-0.5 size-[72px]">
        <MascotFace
          name="Welcome Ada"
          color={AVATAR_COLORS[4]}
          shape="circle"
          activity="acting"
          detail
        />
      </span>
      <span className="size-12">
        <MascotFace name="Welcome Juno" color={AVATAR_COLORS[0]} shape="cloud" />
      </span>
    </div>
  );
}
