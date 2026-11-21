import { Button } from '@heroui/react';
import { IconArrowLeft, IconArrowRight, IconCheck, IconChevronRight } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import type { Template } from '@crewaid/shared';
import { BotAvatar } from '../components/BotAvatar';
import { TOOL_STATE_LABEL, toolState, type Connections } from './templateView';
import { useT } from '../i18n/i18n';

export function BackLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="flex items-center gap-2 self-start text-[13px] text-muted hover:text-foreground"
    >
      <IconArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden />
      {label}
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** Example output, always labelled: no bot has done this work yet. */
function ExampleBand({ example }: { example: Template['examples'][number] | undefined }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (example === undefined) return null;
  return (
    <section className="crewaid-template-example flex flex-col gap-2 px-8 py-5">
      <div className="flex items-start justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[13px] text-muted">
            {t('experience.templateDetail.illustrativeExample')}
          </span>
          <p className="text-[15px] font-medium">{example.title}</p>
        </div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex shrink-0 items-center gap-1 text-[13px]"
        >
          {open
            ? t('experience.templateDetail.hideExample')
            : t('experience.templateDetail.seeExample')}
          <IconArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
        </button>
      </div>
      {open ? (
        <p className="whitespace-pre-wrap text-[14px] leading-[22px] text-muted">
          {example.content}
        </p>
      ) : null}
    </section>
  );
}

function ToolChips({ template, connections }: { template: Template; connections: Connections }) {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-2">
      {template.tools.map((tool) => {
        const state = toolState(tool.slug, connections);
        return (
          <span
            key={tool.slug}
            data-tool-state={state}
            className="crewaid-tool-chip flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px]"
            title={TOOL_STATE_LABEL[state]}
          >
            {state === 'connected' ? <IconCheck className="size-3" aria-hidden /> : null}
            {state === 'connected'
              ? t('experience.templateDetail.toolConnected', { tool: tool.label })
              : tool.label}
          </span>
        );
      })}
    </div>
  );
}

