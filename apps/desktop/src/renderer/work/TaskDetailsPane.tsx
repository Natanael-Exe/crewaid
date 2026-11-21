import { Button } from '@heroui/react';
import {
  IconArrowUpRight,
  IconCheck,
  IconExternalLink,
  IconMessage,
  IconPlayerPlay,
  IconRepeat,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import type {
  BotWithSandbox,
  GoalWithProgress,
  ProjectWithCounts,
  TaskDetailResponse,
  TaskSeriesDetailResponse,
  TaskStatus,
  UpdateTaskBody,
} from '@crewaid/shared';
import { failureOf } from '../api';
import type { ApiClient } from '../api/apiClient';
import {
  addTaskNote,
  createTask,
  deleteTask,
  getTask,
  getTaskSeries,
  listGoals,
  startTask,
  updateTask,
  updateTaskSeries,
} from '../api/work';
import { AttachmentCard } from '../components/attachments/AttachmentCard';
import { BotAvatar } from '../components/BotAvatar';
import { ExternalLink, isOpenableLink } from '../components/ExternalLink';
import { StreamingMarkdown } from '../components/markdown/StreamingMarkdown';
import { EndsField, ScheduleField, TimezonePicker } from '../routines/RoutineScheduleFields';
import { describeSchedule, relativeTime } from '../routines/routinesState';
import { SETTINGS_INPUT_CLASS } from '../settings/SettingsLayout';
import { STATUS_LABELS, isOverdue, localToday, shortDate } from './boardState';
import { eventConversation, eventDetail, eventText } from './detailsState';
import { Picker } from './Fields';
import { workFailureText } from './workErrors';
import { usageText } from './workState';
import { useT } from '../i18n/i18n';

const STATUSES: readonly TaskStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'IN_REVIEW',
  'DONE',
  'CANCELLED',
];

/**
 * A task's details in the right rail: every field editable in
 * place, its subtasks, its deliverables, and its activity — who did what and
 * when, each row with its note and a jump to the message it came from.
 *
 * Start and "Assign & start" go through the one Start route with a key made
 * once per press; changing the status here, like dragging, starts
 * nothing. Re-reads whenever a `task.changed` frame moves `revision`.
 */
