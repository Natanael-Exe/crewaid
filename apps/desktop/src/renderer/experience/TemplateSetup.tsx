import { Button } from '@heroui/react';
import { IconArrowRight, IconArrowUp, IconCircleCheck, IconClock } from '@tabler/icons-react';
import { useState } from 'react';
import type { Template, TemplateInstallation } from '@crewaid/shared';
import { BotAvatar } from '../components/BotAvatar';
import { SETTINGS_INPUT_CLASS } from '../settings/SettingsLayout';
import { BackLink } from './TemplateDetail';
import { TOOL_STATE_LABEL, serverFor, toolState, type Connections } from './templateView';
import { useT } from '../i18n/i18n';

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
        <p className="text-[14px] text-muted">
          {t('experience.templateSetup.aShortBriefHelpsEvery')}
        </p>
      </header>
      <div className="grid gap-8 px-8 py-6 md:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-2">
            <label htmlFor="template-goal" className="text-[14px] font-semibold">
              {t('experience.templateSetup.whatShouldThisCrewHelp')}
            </label>
            <input
              id="template-goal"
              maxLength={1000}
              value={draft.goal}
              placeholder={template.starterTask.replace(/^Ask the .+? crew to /, '')}
              onChange={(event) => onChange({ ...draft, goal: event.target.value })}
              className={SETTINGS_INPUT_CLASS}
            />
          </div>
          <div className="flex flex-col gap-2 border-t border-separator pt-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-[14px] font-semibold">
                  {t('experience.templateSetup.sharedContext')}
                </span>
                {contextOpen ? null : (
                  <span className="truncate text-[13px] text-muted">
                    {draft.context ||
                      t('experience.templateSetup.yourBusinessAudienceAndPreferences')}
                  </span>
                )}
              </div>
              <button
                type="button"
                aria-expanded={contextOpen}
                onClick={() => setContextOpen((open) => !open)}
                className="shrink-0 text-[13px] cursor-pointer hover:opacity-80"
              >
                {contextOpen ? t('experience.templateSetup.done') : t('experience.memoryView.edit')}
              </button>
            </div>
            {contextOpen ? (
              <>
                <textarea
                  aria-label={t('experience.templateSetup.sharedContext')}
                  rows={4}
                  maxLength={4000}
                  value={draft.context}
                  onChange={(event) => onChange({ ...draft, context: event.target.value })}
                  className={`${SETTINGS_INPUT_CLASS} h-auto resize-none py-2 leading-5`}
                />
                <span className="text-[12px] text-muted">
                  {t('experience.templateSetup.sharedWithTheseSpecialistsLeave')}
                </span>
              </>
            ) : null}
          </div>
          <div className="flex flex-col gap-2 border-t border-separator pt-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-[14px] font-semibold">
                  {t('experience.templateSetup.toolsOptional')}
                </span>
                <span className="text-[13px] text-muted">
                  {connected === 0
                    ? t('experience.templateSetup.startWithChatNoTools')
                    : t('experience.templateSetup.startWithChatTools', { count: connected })}
                </span>
              </div>
              <button
                type="button"
                aria-expanded={toolsOpen}
                onClick={() => setToolsOpen((open) => !open)}
                className="shrink-0 text-[13px] cursor-pointer hover:opacity-80"
              >
                {toolsOpen
                  ? t('experience.templateSetup.done')
                  : t('experience.templateSetup.chooseTools')}
              </button>
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
                      className="flex items-center gap-3 border-b border-separator py-2.5 text-[13px]"
                    >
                      <input
                        type="checkbox"
                        aria-label={t('experience.templateSetup.useTool', { tool: tool.label })}
                        disabled={!usable}
                        checked={usable && draft.serverIds.includes(server.id)}
                        onChange={(event) => server && toggle(server.id, event.target.checked)}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="font-medium">{tool.label}</span>
                        <span className="text-[12px] text-muted">
                          {state === 'connected'
                            ? t('experience.templateSetup.connectedForTheSpecialistsThat')
                            : TOOL_STATE_LABEL[state]}
                        </span>
                      </span>
                      {state === 'available' || state === 'reconnect' ? (
                        <button type="button" onClick={onConnect} className="text-[13px]">
                          {state === 'reconnect'
                            ? t('experience.templateSetup.reconnect')
                            : t('experience.templateSetup.connect')}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <h3 className="text-[14px] font-semibold">
            {t('experience.templateSetup.yourCrew', { title: template.title })}
          </h3>
          <ul className="flex flex-col gap-3">
            {template.bots.map((bot) => (
              <li key={bot.key} className="flex items-center gap-3">
                <BotAvatar bot={bot} size="sm" />
                <span className="flex flex-col">
                  <span className="text-[14px] font-semibold">{bot.name}</span>
                  <span className="text-[12px] text-muted">{bot.role}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[13px] leading-5 text-muted">
            {t('experience.templateSetup.addsAllTogether', { count: template.bots.length })}
          </p>
          <p className="text-[13px] leading-5 text-muted">
            {t('experience.templateSetup.usesYourDefaultModelAnd')}
          </p>
          <span className="crewaid-template-note flex items-center gap-2 self-start rounded-[10px] px-3 py-2 text-[12px] text-muted">
            <IconClock className="size-3.5" aria-hidden />
            {t('experience.templateSetup.noRoutinesScheduled')}
          </span>
        </aside>
      </div>
      {failed ? (
        <div role="alert" className="crewaid-template-failure mx-8 mb-4 rounded-card px-5 py-4">
          <p className="text-[15px] font-semibold">
            {t('experience.templateSetup.weCouldnTAddThis')}
          </p>
          <p className="text-[14px] text-muted">
            {t('experience.templateSetup.yourGoalSharedContextAnd')}
          </p>
        </div>
      ) : null}
      <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-separator px-8 py-5">
        <p className="text-[13px] text-muted">
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
    names.length > 1 ? `${names.slice(0, -1).join(', ')} & ${names.at(-1)}` : (names[0] ?? '');
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4 pb-6 ps-8 pe-20">
        <div className="flex flex-col gap-3">
          <span className="flex items-center gap-2 text-[13px] font-medium text-success">
            <IconCircleCheck className="size-4" aria-hidden />
            {t('experience.templateSetup.crewAdded')}
          </span>
          <h2 className="crewaid-template-title">
            {t('experience.templateSetup.crewIsReady', { title: template.title })}
          </h2>
          <p className="text-[14px] text-muted">
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
          <span className="text-[14px] font-semibold">{joined}</span>
          <span className="text-[13px] text-muted">
            {t('experience.templateSetup.readyToWorkFromYour')}
          </span>
        </span>
      </div>
      {canStart ? (
        <section className="flex flex-col gap-3 px-8 py-6">
          <label htmlFor="template-first-task" className="text-[17px] font-semibold">
            {t('experience.templateSetup.giveThemAFirstTask')}
          </label>
          <p className="text-[14px] text-muted">
            {t('experience.templateSetup.crewaidCanBriefTheSpecialists')}
          </p>
          <textarea
            id="template-first-task"
            rows={3}
            maxLength={4000}
            value={firstTask}
            onChange={(event) => onFirstTask(event.target.value)}
            className={`${SETTINGS_INPUT_CLASS} h-auto resize-none py-3 leading-6`}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[13px] text-muted">
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
