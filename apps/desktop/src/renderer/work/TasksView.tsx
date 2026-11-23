import { Button, Input, Tooltip } from '@heroui/react';
import { IconLayoutKanban, IconList, IconPlus } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import {
  TaskStatusSchema,
  type BotWithSandbox,
  type GoalWithProgress,
  type ProjectWithCounts,
  type TaskCard,
  type TaskStatus,
} from '@crewaid/shared';
import { failureOf } from '../api';
import type { ApiClient } from '../api/apiClient';
import { createTask, listGoals, listTasks, updateTask } from '../api/work';
import { BotAvatar } from '../components/BotAvatar';
import { Kanban, Segment } from '../components/ui';
import {
  BOARD_COLUMNS,
  STATUS_LABELS,
  collapseSeries,
  columnCards,
  doneSince,
  isOverdue,
  lanes,
  localToday,
  rankForDrop,
  shortDate,
  type GroupBy,
} from './boardState';
import { FilterMenu, projectFilterField, type FilterField, type ProjectFilter } from './FilterMenu';
import { NewTaskDialog } from './NewTaskDialog';
import { TaskCardView } from './TaskCardView';
import { ViewSearch } from './ViewSearch';
import { WorkEmptyState, WorkNoMatch } from './WorkPane';
import { workFailureText } from './workErrors';
import { matchesQuery, scopeFromKey, scopeKey, scopeTaskFilter } from './workState';
import { useT } from '../i18n/i18n';

type Layout = 'board' | 'list';

/** Every status, in the order the board reads them, for the Status filter. */
const TASK_STATUSES = TaskStatusSchema.options;

/**
 * The Tasks view: a board with a column per status, or a
 * dense list. One filter menu holds the project scope, goal, bot, status and
 * the board's grouping — by status, by bot ("who is doing what") or by
 * project — and applies them together.
 *
 * Dragging a card changes its status and its place, and nothing else — it
 * starts nothing. Every number on a card is the server's; the view
 * re-reads when a `task.changed` frame moves `revision`.
 */
