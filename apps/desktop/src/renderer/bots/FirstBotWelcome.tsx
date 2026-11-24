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
import { ItemCard, ItemCardGroup } from '../components/ui';
import { AVATAR_COLORS } from './botProfileForm';
import { useT, t } from '../i18n/i18n';

/**
 * What the transcript pane shows when the orchestrator answered and there are
 * no bots — in practice, a person's first minute in the app.
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

        <h1 className="mt-6 text-heading font-semibold tracking-[-0.01em] text-foreground">
          {t('bots.firstBotWelcome.createYourFirstBot')}
        </h1>
        <p className="mt-1.5 text-footnote leading-5 text-muted">
          {t('bots.firstBotWelcome.aBotIsAnAi')}
        </p>

        <ItemCardGroup.Root layout="grid" columns={2} variant="transparent" className="mt-6 gap-3">
          {WELCOME_POINTS.map(({ icon: PointIcon, title, body }) => (
            <ItemCard.Root
              key={title}
              variant="outline"
              className="items-start gap-3 rounded-card p-3.5"
            >
              <ItemCard.Icon
                aria-hidden
                className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-border bg-surface text-foreground"
              >
                <PointIcon className="size-4" stroke={1.8} />
              </ItemCard.Icon>
              <ItemCard.Content>
                <ItemCard.Title>{title}</ItemCard.Title>
                <ItemCard.Description className="line-clamp-3 leading-[18px]">
                  {body}
                </ItemCard.Description>
              </ItemCard.Content>
            </ItemCard.Root>
          ))}
        </ItemCardGroup.Root>

        <div className="mt-7 flex items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            onPress={onCreateBot}
            className="h-9 rounded-[10px] px-4 text-footnote font-medium"
          >
            <IconPlus className="size-4" stroke={2} />
            {t('bots.firstBotWelcome.createABot')}
          </Button>
          <span className="text-caption text-foreground-faint">
            {t('bots.firstBotWelcome.orPressN')}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Three mascots, one of them busy — the product in one picture.
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
