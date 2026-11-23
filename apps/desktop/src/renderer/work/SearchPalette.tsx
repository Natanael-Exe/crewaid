import { Alert } from '@heroui/react';
import {
  IconChecklist,
  IconFileText,
  IconFolder,
  IconMessage,
  IconSearch,
  IconSearchOff,
  IconTarget,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BotWithSandbox, ProjectWithCounts, SearchResponse } from '@crewaid/shared';
import { failureOf, isAbortError } from '../api';
import type { ApiClient } from '../api/apiClient';
import { searchEverything } from '../api/work';
import { BotAvatar } from '../components/BotAvatar';
import { Command, EmptyState, Segment } from '../components/ui';
import { STATUS_LABELS } from './boardState';
import { excerptParts, hitCount, SEARCH_TABS, typesOf, type SearchTab } from './searchState';
import { workFailureText } from './workErrors';
import { useT, currentLocale } from '../i18n/i18n';

/** Where a chosen hit goes. The shell decides how to get there. */
export type SearchTarget =
  | { readonly kind: 'task'; readonly id: string }
  | { readonly kind: 'goal'; readonly id: string }
  | { readonly kind: 'project'; readonly id: string }
  | {
      readonly kind: 'deliverable';
      readonly id: string;
      readonly botId: string | null;
      readonly taskId: string | null;
      readonly goalId: string | null;
    }
  | { readonly kind: 'message'; readonly id: string; readonly botId: string };

/** How long typing settles before the next query goes out. */
const DEBOUNCE_MS = 180;

/**
 * Search everything: the Command palette with Arrow/Enter/Escape navigation,
 * a Segment to narrow the scope, and debounced server-side search.
 */