export function TasksView({
  client,
  projectFilter,
  revision,
  bots,
  selectedTaskId,
  onOpenTask,
  onHeaderActions,
  initialBotId = null,
}: {
  client: ApiClient;
  /** The shared project scope, which the filter menu also sets. */
  projectFilter: ProjectFilter;
  /** `work.tasks` from the reducer: moves on every relevant frame. */
  revision: number;
  bots: readonly BotWithSandbox[];
  selectedTaskId: string | null;
  onOpenTask: (taskId: string) => void;
  /** The view's own header controls, rendered by the shell beside its title. */
  onHeaderActions: (actions: React.ReactNode) => void;
  /** Opened from a bot's rail: the board starts filtered to that bot. */
  initialBotId?: string | null;
}) {
  const t = useT();
  const [layout, setLayout] = useState<Layout>('board');
  const [groupBy, setGroupBy] = useState<GroupBy>('status');
  const [goalId, setGoalId] = useState<string | null>(null);
  const [botId, setBotId] = useState<string | null>(initialBotId);
  const [status, setStatus] = useState<TaskStatus | null>(null);
  const { scope, projects } = projectFilter;
  const [showAllDone, setShowAllDone] = useState(false);
  const [query, setQuery] = useState('');
  const search = query.trim();
  // A search reaches past the Done window: an old finished task is exactly
  // the kind of thing someone searches for.
  const doneWindow = !showAllDone && search === '';
  const [cards, setCards] = useState<readonly TaskCard[] | null>(null);
  const [goals, setGoals] = useState<readonly GoalWithProgress[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let live = true;
    listTasks(client, {
      ...scopeTaskFilter(scope),
      ...(goalId !== null && { goalId }),
      ...(botId !== null && { assigneeBotId: botId }),
      ...(status !== null && { status: [status] }),
      ...(doneWindow && { doneSince: doneSince(new Date()) }),
    })
      .then((rows) => {
        if (!live) return;
        setCards(rows);
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (live) setFailure(workFailureText(failureOf(error)));
      });
    return () => {
      live = false;
    };
  }, [client, scope, goalId, botId, status, doneWindow, revision, nonce]);

  useEffect(() => {
    let live = true;
    listGoals(client, { status: 'ACTIVE' })
      .then((rows) => {
        if (live) setGoals(rows);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, revision]);

  const botById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const projectById = useMemo(() => new Map(projects.map((row) => [row.id, row])), [projects]);
  const today = localToday();

  const move = useCallback(
    async (card: TaskCard, status: TaskStatus, rank: string) => {
      // Optimistic: the card lands where it was dropped at once, and the
      // server's answer — or the frame after it — settles the rest.
      setCards((current) =>
        current === null
          ? current
          : current.map((row) => (row.id === card.id ? { ...row, status, rank } : row)),
      );
      try {
        await updateTask(client, card.id, { status, rank });
      } catch (error) {
        setFailure(workFailureText(failureOf(error)));
        reload();
      }
    },
    [client, reload],
  );

  const quickAdd = useCallback(
    async (title: string) => {
      const filter = scopeTaskFilter(scope);
      try {
        await createTask(client, {
          title,
          ...(filter.projectId !== undefined && { projectId: filter.projectId }),
          ...(goalId !== null && { goalId }),
          ...(botId !== null && { assigneeBotId: botId }),
        });
        reload();
      } catch (error) {
        setFailure(workFailureText(failureOf(error)));
      }
    },
    [client, scope, goalId, botId, reload],
  );

  const fields = useMemo<FilterField[]>(
    () => [
      projectFilterField(projectFilter),
      {
        kind: 'select',
        key: 'goal',
        label: t('work.deliverablePane.goal'),
        noneLabel: t('work.deliverablesView.anyGoal'),
        defaultValue: null,
        options: goals.map((goal) => ({ id: goal.id, label: goal.title })),
      },
      {
        kind: 'select',
        key: 'bot',
        label: t('work.newTaskDialog.assignee'),
        noneLabel: t('work.deliverablesView.anyBot'),
        defaultValue: null,
        options: bots.map((bot) => ({
          id: bot.id,
          label: bot.name,
          adornment: <BotAvatar bot={bot} size="sm" />,
        })),
      },
      {
        kind: 'select',
        key: 'status',
        label: t('work.taskDetailsPane.status'),
        noneLabel: t('work.goalsView.anyStatus'),
        defaultValue: null,
        options: TASK_STATUSES.map((value) => ({ id: value, label: STATUS_LABELS[value] })),
      },
      // Grouping only shapes the board; the list is one flat table.
      ...(layout === 'board'
        ? [
            {
              kind: 'select',
              key: 'groupBy',
              label: t('work.tasksView.groupBoardBy'),
              defaultValue: 'status',
              options: [
                { id: 'status', label: t('work.taskDetailsPane.status') },
                { id: 'bot', label: t('work.tasksView.bot') },
                { id: 'project', label: t('work.deliverablePane.project') },
              ],
            } satisfies FilterField,
          ]
        : []),
    ],
    [projectFilter, goals, bots, layout],
  );

  const actions = useMemo(
    () => (
      <>
        {/* Keyed: the views share one header slot, and without a key the next
            view would inherit this one's open field. */}
        <ViewSearch
          key="tasks"
          label={t('work.tasksView.searchTasks')}
          placeholder={t('work.tasksView.searchTasksByNameOr')}
          value={query}
          onChange={setQuery}
        />
        <FilterMenu
          fields={fields}
          values={{
            project: scopeKey(scope),
            goal: goalId,
            bot: botId,
            status,
            groupBy,
          }}
          onApply={(values) => {
            projectFilter.onScopeChange(scopeFromKey(String(values['project'])));
            setGoalId((values['goal'] as string | null) ?? null);
            setBotId((values['bot'] as string | null) ?? null);
            setStatus((values['status'] as TaskStatus | null) ?? null);
            setGroupBy((values['groupBy'] as GroupBy | null) ?? 'status');
          }}
        />
        <Segment.Root
          aria-label={t('work.tasksView.layout')}
          size="sm"
          selectedKey={layout}
          onSelectionChange={(key) => {
            if (key === 'board' || key === 'list') setLayout(key);
          }}
        >
          <Tooltip delay={400}>
            <Segment.Item id="board" aria-label={t('work.tasksView.board')} className="px-2">
              <IconLayoutKanban className="size-4" stroke={1.8} />
            </Segment.Item>
            <Tooltip.Content placement="bottom">{t('work.tasksView.board')}</Tooltip.Content>
          </Tooltip>
          <Tooltip delay={400}>
            <Segment.Item id="list" aria-label={t('work.tasksView.list')} className="px-2">
              <IconList className="size-4" stroke={1.8} />
            </Segment.Item>
            <Tooltip.Content placement="bottom">{t('work.tasksView.list')}</Tooltip.Content>
          </Tooltip>
        </Segment.Root>
        <Button
          variant="primary"
          size="sm"
          onPress={() => setAdding(true)}
          className="h-8 gap-1 rounded-[10px] text-caption font-medium"
        >
          <IconPlus className="size-3.5" stroke={2} />
          {t('work.tasksView.addTask')}
        </Button>
      </>
    ),
    [fields, projectFilter, scope, goalId, botId, status, layout, groupBy, query],
  );
  useEffect(() => onHeaderActions(actions), [actions, onHeaderActions]);

  const dialog = (
    <NewTaskDialog
      isOpen={adding}
      onOpenChange={setAdding}
      client={client}
      bots={bots}
      projects={projects}
      goals={goals}
      defaults={{
        projectId: scope.kind === 'project' ? scope.projectId : null,
        goalId,
        assigneeBotId: botId,
      }}
      onCreated={(taskId) => {
        reload();
        if (taskId !== null) onOpenTask(taskId);
      }}
    />
  );

  if (cards === null) {
    return failure === null ? null : (
      <p role="alert" className="p-6 text-footnote text-danger">
        {failure}
      </p>
    );
  }
  const filtered =
    goalId !== null || botId !== null || status !== null || scope.kind !== 'all' || search !== '';
  if (cards.length === 0 && !filtered) {
    return (
      <>
        <WorkEmptyState
          view="tasks"
          action={
            <Button
              variant="secondary"
              size="sm"
              onPress={() => setAdding(true)}
              className="h-8 rounded-[10px] text-caption"
            >
              {t('work.tasksView.addATask')}
            </Button>
          }
        />
        {dialog}
      </>
    );
  }

  const shown =
    search === '' ? cards : cards.filter((card) => matchesQuery(search, [card.title, card.brief]));
  if (shown.length === 0) {
    return (
      <>
        <WorkNoMatch query={search} />
        {dialog}
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {failure === null ? null : (
        <p
          role="alert"
          className="mx-4 mt-3 rounded-lg bg-danger/10 px-3 py-2 text-caption text-danger"
        >
          {failure}
        </p>
      )}
      {layout === 'board' ? (
        <Board
          cards={collapseSeries(shown)}
          groupBy={groupBy}
          botById={botById}
          projectById={projectById}
          today={today}
          selectedTaskId={selectedTaskId}
          onOpenTask={onOpenTask}
          onMove={(card, status, rank) => void move(card, status, rank)}
          onQuickAdd={(title) => void quickAdd(title)}
          showAllDone={!doneWindow}
          onShowAllDone={() => setShowAllDone(true)}
        />
      ) : (
        <TaskList
          cards={shown}
          botById={botById}
          projectById={projectById}
          today={today}
          selectedTaskId={selectedTaskId}
          onOpenTask={onOpenTask}
        />
      )}
      {dialog}
    </div>
  );
}

export function Board({
  cards,
  groupBy,
  botById,
  projectById,
  today,
  selectedTaskId,
  onOpenTask,
  onMove,
  onQuickAdd,
  showAllDone,
  onShowAllDone,
}: {
  cards: readonly TaskCard[];
  groupBy: GroupBy;
  botById: ReadonlyMap<string, BotWithSandbox>;
  projectById: ReadonlyMap<string, ProjectWithCounts>;
  today: string;
  selectedTaskId: string | null;
  onOpenTask: (taskId: string) => void;
  onMove: (card: TaskCard, status: TaskStatus, rank: string) => void;
  onQuickAdd: (title: string) => void;
  showAllDone: boolean;
  onShowAllDone: () => void;
}) {
  const t = useT();
  const [dragging, setDragging] = useState<TaskCard | null>(null);
  const rows = lanes(cards, groupBy, {
    bot: (id) => botById.get(id)?.name,
    project: (id) => projectById.get(id)?.name,
  });

  const drop =
    (status: TaskStatus, column: readonly TaskCard[], index: number) => (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (dragging === null) return;
      onMove(dragging, status, rankForDrop(column, dragging.id, index));
      setDragging(null);
    };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
      {rows.map((lane, laneIndex) => (
        <section
          key={lane.key}
          aria-label={lane.label || t('work.tasksView.board')}
          className="flex flex-col gap-2"
        >
          {lane.label === '' ? null : (
            <h2 className="flex items-center gap-2 text-caption font-medium text-muted">
              {groupBy === 'bot' && botById.get(lane.key) !== undefined ? (
                <BotAvatar bot={botById.get(lane.key)!} size="sm" />
              ) : null}
              {lane.label}
              <span className="tabular-nums text-foreground-faint">{lane.cards.length}</span>
            </h2>
          )}
          <Kanban.Root className="gap-3">
            {BOARD_COLUMNS.map((status) => {
              const column = columnCards(lane.cards, status);
              return (
                <Kanban.Column
                  key={status}
                  role="list"
                  data-kanban-column={status}
                  aria-label={STATUS_LABELS[status]}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={drop(status, column, column.length)}
                  className="max-w-[320px] min-w-[196px] flex-1 basis-0 gap-2 rounded-card bg-background-secondary/60 p-2"
                >
                  <Kanban.ColumnHeader className="px-1">
                    <Kanban.ColumnTitle className="text-micro font-medium tracking-[0.02em] text-muted">
                      {STATUS_LABELS[status]}
                    </Kanban.ColumnTitle>
                    <Kanban.ColumnCount className="tabular-nums text-foreground-faint">
                      {column.length}
                    </Kanban.ColumnCount>
                  </Kanban.ColumnHeader>
                  <Kanban.ColumnBody className="gap-2">
                    {status === 'TODO' && laneIndex === 0 && groupBy === 'status' ? (
                      <QuickAdd onAdd={onQuickAdd} />
                    ) : null}
                    {column.map((card, index) => (
                      <div
                        key={card.id}
                        role="listitem"
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={drop(status, column, index)}
                        className={dragging?.id === card.id ? 'opacity-40' : ''}
                      >
                        <TaskCardView
                          card={card}
                          assignee={
                            card.assigneeBotId === null
                              ? undefined
                              : botById.get(card.assigneeBotId)
                          }
                          project={
                            card.projectId === null ? undefined : projectById.get(card.projectId)
                          }
                          today={today}
                          selected={selectedTaskId === card.id}
                          onOpen={() => onOpenTask(card.id)}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = 'move';
                            event.dataTransfer.setData('text/plain', card.id);
                            setDragging(card);
                          }}
                        />
                      </div>
                    ))}
                    {status === 'DONE' && !showAllDone && laneIndex === rows.length - 1 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onPress={onShowAllDone}
                        className="h-7 justify-start rounded-lg px-1.5 text-micro text-muted hover:text-foreground"
                      >
                        {t('work.tasksView.showingTheLast14Days')}
                      </Button>
                    ) : null}
                  </Kanban.ColumnBody>
                </Kanban.Column>
              );
            })}
          </Kanban.Root>
        </section>
      ))}
    </div>
  );
}

