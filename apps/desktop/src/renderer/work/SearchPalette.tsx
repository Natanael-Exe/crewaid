import { Modal, ToggleButton, ToggleButtonGroup, useOverlayState } from '@heroui/react';
import {
  IconChecklist,
  IconFileText,
  IconFolder,
  IconMessage,
  IconSearch,
  IconTarget,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { BotWithSandbox, ProjectWithCounts, SearchResponse } from '@crewaid/shared';
import { failureOf, isAbortError } from '../api';
import type { ApiClient } from '../api/apiClient';
import { searchEverything } from '../api/work';
import { BotAvatar } from '../components/BotAvatar';
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
 * Search everything: one query over the user's tasks,
 * goals, projects, deliverables and every transcript, grouped by type with
 * the server's excerpts. Choosing a hit jumps there — a message opens its
 * transcript around it.
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
  const overlay = useOverlayState({ isOpen, onOpenChange });
  const [query, setQuery] = useState(initialQuery);
  const [tab, setTab] = useState<SearchTab>('all');
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const setMotionOrigin = useCallback((node: HTMLElement | null) => {
    if (node === null) return;
    const trigger = document.querySelector('.crewaid-search-trigger');
    const bounds = trigger?.getBoundingClientRect();
    if (bounds === undefined) return;
    // The input settles at the viewport center, 10vh below the title bar.
    // Capture the trigger once so the exit follows the same path, without
    // moving the underlying room or changing noVNC's measured geometry.
    const container = node.closest<HTMLElement>('.crewaid-search-container');
    container?.style.setProperty(
      '--search-origin-x',
      `${bounds.x + bounds.width / 2 - window.innerWidth / 2}px`,
    );
    container?.style.setProperty(
      '--search-origin-y',
      `${bounds.y + bounds.height / 2 - window.innerHeight * 0.1 - 26}px`,
    );
  }, []);

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

  const botById = new Map(bots.map((bot) => [bot.id, bot]));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const choose = (target: SearchTarget) => {
    onOpenChange(false);
    onChoose(target);
  };

  return (
    <Modal state={overlay}>
      <Modal.Backdrop className="crewaid-search-backdrop">
        <Modal.Container
          size="lg"
          placement="top"
          className="crewaid-search-container"
          scroll="inside"
        >
          <Modal.Dialog
            aria-label={t('work.searchPalette.searchEverything')}
            className="crewaid-search-dialog flex max-h-[72vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-card bg-surface p-0"
          >
            <div
              ref={setMotionOrigin}
              className="flex items-center gap-2 border-b border-separator px-4 py-3"
            >
              <IconSearch className="size-4 shrink-0 text-muted" stroke={1.8} />
              <input
                aria-label={t('work.searchPalette.searchEverything')}
                autoFocus
                value={query}
                placeholder={t('work.searchPalette.searchTasksGoalsFilesAnd')}
                onChange={(event) => setQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted"
              />
              <ToggleButtonGroup
                aria-label={t('work.searchPalette.searchIn')}
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={new Set([tab])}
                onSelectionChange={(keys) => {
                  const [key] = [...keys];
                  if (key === 'all' || key === 'tasks' || key === 'files' || key === 'chat')
                    setTab(key);
                }}
                size="sm"
              >
                {SEARCH_TABS.map((option) => (
                  <ToggleButton key={option.id} id={option.id} className="text-[12px]!">
                    {option.label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {failure !== null ? (
                <p role="alert" className="px-3 py-4 text-[13px] text-danger">
                  {failure}
                </p>
              ) : results === null ? (
                <p className="px-3 py-4 text-[13px] text-muted">
                  {t('work.searchPalette.typeToSearch')}
                </p>
              ) : hitCount(results) === 0 ? (
                <p className="px-3 py-4 text-[13px] text-muted">
                  {t('work.search.nothingFound', { query: query.trim() })}
                </p>
              ) : (
                <SearchResults
                  results={results}
                  botById={botById}
                  projectById={projectById}
                  onChoose={choose}
                />
              )}
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
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
  return (
    <div className="flex flex-col gap-3">
      <Group
        title={t('work.goalDetailsPane.deliverables')}
        hidden={results.deliverables.length === 0}
      >
        {results.deliverables.map((hit) => (
          <Hit
            key={hit.id}
            icon={<IconFileText className="size-4 text-muted" stroke={1.8} />}
            title={hit.title}
            meta={[
              hit.botId === null ? null : (botById.get(hit.botId)?.name ?? null),
              hit.createdAt.toLocaleDateString(currentLocale(), { month: 'short', day: 'numeric' }),
              hit.projectId === null ? null : (projectById.get(hit.projectId)?.name ?? null),
            ]}
            excerpt={hit.excerpt}
            onPress={() =>
              onChoose({
                kind: 'deliverable',
                id: hit.id,
                botId: hit.botId,
                taskId: hit.taskId,
                goalId: hit.goalId,
              })
            }
          />
        ))}
      </Group>
      <Group title={t('work.botTasksSection.tasks')} hidden={results.tasks.length === 0}>
        {results.tasks.map((hit) => (
          <Hit
            key={hit.id}
            icon={<IconChecklist className="size-4 text-muted" stroke={1.8} />}
            title={hit.title}
            meta={[
              hit.assigneeBotId === null ? null : (botById.get(hit.assigneeBotId)?.name ?? null),
              STATUS_LABELS[hit.status],
            ]}
            excerpt={hit.excerpt}
            onPress={() => onChoose({ kind: 'task', id: hit.id })}
          />
        ))}
      </Group>
      <Group title={t('work.searchPalette.conversations')} hidden={results.messages.length === 0}>
        {results.messages.map((hit) => {
          const bot = botById.get(hit.botId);
          return (
            <Hit
              key={hit.id}
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
              onPress={() => onChoose({ kind: 'message', id: hit.id, botId: hit.botId })}
            />
          );
        })}
      </Group>
      <Group title={t('work.searchPalette.goals')} hidden={results.goals.length === 0}>
        {results.goals.map((hit) => (
          <Hit
            key={hit.id}
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
            onPress={() => onChoose({ kind: 'goal', id: hit.id })}
          />
        ))}
      </Group>
      <Group title={t('work.projectDialogs.projects')} hidden={results.projects.length === 0}>
        {results.projects.map((hit) => (
          <Hit
            key={hit.id}
            icon={<IconFolder className="size-4" stroke={1.8} style={{ color: hit.color }} />}
            title={hit.name}
            meta={[hit.status === 'ARCHIVED' ? t('work.searchPalette.archived') : null]}
            excerpt={null}
            onPress={() => onChoose({ kind: 'project', id: hit.id })}
          />
        ))}
      </Group>
    </div>
  );
}

function Group({
  title,
  hidden,
  children,
}: {
  title: string;
  hidden: boolean;
  children: ReactNode;
}) {
  if (hidden) return null;
  return (
    <section aria-label={title} className="flex flex-col">
      <h3 className="px-3 pb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Hit({
  icon,
  title,
  meta,
  excerpt,
  onPress,
}: {
  icon: ReactNode;
  title: string;
  meta: readonly (string | null)[];
  excerpt: string | null;
  onPress: () => void;
}) {
  const details = meta.filter((part): part is string => part !== null);
  return (
    <button
      type="button"
      onClick={onPress}
      className="flex items-start gap-2.5 rounded-lg px-3 py-2 text-start outline-none hover:bg-background-secondary focus-visible:bg-background-secondary"
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px]! font-medium text-foreground">{title}</span>
          {details.length === 0 ? null : (
            <span className="shrink-0 text-[11px]! text-muted">{details.join(' · ')}</span>
          )}
        </span>
        {excerpt === null ? null : (
          <span className="mt-0.5 line-clamp-2 block text-[12px]! leading-[17px] text-muted">
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
    </button>
  );
}