export function SearchPalette({
  isOpen,
  onOpenChange,
  client,
  initialQuery,
  bots,
  projects,
  onChoose,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  client: ApiClient;
  initialQuery: string;
  bots: readonly BotWithSandbox[];
  projects: readonly ProjectWithCounts[];
  onChoose: (target: SearchTarget) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState(initialQuery);
  const [tab, setTab] = useState<SearchTab>('all');
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) setQuery(initialQuery);
  }, [isOpen, initialQuery]);

  useEffect(() => {
    if (!isOpen) return;
    const q = query.trim();
    if (q === '') {
      setResults(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const types = typesOf(tab);
      searchEverything(client, q, {
        ...(types !== undefined && { types }),
        signal: controller.signal,
      })
        .then((response) => {
          setResults(response);
          setFailure(null);
        })
        .catch((error: unknown) => {
          if (!isAbortError(error)) setFailure(workFailureText(failureOf(error)));
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, query, tab, isOpen]);

  const botById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const choose = (target: SearchTarget) => {
    onOpenChange(false);
    onChoose(target);
  };

  return (
    <Command.Root>
      <Command.Backdrop
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        className="crewaid-search-backdrop"
      >
        <Command.Container className="crewaid-search-container">
          <Command.Dialog
            aria-label={t('work.searchPalette.searchEverything')}
            inputValue={query}
            onInputChange={setQuery}
            // Server already performs full-text matching; let every returned hit render.
            filter={() => true}
            className="crewaid-search-dialog"
          >
            <Command.InputGroup
              aria-label={t('work.searchPalette.searchEverything')}
              className="gap-2 border-b border-separator px-4 py-3"
            >
              <Command.InputGroupPrefix>
                <IconSearch className="size-4 text-muted" stroke={1.8} aria-hidden />
              </Command.InputGroupPrefix>
              <Command.InputGroupInput
                aria-label={t('work.searchPalette.searchEverything')}
                placeholder={t('work.searchPalette.searchTasksGoalsFilesAnd')}
                className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted"
              />
              <Command.InputGroupSuffix className="flex items-center gap-1.5">
                {query !== '' ? <Command.InputGroupClearButton /> : null}
                <Segment.Root
                  aria-label={t('work.searchPalette.searchIn')}
                  size="sm"
                  selectedKey={tab}
                  onSelectionChange={(key) => {
                    if (key === 'all' || key === 'tasks' || key === 'files' || key === 'chat')
                      setTab(key);
                  }}
                >
                  {SEARCH_TABS.map((option) => (
                    <Segment.Item key={option.id} id={option.id} className="text-caption">
                      {option.label}
                    </Segment.Item>
                  ))}
                </Segment.Root>
              </Command.InputGroupSuffix>
            </Command.InputGroup>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {failure !== null ? (
                <Alert status="danger" role="alert" className="m-2 text-footnote">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{failure}</Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : results === null ? (
                <EmptyState size="sm" className="py-10">
                  <EmptyState.Header>
                    <EmptyState.Media variant="icon">
                      <IconSearch
                        className="size-5 text-foreground-faint"
                        stroke={1.6}
                        aria-hidden
                      />
                    </EmptyState.Media>
                    <EmptyState.Description>
                      {t('work.searchPalette.typeToSearch')}
                    </EmptyState.Description>
                  </EmptyState.Header>
                </EmptyState>
              ) : hitCount(results) === 0 ? (
                <EmptyState size="sm" className="py-10">
                  <EmptyState.Header>
                    <EmptyState.Media variant="icon">
                      <IconSearchOff
                        className="size-5 text-foreground-faint"
                        stroke={1.6}
                        aria-hidden
                      />
                    </EmptyState.Media>
                    <EmptyState.Description>
                      {t('work.search.nothingFound', { query: query.trim() })}
                    </EmptyState.Description>
                  </EmptyState.Header>
                </EmptyState>
              ) : (
                <SearchResults
                  results={results}
                  botById={botById}
                  projectById={projectById}
                  onChoose={choose}
                />
              )}
            </div>
          </Command.Dialog>
        </Command.Container>
      </Command.Backdrop>
    </Command.Root>
  );
}

export function SearchResults({
  results,
  botById,
  projectById,
  onChoose,
}: {
  results: SearchResponse;
  botById: ReadonlyMap<string, BotWithSandbox>;
  projectById: ReadonlyMap<string, ProjectWithCounts>;
  onChoose: (target: SearchTarget) => void;
}) {
  const t = useT();
  const targetByKey = new Map<string, SearchTarget>();
  for (const hit of results.deliverables) {
    targetByKey.set(`deliverable:${hit.id}`, {
      kind: 'deliverable',
      id: hit.id,
      botId: hit.botId,
      taskId: hit.taskId,
      goalId: hit.goalId,
    });
  }
  for (const hit of results.tasks) targetByKey.set(`task:${hit.id}`, { kind: 'task', id: hit.id });
  for (const hit of results.messages)
    targetByKey.set(`message:${hit.id}`, { kind: 'message', id: hit.id, botId: hit.botId });
  for (const hit of results.goals) targetByKey.set(`goal:${hit.id}`, { kind: 'goal', id: hit.id });
  for (const hit of results.projects)
    targetByKey.set(`project:${hit.id}`, { kind: 'project', id: hit.id });

  return (
    <Command.List
      aria-label={t('work.searchPalette.searchEverything')}
      onAction={(key) => {
        const target = targetByKey.get(String(key));
        if (target !== undefined) onChoose(target);
      }}
      className="flex flex-col gap-2"
    >
      {results.deliverables.length > 0 ? (
        <Command.Group
          aria-label={t('work.goalDetailsPane.deliverables')}
          heading={t('work.goalDetailsPane.deliverables')}
        >
          {results.deliverables.map((hit) => (
            <Hit
              key={hit.id}
              id={`deliverable:${hit.id}`}
              icon={<IconFileText className="size-4 text-muted" stroke={1.8} />}
              title={hit.title}
              meta={[
                hit.botId === null ? null : (botById.get(hit.botId)?.name ?? null),
                hit.createdAt.toLocaleDateString(currentLocale(), {
                  month: 'short',
                  day: 'numeric',
                }),
                hit.projectId === null ? null : (projectById.get(hit.projectId)?.name ?? null),
              ]}
              excerpt={hit.excerpt}
            />
          ))}
        </Command.Group>
      ) : null}
      {results.tasks.length > 0 ? (
        <Command.Group
          aria-label={t('work.botTasksSection.tasks')}
          heading={t('work.botTasksSection.tasks')}
        >
          {results.tasks.map((hit) => (
            <Hit
              key={hit.id}
              id={`task:${hit.id}`}
              icon={<IconChecklist className="size-4 text-muted" stroke={1.8} />}
              title={hit.title}
              meta={[
                hit.assigneeBotId === null ? null : (botById.get(hit.assigneeBotId)?.name ?? null),
                STATUS_LABELS[hit.status],
              ]}
              excerpt={hit.excerpt}
            />
          ))}
        </Command.Group>
      ) : null}
      {results.messages.length > 0 ? (
        <Command.Group
          aria-label={t('work.searchPalette.conversations')}
          heading={t('work.searchPalette.conversations')}
        >
          {results.messages.map((hit) => {
            const bot = botById.get(hit.botId);
            return (
              <Hit
                key={hit.id}
                id={`message:${hit.id}`}
                icon={
                  bot === undefined ? (
                    <IconMessage className="size-4 text-muted" stroke={1.8} />
                  ) : (
                    <BotAvatar bot={bot} size="sm" />
                  )
                }
                title={bot?.name ?? t('work.searchPalette.aBot')}
                meta={[
                  hit.createdAt.toLocaleDateString(currentLocale(), {
                    month: 'short',
                    day: 'numeric',
                  }),
                  hit.author === 'USER' ? t('work.tasksView.you') : null,
                ]}
                excerpt={hit.excerpt}
              />
            );
          })}
        </Command.Group>
      ) : null}
      {results.goals.length > 0 ? (
        <Command.Group
          aria-label={t('work.searchPalette.goals')}
          heading={t('work.searchPalette.goals')}
        >
          {results.goals.map((hit) => (
            <Hit
              key={hit.id}
              id={`goal:${hit.id}`}
              icon={<IconTarget className="size-4 text-muted" stroke={1.8} />}
              title={hit.title}
              meta={[
                hit.status === 'ACTIVE'
                  ? null
                  : hit.status === 'ACHIEVED'
                    ? t('work.goalDetailsPane.achieved')
                    : t('work.goalDetailsPane.abandoned'),
              ]}
              excerpt={hit.excerpt}
            />
          ))}
        </Command.Group>
      ) : null}
      {results.projects.length > 0 ? (
        <Command.Group
          aria-label={t('work.projectDialogs.projects')}
          heading={t('work.projectDialogs.projects')}
        >
          {results.projects.map((hit) => (
            <Hit
              key={hit.id}
              id={`project:${hit.id}`}
              icon={<IconFolder className="size-4" stroke={1.8} style={{ color: hit.color }} />}
              title={hit.name}
              meta={[hit.status === 'ARCHIVED' ? t('work.searchPalette.archived') : null]}
              excerpt={null}
            />
          ))}
        </Command.Group>
      ) : null}
    </Command.List>
  );
}

function Hit({
  id,
  icon,
  title,
  meta,
  excerpt,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  meta: readonly (string | null)[];
  excerpt: string | null;
}) {
  const details = meta.filter((part): part is string => part !== null);
  return (
    <Command.Item id={id} textValue={title} className="items-start gap-2.5 rounded-lg px-3 py-2">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-footnote font-medium text-foreground">{title}</span>
          {details.length === 0 ? null : (
            <span className="shrink-0 text-micro tabular-nums text-muted">
              {details.join(' · ')}
            </span>
          )}
        </span>
        {excerpt === null ? null : (
          <span className="mt-0.5 line-clamp-2 block text-caption leading-[17px] text-muted">
            {excerptParts(excerpt).map((part, index) =>
              part.match ? (
                <mark key={index} className="rounded-sm bg-warning/25 px-0.5 text-foreground">
                  {part.text}
                </mark>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
          </span>
        )}
      </span>
    </Command.Item>
  );
}