function QuickAdd({ onAdd }: { onAdd: (title: string) => void }) {
  const t = useT();
  const [title, setTitle] = useState('');
  return (
    <Input
      variant="secondary"
      aria-label={t('work.tasksView.addATask')}
      value={title}
      placeholder={t('work.tasksView.addTask2')}
      onChange={(event) => setTitle(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || title.trim() === '') return;
        onAdd(title.trim());
        setTitle('');
      }}
      className="h-8 w-full bg-surface text-footnote"
    />
  );
}

/**
 * The dense view: every task on its own row, including each occurrence of a
 * recurring task — which is where older unfinished occurrences stay
 * reachable (PRD-WORK §3.6).
 */
export function TaskList({
  cards,
  botById,
  projectById,
  today,
  selectedTaskId,
  onOpenTask,
}: {
  cards: readonly TaskCard[];
  botById: ReadonlyMap<string, BotWithSandbox>;
  projectById: ReadonlyMap<string, ProjectWithCounts>;
  today: string;
  selectedTaskId: string | null;
  onOpenTask: (taskId: string) => void;
}) {
  const t = useT();
  const ordered = BOARD_COLUMNS.flatMap((status) => columnCards(cards, status));
  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
      <table className="w-full border-separate border-spacing-0 text-footnote">
        <thead>
          <tr className="text-start text-micro font-medium text-muted">
            <th className="pb-2 ps-2 font-medium">{t('work.deliverablePane.task')}</th>
            <th className="pb-2 font-medium">{t('work.taskDetailsPane.status')}</th>
            <th className="pb-2 font-medium">{t('work.newTaskDialog.assignee')}</th>
            <th className="pb-2 font-medium">{t('work.deliverablePane.project')}</th>
            <th className="pb-2 font-medium">{t('work.newTaskDialog.due')}</th>
            <th className="pb-2 pe-2 text-end font-medium">{t('work.tasksView.subtasks')}</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((card) => {
            const assignee =
              card.assigneeBotId === null ? undefined : botById.get(card.assigneeBotId);
            const project = card.projectId === null ? undefined : projectById.get(card.projectId);
            return (
              <tr
                key={card.id}
                onClick={() => onOpenTask(card.id)}
                aria-selected={selectedTaskId === card.id}
                className="crewaid-task-row cursor-default"
              >
                <td className="rounded-s-lg py-1.5 ps-2">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenTask(card.id);
                    }}
                    className="text-start outline-none focus-visible:underline"
                  >
                    {card.title}
                  </button>
                  {card.occursOn !== null ? (
                    <span className="ms-2 text-micro tabular-nums text-muted">
                      {shortDate(card.occursOn)}
                    </span>
                  ) : null}
                </td>
                <td className="py-1.5 text-muted">{STATUS_LABELS[card.status]}</td>
                <td className="py-1.5">
                  {assignee === undefined ? (
                    <span className="text-muted">{t('work.tasksView.you')}</span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <BotAvatar bot={assignee} size="sm" />
                      {assignee.name}
                    </span>
                  )}
                </td>
                <td className="py-1.5">
                  {project === undefined ? (
                    <span className="text-muted">{t('work.tasksView.inbox')}</span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: project.color }}
                      />
                      {project.name}
                    </span>
                  )}
                </td>
                <td className={`py-1.5 ${isOverdue(card, today) ? 'text-danger' : 'text-muted'}`}>
                  {card.dueOn === null ? '' : shortDate(card.dueOn)}
                </td>
                <td className="rounded-e-lg py-1.5 pe-2 text-end tabular-nums text-muted">
                  {card.subtasks.total === 0 ? '' : `${card.subtasks.done}/${card.subtasks.total}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
