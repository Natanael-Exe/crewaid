import { Button, Chip } from '@heroui/react';
import { IconChecklist, IconFile, IconLink, IconMessage, IconTarget } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import type {
  BotWithSandbox,
  DeliverableView,
  GoalWithProgress,
  ProjectWithCounts,
} from '@crewaid/shared';
import { failureOf } from '../api';
import type { ApiClient } from '../api/apiClient';
import { listDeliverables, listGoals } from '../api/work';
import { fileMark } from '../components/attachments/artifactMarks';
import { artifactIdentity } from '../components/attachments/artifactIdentity';
import { BotAvatar } from '../components/BotAvatar';
import { byteSize } from './deliverablesState';
import { FilterMenu, projectFilterField, type FilterField, type ProjectFilter } from './FilterMenu';
import { ViewSearch } from './ViewSearch';
import { WorkEmptyState, WorkNoMatch } from './WorkPane';
import { workFailureText } from './workErrors';
import { scopeFromKey, scopeKey } from './workState';
import { useT, currentLocale } from '../i18n/i18n';

const PAGE = 50;

/** How long typing settles before the search goes to the server. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * The Deliverables view: everything bots produced, newest
 * first, with who made it and what it is filed under. One filter menu holds
 * the project scope, goal, bot, kind and *Unfiled only*. Selecting
 * one previews it in the rail. Creation, re-filing, edits and deletion all
 * arrive as `deliverable.changed` and refresh the list.
 */