export function TaskDetailsPane({
  client,
  taskId,
  revision,
  bots,
  projects,
  onClose,
  onOpenTask,
  onOpenConversation,
}: {
  client: ApiClient;
  taskId: string;
  revision: number;
  bots: readonly BotWithSandbox[];
  projects: readonly ProjectWithCounts[];
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
  /** Open a bot's transcript, at a message when one is named. */
  onOpenConversation: (botId: string, messageId: string | null) => void;
}) {
  const t = useT();
  const [task, setTask] = useState<TaskDetailResponse | null>(null);
  const [series, setSeries] = useState<TaskSeriesDetailResponse | null>(null);
  const [goals, setGoals] = useState<readonly GoalWithProgress[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let live = true;
    getTask(client, taskId)
      .then(async (detail) => {
        if (!live) return;
        setTask(detail);
        setSeries(detail.seriesId === null ? null : await getTaskSeries(client, detail.seriesId));
      })
      .catch((error: unknown) => {
        if (live) setFailure(workFailureText(failureOf(error)));
      });
    return () => {
      live = false;
    };
  }, [client, taskId, revision, nonce]);

  useEffect(() => {
    listGoals(client)
      .then(setGoals)
      .catch(() => undefined);
  }, [client, revision]);

  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      setFailure(null);
      try {
        await run();
        reload();
      } catch (error) {
        setFailure(workFailureText(failureOf(error)));
      }
    },
    [reload],
  );
  const patch = (body: UpdateTaskBody) => act(() => updateTask(client, taskId, body));

  if (task === null) {
    return (
      <RailFrame onClose={onClose}>
        {failure === null ? null : (
          <p role="alert" className="text-[12px] text-danger">
            {failure}
          </p>
        )}
      </RailFrame>
    );
  }

  const assignee =
    task.assigneeBotId === null ? undefined : bots.find((bot) => bot.id === task.assigneeBotId);
  const subtask = task.parentId !== null;
  const start = (assignBotId?: string) =>
    act(async () => {
      if (assignBotId !== undefined)
        await updateTask(client, task.id, { assigneeBotId: assignBotId });
      await startTask(client, task.id, crypto.randomUUID());
    });

  return (
    <RailFrame onClose={onClose}>
      <InlineText
        key={`title-${task.id}-${task.title}`}
        label={t('work.messageWorkDialogs.title')}
        value={task.title}
        className="text-[15px] font-semibold"
        onSave={(title) => void patch({ title })}
      />

      <div className="grid grid-cols-[88px_1fr] items-center gap-x-3 gap-y-2 text-[13px]">
        <span className="text-muted">{t('work.taskDetailsPane.status')}</span>
        <Picker
          label={t('work.taskDetailsPane.status')}
          value={task.status}
          options={STATUSES.map((status) => ({ id: status, label: STATUS_LABELS[status] }))}
          onChange={(status) => {
            if (status !== null) void patch({ status: status as TaskStatus });
          }}
        />
        {task.status === 'BLOCKED' ? (
          <>
            <span className="text-muted">{t('work.taskDetailsPane.why')}</span>
            <InlineText
              key={`blocked-${task.blockedReason ?? ''}`}
              label={t('work.taskDetailsPane.blockedReason')}
              value={task.blockedReason ?? ''}
              placeholder={t('work.taskDetailsPane.whatItIsWaitingOn')}
              onSave={(blockedReason) => void patch({ blockedReason: blockedReason || null })}
            />
          </>
        ) : null}
        <span className="text-muted">{t('work.newTaskDialog.assignee')}</span>
        <Picker
          label={t('work.newTaskDialog.assignee')}
          value={task.assigneeBotId}
          noneLabel={t('work.newTaskDialog.youUnassigned')}
          options={bots.map((bot) => ({
            id: bot.id,
            label: bot.name,
            adornment: <BotAvatar bot={bot} size="sm" />,
          }))}
          onChange={(assigneeBotId) => void patch({ assigneeBotId })}
        />
        {subtask ? null : (
          <>
            <span className="text-muted">{t('work.deliverablePane.project')}</span>
            <Picker
              label={t('work.deliverablePane.project')}
              value={task.projectId}
              noneLabel={t('work.tasksView.inbox')}
              options={projects
                .filter((project) => project.status === 'ACTIVE' || project.id === task.projectId)
                .map((project) => ({
                  id: project.id,
                  label: project.name,
                  adornment: (
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: project.color }}
                    />
                  ),
                }))}
              onChange={(projectId) => void patch({ projectId })}
            />
            <span className="text-muted">{t('work.deliverablePane.goal')}</span>
            <Picker
              label={t('work.deliverablePane.goal')}
              value={task.goalId}
              noneLabel={t('work.deliverablePane.noGoal')}
              options={goals.map((goal) => ({ id: goal.id, label: goal.title }))}
              onChange={(goalId) => void patch({ goalId })}
            />
          </>
        )}
        <span className="text-muted">{t('work.newTaskDialog.due')}</span>
        <input
          aria-label={t('work.taskDetailsPane.dueDate')}
          type="date"
          value={task.dueOn ?? ''}
          onChange={(event) =>
            void patch({ dueOn: event.target.value === '' ? null : event.target.value })
          }
          className={`${SETTINGS_INPUT_CLASS} h-8 ${isOverdue(task, localToday()) ? 'text-danger' : ''}`}
        />
      </div>

      {series === null ? null : (
        <SeriesSection
          client={client}
          series={series}
          currentId={task.id}
          onOpenTask={onOpenTask}
          onChanged={reload}
          onFailure={setFailure}
        />
      )}

      <Section title={t('work.newTaskDialog.brief')}>
        <BriefEditor
          key={`brief-${task.id}-${task.brief ?? ''}`}
          brief={task.brief}
          onSave={(brief) => void patch({ brief })}
        />
      </Section>

      {subtask ? null : (
        <Section
          title={
            task.subtasks.total > 0
              ? t('work.subtasksCount', { done: task.subtasks.done, total: task.subtasks.total })
              : t('work.tasksView.subtasks')
          }
        >
          <ul className="flex flex-col gap-1">
            {task.subtaskRows.map((row) => {
              const who =
                row.assigneeBotId === null
                  ? undefined
                  : bots.find((bot) => bot.id === row.assigneeBotId);
              return (
                <li key={row.id} className="flex items-center gap-2 text-[13px]">
                  <button
                    type="button"
                    aria-label={
                      row.status === 'DONE'
                        ? t('work.subtask.reopen', { title: row.title })
                        : t('work.subtask.done', { title: row.title })
                    }
                    onClick={() =>
                      void act(() =>
                        updateTask(client, row.id, {
                          status: row.status === 'DONE' ? 'TODO' : 'DONE',
                        }),
                      )
                    }
                    className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                      row.status === 'DONE'
                        ? 'border-success bg-success text-white'
                        : 'border-border'
                    }`}
                  >
                    {row.status === 'DONE' ? <IconCheck className="size-3" stroke={3} /> : null}
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenTask(row.id)}
                    className={`min-w-0 flex-1 truncate text-start ${row.status === 'DONE' ? 'text-muted line-through' : ''}`}
                  >
                    {row.title}
                  </button>
                  {who === undefined ? null : <BotAvatar bot={who} size="sm" />}
                </li>
              );
            })}
          </ul>
          <SubtaskAdder
            bots={bots}
            onAdd={(title, assigneeBotId) =>
              void act(() =>
                createTask(client, {
                  title,
                  parentId: task.id,
                  ...(assigneeBotId !== null && { assigneeBotId }),
                }),
              )
            }
          />
        </Section>
      )}

      {task.deliverables.length === 0 ? null : (
        <Section title={t('work.goalDetailsPane.deliverables')}>
          <div className="flex flex-col gap-2">
            {task.deliverables.map((item) =>
              item.attachment !== null ? (
                <AttachmentCard key={item.id} attachment={item.attachment} />
              ) : isOpenableLink(item.url) ? (
                <ExternalLink
                  key={item.id}
                  href={item.url}
                  className="flex items-center gap-1.5 text-[13px] text-accent hover:underline"
                >
                  <IconExternalLink className="size-3.5" stroke={1.8} />
                  {item.title}
                </ExternalLink>
              ) : (
                <span key={item.id} className="text-[13px]">
                  {item.title}
                </span>
              ),
            )}
          </div>
        </Section>
      )}

      <Section title={t('work.taskDetailsPane.activity')}>
        {usageText(task.usage) === null ? null : (
          <p data-task-usage className="text-[11px] text-muted">
            {t('work.usage.used', { usage: usageText(task.usage) ?? '' })}
          </p>
        )}
        <NoteInput onAdd={(text) => void act(() => addTaskNote(client, task.id, text))} />
        <ol className="mt-2 flex flex-col gap-2.5">
          {task.events.map((event) => {
            const detail = eventDetail(event);
            const conversation = eventConversation(event, task.assigneeBotId);
            return (
              <li key={event.id} className="text-[12px] leading-4">
                <span className="font-medium text-foreground">{event.actorLabel}</span>{' '}
                <span className="text-muted">{eventText(event)}</span>{' '}
                <span className="text-foreground-faint">
                  · {relativeTime(event.createdAt, new Date())}
                </span>
                {conversation !== null && event.messageId !== null ? (
                  <button
                    type="button"
                    aria-label={t('work.taskDetailsPane.openTheMessage')}
                    onClick={() => onOpenConversation(conversation, event.messageId)}
                    className="ms-1 inline-flex align-middle text-muted hover:text-foreground"
                  >
                    <IconArrowUpRight className="size-3.5" stroke={1.8} />
                  </button>
                ) : null}
                {detail === null ? null : (
                  <p className="mt-1 whitespace-pre-wrap rounded-lg bg-background-secondary/60 px-2 py-1.5 text-[12px] text-foreground">
                    {detail}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </Section>

      {failure === null ? null : (
        <p role="alert" className="text-[12px] text-danger">
          {failure}
        </p>
      )}

      <footer className="sticky bottom-0 -mx-4 mt-auto flex flex-wrap items-center gap-2 border-t border-separator bg-background px-4 py-3">
        {assignee !== undefined && task.status === 'TODO' ? (
          <Button
            variant="primary"
            size="sm"
            onPress={() => void start()}
            className="h-8 gap-1 rounded-[10px] text-[12px] font-medium"
          >
            <IconPlayerPlay className="size-3.5" stroke={2} />
            {t('work.taskDetailsPane.start')}
          </Button>
        ) : null}
        {assignee === undefined && task.status === 'TODO' && bots.length > 0 ? (
          <AssignAndStart bots={bots} onPick={(botId) => void start(botId)} />
        ) : null}
        {assignee !== undefined ? (
          <Button
            variant="secondary"
            size="sm"
            onPress={() => onOpenConversation(assignee.id, task.lastLinkedMessageId)}
            className="h-8 gap-1 rounded-[10px] text-[12px] font-medium"
          >
            <IconMessage className="size-3.5" stroke={1.8} />
            {t('work.taskDetailsPane.openConversation')}
          </Button>
        ) : null}
        <DeleteButton
          onDelete={() =>
            void act(async () => {
              await deleteTask(client, task.id);
              onClose();
            })
          }
        />
      </footer>
    </RailFrame>
  );
}

function RailFrame({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const t = useT();
  return (
    <aside
      aria-label={t('work.taskDetailsPane.taskDetails')}
      className="crewaid-work-detail flex h-full min-h-0 flex-col"
    >
      <header className="window-drag flex h-12 shrink-0 items-center justify-between px-4">
        <span className="text-[12px] font-medium text-muted">{t('work.deliverablePane.task')}</span>
        <Button
          variant="ghost"
          isIconOnly
          size="sm"
          aria-label={t('work.taskDetailsPane.closeTaskDetails')}
          onPress={onClose}
          className="window-no-drag size-7 rounded-lg text-muted"
        >
          <IconX className="size-4" stroke={1.8} />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-0">{children}</div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-medium tracking-[0.02em] text-muted">{title}</h3>
      {children}
    </section>
  );
}

/** A value shown as text that becomes an input on focus, saved on blur or Enter. */
function InlineText({
  label,
  value,
  placeholder,
  className,
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  className?: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <input
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = draft.trim();
        if (next !== value.trim() && (next !== '' || label !== 'Title')) onSave(next);
        else setDraft(value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      className={`w-full rounded-lg border border-transparent bg-transparent px-1.5 py-1 outline-none hover:border-border focus:border-field-border focus:bg-field ${className ?? 'text-[13px]!'}`}
    />
  );
}

/** The brief, rendered as markdown; Edit turns it into a text box. */
function BriefEditor({
  brief,
  onSave,
}: {
  brief: string | null;
  onSave: (brief: string | null) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(brief ?? '');
  if (editing) {
    return (
      <div className="flex flex-col gap-2">
        <textarea
          aria-label={t('work.newTaskDialog.brief')}
          autoFocus
          rows={8}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className={`${SETTINGS_INPUT_CLASS} h-auto resize-y py-2 leading-[18px]`}
        />
        <div className="flex justify-end gap-2">
          <Button
            variant="tertiary"
            size="sm"
            onPress={() => setEditing(false)}
            className="h-7 rounded-lg text-[12px]"
          >
            {t('work.goalsView.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onPress={() => {
              setEditing(false);
              onSave(draft.trim() === '' ? null : draft);
            }}
            className="h-7 rounded-lg text-[12px]"
          >
            {t('work.messageWorkDialogs.save')}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      aria-label={t('work.taskDetailsPane.editBrief')}
      className="rounded-lg px-1.5 py-1 text-start text-[13px] hover:bg-background-secondary/60"
    >
      {brief === null ? (
        <span className="text-muted">{t('work.taskDetailsPane.addABriefWhatNeeds')}</span>
      ) : (
        <StreamingMarkdown source={brief} />
      )}
    </button>
  );
}

function SubtaskAdder({
  bots,
  onAdd,
}: {
  bots: readonly BotWithSandbox[];
  onAdd: (title: string, assigneeBotId: string | null) => void;
}) {
  const t = useT();
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState<string | null>(null);
  const add = () => {
    if (title.trim() === '') return;
    onAdd(title.trim(), assignee);
    setTitle('');
  };
  return (
    <div className="flex items-center gap-2">
      <input
        aria-label={t('work.taskDetailsPane.newSubtask')}
        value={title}
        placeholder={t('work.taskDetailsPane.addSubtask')}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') add();
        }}
        className={`${SETTINGS_INPUT_CLASS} h-8 flex-1 text-[13px]!`}
      />
      <Picker
        label={t('work.taskDetailsPane.subtaskAssignee')}
        value={assignee}
        noneLabel={t('work.tasksView.you')}
        options={bots.map((bot) => ({ id: bot.id, label: bot.name }))}
        onChange={setAssignee}
        className="w-[110px]"
      />
    </div>
  );
}

function NoteInput({ onAdd }: { onAdd: (text: string) => void }) {
  const t = useT();
  const [text, setText] = useState('');
  return (
    <input
      aria-label={t('work.taskDetailsPane.addANote')}
      value={text}
      placeholder={t('work.taskDetailsPane.addANote')}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || text.trim() === '') return;
        onAdd(text.trim());
        setText('');
      }}
      className={`${SETTINGS_INPUT_CLASS} h-8 text-[13px]!`}
    />
  );
}

/** "Assign & start": pick the bot, and the same press starts it. */
function AssignAndStart({
  bots,
  onPick,
}: {
  bots: readonly BotWithSandbox[];
  onPick: (botId: string) => void;
}) {
  const t = useT();
  return (
    <Picker
      label={t('work.taskDetailsPane.assignAndStart')}
      value={null}
      noneLabel={t('work.taskDetailsPane.assignStart')}
      options={bots.map((bot) => ({
        id: bot.id,
        label: bot.name,
        adornment: <BotAvatar bot={bot} size="sm" />,
      }))}
      onChange={(botId) => {
        if (botId !== null) onPick(botId);
      }}
      className="w-[160px]"
    />
  );
}

function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const t = useT();
  const [armed, setArmed] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onPress={() => (armed ? onDelete() : setArmed(true))}
      className="ms-auto h-8 gap-1 rounded-[10px] text-[12px] text-danger"
    >
      <IconTrash className="size-3.5" stroke={1.8} />
      {armed ? t('work.taskDetailsPane.deleteItAndItsSubtasks') : t('work.goalDetailsPane.delete')}
    </Button>
  );
}

/**
 * A recurring task's schedule and its recent occurrences (PRD-WORK §3.6):
 * edit the schedule (future occurrences only), stop it, and reach an older
 * occurrence that is still open.
 */
function SeriesSection({
  client,
  series,
  currentId,
  onOpenTask,
  onChanged,
  onFailure,
}: {
  client: ApiClient;
  series: TaskSeriesDetailResponse;
  currentId: string;
  onOpenTask: (taskId: string) => void;
  onChanged: () => void;
  onFailure: (failure: string) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [cron, setCron] = useState(series.cron);
  const [timezone, setTimezone] = useState(series.timezone);
  const [endsOn, setEndsOn] = useState<string | null>(series.endsOn);
  const save = async (body: Parameters<typeof updateTaskSeries>[2]) => {
    try {
      await updateTaskSeries(client, series.id, body);
      setEditing(false);
      onChanged();
    } catch (error) {
      onFailure(workFailureText(failureOf(error)));
    }
  };
  return (
    <Section title={t('work.taskDetailsPane.repeats')}>
      <p className="flex items-center gap-1.5 text-[13px]">
        <IconRepeat className="size-3.5 text-muted" stroke={1.8} />
        {series.enabled ? describeSchedule(series.cron) : t('work.taskDetailsPane.stopped')}
        {series.enabled ? (
          <span className="text-[11px] text-muted">({series.timezone})</span>
        ) : null}
      </p>
      {editing ? (
        <div className="flex flex-col gap-3 rounded-[10px] bg-background-secondary/50 p-3">
          <ScheduleField
            cron={cron}
            timezone={timezone}
            endsOn={endsOn}
            onCronChange={setCron}
            onEndsChange={setEndsOn}
          />
          <TimezonePicker value={timezone} onChange={setTimezone} />
          <EndsField endsOn={endsOn} timezone={timezone} onChange={setEndsOn} />
          <p className="text-[11px] text-muted">
            {t('work.taskDetailsPane.changesApplyToFutureCopies')}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="tertiary"
              size="sm"
              onPress={() => setEditing(false)}
              className="h-7 rounded-lg text-[12px]"
            >
              {t('work.goalsView.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onPress={() => void save({ cron, timezone, endsOn, enabled: true })}
              className="h-7 rounded-lg text-[12px]"
            >
              {t('work.messageWorkDialogs.save')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onPress={() => setEditing(true)}
            className="h-7 rounded-lg text-[12px]"
          >
            {t('work.taskDetailsPane.editSchedule')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onPress={() => void save({ enabled: !series.enabled })}
            className="h-7 rounded-lg text-[12px]"
          >
            {series.enabled
              ? t('work.taskDetailsPane.stopRepeating')
              : t('work.taskDetailsPane.resume')}
          </Button>
        </div>
      )}
      <ul className="flex flex-col gap-0.5">
        {series.occurrences.slice(0, 10).map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onOpenTask(row.id)}
              aria-current={row.id === currentId ? 'true' : undefined}
              className={`flex w-full items-center justify-between rounded-md px-1.5 py-1 text-start text-[12px] hover:bg-background-secondary/60 ${
                row.id === currentId ? 'bg-background-secondary/60' : ''
              }`}
            >
              <span>{row.occursOn === null ? '' : shortDate(row.occursOn)}</span>
              <span
                className={
                  row.status === 'DONE' ? 'text-success' : row.status === 'TODO' ? 'text-muted' : ''
                }
              >
                {STATUS_LABELS[row.status]}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
