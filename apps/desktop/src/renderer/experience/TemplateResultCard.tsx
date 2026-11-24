import { Button } from '@heroui/react';
import { IconArrowRight } from '@tabler/icons-react';
import { TemplateSchema } from '@crewaid/shared';
import { BotAvatar } from '../components/BotAvatar';
import { useExperience } from './ExperienceGate';
import { prefillFrom } from './templateView';
import { useT } from '../i18n/i18n';

/**
 * A `read_template` result, drawn as the recommendation it is. Set up
 * opens the library's review step with the brief Crewaid drafted in the same
 * call, so what the person reviews is what Crewaid proposed.
 */
export function TemplateResultCard({ input, output }: { input?: unknown; output: unknown }) {
  const t = useT();
  const experience = useExperience();
  const parsed = TemplateSchema.safeParse(output);
  if (!parsed.success) return null;
  const entry = parsed.data;
  const crew = entry.kind === 'crew';
  return (
    <div className="crewaid-template-card my-2 flex max-w-[628px] flex-wrap items-center justify-between gap-4 rounded-card px-6 py-5">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-headline font-semibold">{entry.title}</p>
        <p className="text-footnote text-muted">
          {crew
            ? t('experience.templateResultCard.specialists', {
                count: entry.bots.length,
                names: entry.bots.map((bot) => bot.name).join(', '),
              })
            : entry.bots[0]?.role}
        </p>
        <p className="text-callout">{entry.summary}</p>
      </div>
      <div className="flex shrink-0 flex-col items-center gap-2">
        <span className="flex" aria-hidden>
          {entry.bots.map((bot) => (
            <BotAvatar key={bot.key} bot={bot} size="sm" />
          ))}
        </span>
        {experience ? (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onPress={() => experience.openTemplates(entry.id, false, prefillFrom(input))}
            >
              {t('experience.templateResultCard.viewDetails')}
            </Button>
            {crew ? (
              <Button
                size="sm"
                onPress={() => experience.openTemplates(entry.id, true, prefillFrom(input))}
              >
                {t('experience.templateResultCard.setUpCrew')}
                <IconArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
