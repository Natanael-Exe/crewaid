import { Alert, Button, Checkbox, Input, TextArea } from '@heroui/react';
import { IconArrowRight, IconArrowUp, IconCircleCheck, IconClock } from '@tabler/icons-react';
import { useState } from 'react';
import type { Template, TemplateInstallation } from '@crewaid/shared';
import { BotAvatar } from '../components/BotAvatar';
import { BackLink } from './TemplateDetail';
import { TOOL_STATE_LABEL, serverFor, toolState, type Connections } from './templateView';
import { currentLocale, useT } from '../i18n/i18n';

/** What a person can change before a crew is added: its brief and its tools. */
export type SetupDraft = {
  readonly goal: string;
  readonly context: string;
  readonly serverIds: readonly string[];
};

export function CrewSetup({
  template,
  connections,
  draft,
  onChange,
  busy,
  failed,
  onBack,
  onAdd,
  onConnect,
}: {
  template: Template;
  connections: Connections;
  draft: SetupDraft;
  onChange: (next: SetupDraft) => void;
  busy: boolean;
  failed: boolean;
  onBack: () => void;
  onAdd: () => void;
  onConnect: () => void;
}) {
  const t = useT();
  // Both start folded when there is nothing to review in them, so the goal is
  // the one decision on screen; a drafted context opens already filled in.
  const [contextOpen, setContextOpen] = useState(draft.context !== '');
  const [toolsOpen, setToolsOpen] = useState(false);
  const connected = template.tools.filter(
    (tool) => toolState(tool.slug, connections) === 'connected',
  ).length;
  const toggle = (serverId: string, on: boolean) =>
    onChange({
      ...draft,
      serverIds: on
        ? [...draft.serverIds, serverId]
        : draft.serverIds.filter((id) => id !== serverId),
    });
  return (
    <>
      <header className="flex flex-col gap-4 border-b border-separator px-8 pb-6">
        <BackLink label={template.title} onPress={onBack} />
        <h2 className="crewaid-template-title">
          {t('experience.templateSetup.reviewYourCrew', { title: template.title })}
        </h2>
        <p className="text-callout text-muted">
          {t('experience.templateSetup.aShortBriefHelpsEvery')}
        </p>
      </header>
      <div className="grid gap-8 px-8 py-6 md:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-2">
            <label htmlFor="template-goal" className="text-callout font-semibold">
              {t('experience.templateSetup.whatShouldThisCrewHelp')}
            </label>
            <Input
              id="template-goal"
              variant="secondary"
              maxLength={1000}
              value={draft.goal}
              placeholder={template.starterTask}
              onChange={(event) => onChange({ ...draft, goal: event.target.value })}
              className="w-full"
            />
          </div>
          <div className="flex flex-col gap-2 border-t border-separator pt-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-callout font-semibold">
                  {t('experience.templateSetup.sharedContext')}
                </span>
                {contextOpen ? null : (
                  <span className="truncate text-footnote text-muted">
                    {draft.context ||
                      t('experience.templateSetup.yourBusinessAudienceAndPreferences')}
                  </span>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={contextOpen}
                onPress={() => setContextOpen((open) => !open)}
                className="shrink-0 text-footnote"
              >
                {contextOpen ? t('experience.templateSetup.done') : t('experience.memoryView.edit')}
              </Button>
            </div>
            {contextOpen ? (
              <>
                <TextArea
                  variant="secondary"
                  aria-label={t('experience.templateSetup.sharedContext')}
                  rows={4}
                  maxLength={4000}
                  value={draft.context}
                  onChange={(event) => onChange({ ...draft, context: event.target.value })}
                  className="w-full resize-none"
                />
                <span className="text-caption text-muted">
                  {t('experience.templateSetup.sharedWithTheseSpecialistsLeave')}
                </span>
              </>
            ) : null}
          </div>
          <div className="flex flex-col gap-2 border-t border-separator pt-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-callout font-semibold">
                  {t('experience.templateSetup.toolsOptional')}
                </span>
                <span className="text-footnote text-muted">
                  {connected === 0
                    ? t('experience.templateSetup.startWithChatNoTools')
                    : t('experience.templateSetup.startWithChatTools', { count: connected })}
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={toolsOpen}
                onPress={() => setToolsOpen((open) => !open)}
                className="shrink-0 text-footnote"
              >
                {toolsOpen
                  ? t('experience.templateSetup.done')
                  : t('experience.templateSetup.chooseTools')}
              </Button>
            </div>
            {toolsOpen ? (
              <ul className="flex flex-col">
                {template.tools.map((tool) => {
                  const state = toolState(tool.slug, connections);
                  const server = serverFor(tool.slug, connections);
                  const usable = server !== undefined && state === 'connected';
                  return (
                    <li
                      key={tool.slug}
                      className="flex items-center gap-3 border-b border-separator py-2.5 text-footnote"
                    >
                      <Checkbox
                        aria-label={t('experience.templateSetup.useTool', { tool: tool.label })}
                        isDisabled={!usable}
                        isSelected={usable && draft.serverIds.includes(server.id)}
                        onChange={(selected) => server && toggle(server.id, selected)}
                        className="min-w-0 flex-1"
                      >
                        <Checkbox.Content className="flex items-center gap-3">
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="font-medium">{tool.label}</span>
                            <span className="text-caption text-muted">
                              {state === 'connected'
                                ? t('experience.templateSetup.connectedForTheSpecialistsThat')
                                : TOOL_STATE_LABEL[state]}
                            </span>
                          </span>
                        </Checkbox.Content>
                      </Checkbox>
                      {state === 'available' || state === 'reconnect' ? (
                        <Button size="sm" variant="ghost" onPress={onConnect} className="shrink-0">
                          {state === 'reconnect'
                            ? t('experience.templateSetup.reconnect')
                            : t('experience.templateSetup.connect')}
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <h3 className="text-callout font-semibold">
            {t('experience.templateSetup.yourCrew', { title: template.title })}
          </h3>
          <ul className="flex flex-col gap-3">
            {template.bots.map((bot) => (
              <li key={bot.key} className="flex items-center gap-3">
                <BotAvatar bot={bot} size="sm" />
                <span className="flex flex-col">
                  <span className="text-callout font-semibold">{bot.name}</span>
                  <span className="text-caption text-muted">{bot.role}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-footnote leading-5 text-muted">
            {t('experience.templateSetup.addsAllTogether', { count: template.bots.length })}
          </p>
          <p className="text-footnote leading-5 text-muted">
            {t('experience.templateSetup.usesYourDefaultModelAnd')}
          </p>
          <span className="crewaid-template-note flex items-center gap-2 self-start rounded-[10px] px-3 py-2 text-caption text-muted">
            <IconClock className="size-3.5" aria-hidden />
            {t('experience.templateSetup.noRoutinesScheduled')}
          </span>
        </aside>
      </div>
      {failed ? (
        <div className="mx-8 mb-4">
          <Alert status="danger" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{t('experience.templateSetup.weCouldnTAddThis')}</Alert.Title>
              <Alert.Description>
                {t('experience.templateSetup.yourGoalSharedContextAnd')}
              </Alert.Description>
            </Alert.Content>
          </Alert>
        </div>
      ) : null}
      <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-separator px-8 py-5">
        <p className="text-footnote text-muted">
          {t('experience.templateSetup.addsSpecialistsAndBrief', { count: template.bots.length })}
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onPress={onBack}>
            {t('experience.templateSetup.back')}
          </Button>
          <Button isDisabled={busy} onPress={onAdd}>
            {busy
              ? t('experience.templateSetup.adding')
              : failed
                ? t('experience.templatesModal.tryAgain')
                : t('experience.templateDetail.addCrew')}
          </Button>
        </div>
      </footer>
    </>
  );
}

export function CrewAdded({
  template,
  installation,
  firstTask,
  onFirstTask,
  canStart,
  onOpenCrew,
  onStart,
}: {
  template: Template;
  installation: TemplateInstallation;
  firstTask: string;
  onFirstTask: (text: string) => void;
  /** False when there is no Crewaid to brief the crew; the task section is left out. */
  canStart: boolean;
  onOpenCrew: () => void;
  onStart: () => void;
}) {
  const t = useT();
  const names = template.bots.map((bot) => bot.name);
  const joined =
    names.length > 0
      ? new Intl.ListFormat(currentLocale(), { style: 'long', type: 'conjunction' }).format(names)
      : '';
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4 pb-6 ps-8 pe-20">
        <div className="flex flex-col gap-3">
          <span className="flex items-center gap-2 text-footnote font-medium text-success">
            <IconCircleCheck className="size-4" aria-hidden />
            {t('experience.templateSetup.crewAdded')}
          </span>
          <h2 className="crewaid-template-title">
            {t('experience.templateSetup.crewIsReady', { title: template.title })}
          </h2>
          <p className="text-callout text-muted">
            {t('experience.templateSetup.specialistsOneBrief', {
              count: installation.botIds.length,
            })}
          </p>
        </div>
        <Button variant="secondary" onPress={onOpenCrew}>
          {t('experience.templateSetup.openCrew')}
          <IconArrowRight className="size-4 rtl:-scale-x-100" aria-hidden />
        </Button>
      </header>
      <div className="crewaid-template-example flex items-center gap-5 px-8 py-5">
        <span className="flex shrink-0 gap-2" aria-hidden>
          {template.bots.map((bot) => (
            <BotAvatar key={bot.key} bot={bot} size="sm" />
          ))}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-callout font-semibold">{joined}</span>
          <span className="text-footnote text-muted">
            {t('experience.templateSetup.readyToWorkFromYour')}
          </span>
        </span>
      </div>
      {canStart ? (
        <section className="flex flex-col gap-3 px-8 py-6">
          <label htmlFor="template-first-task" className="text-headline font-semibold">
            {t('experience.templateSetup.giveThemAFirstTask')}
          </label>
          <p className="text-callout text-muted">
            {t('experience.templateSetup.crewaidCanBriefTheSpecialists')}
          </p>
          <TextArea
            id="template-first-task"
            variant="secondary"
            rows={3}
            maxLength={4000}
            value={firstTask}
            onChange={(event) => onFirstTask(event.target.value)}
            className="w-full resize-none"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-footnote text-muted">
              {t('experience.templateSetup.sentToCrewaidExactlyAs')}
            </span>
            <Button isDisabled={firstTask.trim() === ''} onPress={onStart}>
              {t('experience.templateSetup.startFirstTask')}
              <IconArrowUp className="size-4" aria-hidden />
            </Button>
          </div>
        </section>
      ) : null}
    </>
  );
}