export function CrewDetail({
  template,
  connections,
  onBack,
  onAdd,
  onOpenMember,
}: {
  template: Template;
  connections: Connections;
  onBack: () => void;
  onAdd: () => void;
  onOpenMember: (key: string) => void;
}) {
  const t = useT();
  return (
    <>
      <header className="flex flex-col gap-4 border-b border-separator px-8 pb-6">
        <BackLink label={t('experience.templateDetail.allTemplates')} onPress={onBack} />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex max-w-[620px] flex-col gap-2">
            <h2 className="crewaid-template-title">{template.title}</h2>
            <p className="text-[14px] leading-[22px] text-muted">{template.summary}</p>
          </div>
          <Button onPress={onAdd}>{t('experience.templateDetail.addCrew')}</Button>
        </div>
      </header>
      <div className="grid gap-8 px-8 py-6 md:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Section
            title={t('experience.templateDetail.meetYourCrew', { count: template.bots.length })}
          >
            <ul className="flex flex-col">
              {template.bots.map((bot) => (
                <li key={bot.key} className="border-b border-separator">
                  <button
                    type="button"
                    onClick={() => onOpenMember(bot.key)}
                    className="crewaid-template-entry flex w-full items-center gap-3 py-3 text-start cursor-pointer hover:opacity-80"
                  >
                    <BotAvatar bot={bot} size="sm" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex flex-wrap items-baseline gap-2">
                        <span className="text-[14px] font-semibold">{bot.name}</span>
                        <span className="text-[12px] text-muted">{bot.role}</span>
                      </span>
                      <span className="text-[13px] text-muted">{bot.summary}</span>
                    </span>
                    <IconChevronRight
                      className="size-4 shrink-0 text-muted rtl:-scale-x-100"
                      aria-hidden
                    />
                  </button>
                </li>
              ))}
            </ul>
          </Section>
          {template.handoff.length > 0 ? (
            <Section title={t('experience.templateDetail.howTheyWorkTogether')}>
              <ol className="crewaid-template-handoff flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card px-4 py-3 text-[13px]">
                {template.handoff.map((step, index) => (
                  <li key={step} className="flex items-center gap-3">
                    {index > 0 ? (
                      <IconArrowRight
                        className="size-3.5 text-muted rtl:-scale-x-100"
                        aria-hidden
                      />
                    ) : null}
                    {step}
                  </li>
                ))}
              </ol>
              <p className="text-[12px] text-muted">
                {t('experience.templateDetail.eachStepStartsWhenSomeone')}
              </p>
            </Section>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Section title={t('experience.templateDetail.whatYouLlGet')}>
            <ul className="flex flex-col gap-1 text-[14px] text-muted">
              {template.outcomes.map((outcome) => (
                <li key={outcome}>{outcome}</li>
              ))}
            </ul>
          </Section>
          <Section title={t('experience.templateDetail.bringALittleContext')}>
            <p className="text-[14px] leading-[22px] text-muted">{template.inputs.join(' · ')}</p>
          </Section>
          <Section title={t('experience.templateBrowse.supportedTools')}>
            <ToolChips template={template} connections={connections} />
            <p className="text-[12px] text-muted">
              {t('experience.templateDetail.connectionsAreOptionalYouCan')}
            </p>
          </Section>
          <Section title={t('experience.templateDetail.routines')}>
            <p className="text-[13px] leading-5 text-muted">{template.routineSuggestion}</p>
          </Section>
        </div>
      </div>
      <ExampleBand example={template.examples[0]} />
    </>
  );
}

export function BotDetail({
  template,
  connections,
  backLabel,
  onBack,
  onAdd,
}: {
  template: Template;
  connections: Connections;
  backLabel: string;
  onBack: () => void;
  onAdd: () => void;
}) {
  const t = useT();
  const bot = template.bots[0];
  if (bot === undefined) return null;
  return (
    <>
      <header className="flex flex-col gap-4 border-b border-separator px-8 pb-6">
        <BackLink label={backLabel} onPress={onBack} />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <BotAvatar bot={bot} size="lg" />
            <div className="flex flex-col gap-1">
              <h2 className="crewaid-template-title">{bot.name}</h2>
              <p className="text-[14px] text-muted">{bot.role}</p>
            </div>
          </div>
          <Button onPress={onAdd}>{t('experience.templateDetail.addBot')}</Button>
        </div>
      </header>
      <div className="grid gap-8 px-8 py-6 md:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Section title={bot.summary}>
            {template.memberOf.length > 0 ? (
              <p className="text-[13px] text-muted">
                {t('experience.templateDetail.worksOnItsOwnAndIn', {
                  list: template.memberOf.join(', '),
                })}
              </p>
            ) : null}
          </Section>
          <Section title={t('experience.templateDetail.howBotWorks', { botName: bot.name })}>
            <p className="crewaid-template-brief whitespace-pre-wrap rounded-card px-4 py-3 text-[13px] leading-[21px] text-muted">
              {bot.systemPrompt}
            </p>
            <p className="text-[12px] text-muted">
              {t('experience.templateDetail.thisBecomesDescription', { botName: bot.name })}
            </p>
          </Section>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Section title={t('experience.templateDetail.whatToBring')}>
            <ul className="flex flex-col gap-1 text-[14px] text-muted">
              {template.inputs.map((input) => (
                <li key={input}>{input}</li>
              ))}
            </ul>
          </Section>
          <Section title={t('experience.templateDetail.toolsBotCanUse', { botName: bot.name })}>
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {template.tools.map((tool) => {
                const state = toolState(tool.slug, connections);
                return (
                  <li key={tool.slug} className="flex items-center justify-between gap-3">
                    {tool.label}
                    <span
                      data-tool-state={state}
                      className={state === 'connected' ? 'text-success' : 'text-muted'}
                    >
                      {TOOL_STATE_LABEL[state]}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="text-[12px] text-muted">
              {t('experience.templateDetail.optionalPastedNotesWorkToo')}
            </p>
          </Section>
        </div>
      </div>
      <ExampleBand example={template.examples[0]} />
      <p className="px-8 py-4 text-[13px] text-muted">
        {t('experience.templateDetail.addingOpensProfile', { botName: bot.name })}
      </p>
    </>
  );
}