export function DeliverablesView({
  client,
  projectFilter,
  revision,
  bots,
  selectedId,
  onOpen,
  onHeaderActions,
}: {
  client: ApiClient;
  /** The shared project scope, which the filter menu also sets. */
  projectFilter: ProjectFilter;
  revision: number;
  bots: readonly BotWithSandbox[];
  selectedId: string | null;
  onOpen: (deliverable: DeliverableView) => void;
  onHeaderActions: (actions: React.ReactNode) => void;
}) {
  const t = useT();
  const [items, setItems] = useState<readonly DeliverableView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [goals, setGoals] = useState<readonly GoalWithProgress[]>([]);
  const [goalId, setGoalId] = useState<string | null>(null);
  const [botId, setBotId] = useState<string | null>(null);
  const [kind, setKind] = useState<DeliverableView['kind'] | null>(null);
  const [unfiled, setUnfiled] = useState(false);
  const { scope, projects } = projectFilter;
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');

  // The list is paged, so its search runs on the server, once the
  // typing settles rather than per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const [failure, setFailure] = useState<string | null>(null);

  const filter = useMemo(
    () => ({
      ...(scope.kind === 'project' && !unfiled ? { projectId: scope.projectId } : {}),
      ...(goalId !== null && !unfiled ? { goalId } : {}),
      ...(botId !== null ? { botId } : {}),
      ...(kind !== null ? { kind } : {}),
      ...(unfiled || scope.kind === 'inbox' ? { unfiled: true } : {}),
      ...(search !== '' ? { q: search } : {}),
    }),
    [scope, goalId, botId, kind, unfiled, search],
  );

  useEffect(() => {
    let live = true;
    listDeliverables(client, { ...filter, limit: PAGE })
      .then((page) => {
        if (!live) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setTotal(page.total);
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (live) setFailure(workFailureText(failureOf(error)));
      });
    return () => {
      live = false;
    };
  }, [client, filter, revision]);

  useEffect(() => {
    listGoals(client)
      .then(setGoals)
      .catch(() => undefined);
  }, [client]);

  const more = async () => {
    if (cursor === null) return;
    try {
      const page = await listDeliverables(client, { ...filter, before: cursor, limit: PAGE });
      setItems((current) => [...(current ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      setFailure(workFailureText(failureOf(error)));
    }
  };

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
        label: t('work.deliverablesView.madeBy'),
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
        key: 'kind',
        label: t('work.deliverablesView.kind'),
        noneLabel: t('work.deliverablesView.anyKind'),
        defaultValue: null,
        options: [
          { id: 'FILE', label: t('work.deliverablesView.files') },
          { id: 'LINK', label: t('work.deliverablesView.links') },
          { id: 'MESSAGE', label: t('work.deliverablesView.messages') },
        ],
      },
      {
        kind: 'toggle',
        key: 'unfiled',
        label: t('work.deliverablesView.unfiledOnly'),
        defaultValue: false,
      },
    ],
    [projectFilter, goals, bots],
  );

  const actions = useMemo(
    () => (
      <>
        {/* Keyed: the views share one header slot, and without a key the next
            view would inherit this one's open field. */}
        <ViewSearch
          key="deliverables"
          label={t('work.deliverablesView.searchDeliverables')}
          placeholder={t('work.deliverablesView.searchDeliverablesByNameOr')}
          value={query}
          onChange={setQuery}
        />
        <FilterMenu
          fields={fields}
          values={{ project: scopeKey(scope), goal: goalId, bot: botId, kind, unfiled }}
          onApply={(values) => {
            projectFilter.onScopeChange(scopeFromKey(String(values['project'])));
            setGoalId((values['goal'] as string | null) ?? null);
            setBotId((values['bot'] as string | null) ?? null);
            setKind((values['kind'] as DeliverableView['kind'] | null) ?? null);
            setUnfiled(values['unfiled'] === true);
          }}
        />
      </>
    ),
    [fields, projectFilter, scope, goalId, botId, kind, unfiled, query],
  );
  useEffect(() => onHeaderActions(actions), [actions, onHeaderActions]);

  const botById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  if (items === null) {
    return failure === null ? null : (
      <p role="alert" className="p-6 text-footnote text-danger">
        {failure}
      </p>
    );
  }
  const filtered =
    goalId !== null ||
    botId !== null ||
    kind !== null ||
    unfiled ||
    scope.kind !== 'all' ||
    search !== '';
  if (items.length === 0) {
    return filtered ? <WorkNoMatch query={search} /> : <WorkEmptyState view="deliverables" />;
  }

  return (
    <div className="mx-auto grid w-full max-w-[1160px] grid-cols-1 gap-3 px-4 py-3 md:grid-cols-2 xl:grid-cols-3">
      <span className="col-span-full px-2 pb-1 text-micro tabular-nums text-muted">
        {t('work.deliverables.count', { count: total })}
      </span>
      {items.map((item) => (
        <DeliverableRow
          key={item.id}
          item={item}
          bot={item.botId === null ? undefined : botById.get(item.botId)}
          project={item.projectId === null ? undefined : projectById.get(item.projectId)}
          selected={selectedId === item.id}
          onOpen={() => onOpen(item)}
        />
      ))}
      {cursor === null ? null : (
        <div className="col-span-full flex justify-center pt-1">
          <Button
            variant="ghost"
            size="sm"
            onPress={() => void more()}
            className="h-8 rounded-[10px] text-caption"
          >
            {t('work.deliverablesView.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}

function kindIcon(item: DeliverableView) {
  if (item.kind === 'LINK') return IconLink;
  if (item.kind === 'MESSAGE') return IconMessage;
  return item.attachment === null ? IconFile : artifactIdentity(item.attachment).Icon;
}

export function DeliverableRow({
  item,
  bot,
  project,
  selected,
  onOpen,
}: {
  item: DeliverableView;
  bot: BotWithSandbox | undefined;
  project: ProjectWithCounts | undefined;
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const Glyph = kindIcon(item);
  const mark = item.attachment === null ? undefined : fileMark(item.attachment);
  const typeLabel =
    item.kind === 'FILE' && item.attachment !== null
      ? artifactIdentity(item.attachment).label
      : item.kind === 'LINK'
        ? t('work.deliverablesView.link')
        : t('work.deliverablesView.message');
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      className={`crewaid-deliverable-row flex cursor-[var(--cursor-interactive)] items-start gap-3 rounded-[10px] px-2 py-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-focus/40 ${
        selected ? 'bg-background-tertiary' : 'hover:bg-background-secondary'
      }`}
    >
      <span className={mark === undefined ? 'crewaid-tool-icon' : 'crewaid-tool-mark'}>
        {mark === undefined ? (
          <Glyph aria-hidden className="size-5" stroke={1.6} />
        ) : (
          <img src={mark} alt="" aria-hidden className="size-8 object-contain" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="mb-1 block text-micro text-muted">{typeLabel}</span>
        <span className="block truncate text-footnote font-medium text-foreground">
          {item.title}
        </span>
        {item.summary === null ? null : (
          <span className="mt-1 line-clamp-2 block text-caption leading-5 text-muted">
            {item.summary}
          </span>
        )}
        <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-micro text-muted">
          {bot === undefined ? null : (
            <span className="flex items-center gap-1">
              <BotAvatar bot={bot} size="sm" />
              {bot.name}
            </span>
          )}
          <span className="tabular-nums">
            {item.createdAt.toLocaleDateString(currentLocale(), { month: 'short', day: 'numeric' })}
          </span>
          {item.attachment === null ? null : (
            <span className="tabular-nums">{byteSize(item.attachment.sizeBytes)}</span>
          )}
          {item.task === null ? null : (
            <Chip size="sm" variant="soft" className="h-5 gap-1 px-1.5 text-micro">
              <IconChecklist className="size-3 shrink-0" stroke={1.8} aria-hidden />
              <Chip.Label className="max-w-[140px] truncate">{item.task.title}</Chip.Label>
            </Chip>
          )}
          {item.goal === null ? null : (
            <Chip size="sm" variant="soft" className="h-5 gap-1 px-1.5 text-micro">
              <IconTarget className="size-3 shrink-0" stroke={1.8} aria-hidden />
              <Chip.Label className="max-w-[140px] truncate">{item.goal.title}</Chip.Label>
            </Chip>
          )}
          {project === undefined ? null : (
            <span className="flex items-center gap-1">
              <span className="size-1.5 rounded-full" style={{ backgroundColor: project.color }} />
              {project.name}
            </span>
          )}
          {item.taskId === null && item.goalId === null && item.projectId === null ? (
            <span className="text-foreground-faint">{t('work.deliverablesView.unfiled')}</span>
          ) : null}
        </span>
      </span>
    </button>
  );
}
