import { IconChecklist, IconFileStack, IconSearchOff, IconTarget } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { ProjectWithCounts } from '@crewaid/shared';
import { EmptyState } from '../components/ui';
import {
  WORK_VIEW_LABELS,
  WORK_VIEW_PURPOSE,
  scopeLabel,
  type ProjectScope,
  type WorkView,
} from './workState';
import { useT } from '../i18n/i18n';

const VIEW_ICONS = { tasks: IconChecklist, goals: IconTarget, deliverables: IconFileStack };

/**
 * The centre pane when a Work row is selected: the view's name, the
 * project it is narrowed to when it is, and whatever the view renders under
 * them.
 */
export function WorkPane({
  view,
  scope,
  projects,
  actions,
  children,
}: {
  view: WorkView;
  scope: ProjectScope;
  projects: readonly ProjectWithCounts[];
  /** The view's own controls: its filter menu and its actions. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const Glyph = VIEW_ICONS[view];
  return (
    <section
      aria-label={WORK_VIEW_LABELS[view]}
      className="crewaid-work-pane flex h-full min-h-0 flex-col"
    >
      {/* The drag strip the transcript's header also provides, so the window
          still moves by its top edge while a Work view is open. */}
      <header className="window-drag flex h-12 shrink-0 items-center gap-2 border-b border-separator px-4">
        <Glyph className="size-4 shrink-0 text-muted" stroke={1.8} />
        <h1 className="text-footnote font-semibold">{WORK_VIEW_LABELS[view]}</h1>
        <span data-work-scope className="max-w-[220px] truncate text-footnote text-muted">
          {scope.kind === 'all' ? t('work.workPane.allProjects') : scopeLabel(scope, projects)}
        </span>
        <div className="window-no-drag ms-auto flex items-center gap-2">{actions}</div>
      </header>
      {/* A column, so an empty state can centre itself with m-auto. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
    </section>
  );
}

/** A view with nothing in it yet: what it is for, once, and the one way in. */
export function WorkEmptyState({ view, action }: { view: WorkView; action?: ReactNode }) {
  const Glyph = VIEW_ICONS[view];
  const { title, body } = WORK_VIEW_PURPOSE[view];
  return (
    <EmptyState size="md" className="m-auto max-w-[360px] py-16">
      <EmptyState.Header>
        <EmptyState.Media variant="icon">
          <Glyph className="size-7 text-foreground-faint" stroke={1.5} aria-hidden />
        </EmptyState.Media>
        <EmptyState.Title>{title}</EmptyState.Title>
        <EmptyState.Description>{body}</EmptyState.Description>
      </EmptyState.Header>
      {action === undefined ? null : <EmptyState.Content>{action}</EmptyState.Content>}
    </EmptyState>
  );
}

/**
 * A search or filter that matched nothing, centred where the empty state
 * would be — distinct from it, because the work exists and is only hidden.
 */
export function WorkNoMatch({ query }: { query: string }) {
  const t = useT();
  return (
    <EmptyState data-work-no-match size="md" className="m-auto max-w-[360px] py-16">
      <EmptyState.Header>
        <EmptyState.Media variant="icon">
          <IconSearchOff className="size-6 text-foreground-faint" stroke={1.5} aria-hidden />
        </EmptyState.Media>
        <EmptyState.Title>
          {query === ''
            ? t('work.workPane.nothingMatchesTheseFilters')
            : t('work.nothingMatches', { query })}
        </EmptyState.Title>
        <EmptyState.Description>
          {query === ''
            ? t('work.workPane.changeOrResetTheFilters')
            : t('work.workPane.tryFewerOrOtherWords')}
        </EmptyState.Description>
      </EmptyState.Header>
    </EmptyState>
  );
}
