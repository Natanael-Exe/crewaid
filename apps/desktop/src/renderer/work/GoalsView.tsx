import { Button, Modal, ProgressBar, useOverlayState } from '@heroui/react';
import { IconPlus, IconRepeat, IconClock } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GoalStatus, GoalWithProgress, ProjectWithCounts } from '@crewaid/shared';
import { failureOf } from '../api';
import type { ApiClient } from '../api/apiClient';
import { createGoal, listGoals } from '../api/work';
import { SETTINGS_INPUT_CLASS } from '../settings/SettingsLayout';
import { shortDate } from './boardState';
import { FIELD_LABEL, Picker } from './Fields';
import { FilterMenu, projectFilterField, type FilterField, type ProjectFilter } from './FilterMenu';
import { orderGoals, percent, progressText, rateText, readyToClose } from './goalsState';
import { ViewSearch } from './ViewSearch';
import { WorkEmptyState, WorkNoMatch } from './WorkPane';
import { workFailureText } from './workErrors';
import { matchesQuery, scopeFromKey, scopeKey } from './workState';
import { useT } from '../i18n/i18n';

/**
 * The Goals view: one card per goal with its target date,
 * a progress bar over its one-off tasks, how often each recurring task was
 * done, how many routines work toward it, and *Ready to close* at 100% —
 * which is a nudge, never an act: a goal only closes when the user says so.
 */
export function GoalsView({
  client,
  projectFilter,
  revision,
  selectedGoalId,
  onOpenGoal,
  onHeaderActions,
}: {
  client: ApiClient;
  /** The shared project scope, which the filter menu also sets. */
  projectFilter: ProjectFilter;
  /** `work.goals` from the reducer. */
  revision: number;
  selectedGoalId: string | null;
  onOpenGoal: (goalId: string) => void;
  onHeaderActions: (actions: React.ReactNode) => void;
}) {
  const t = useT();
  const [goals, setGoals] = useState<readonly GoalWithProgress[] | null>(null);
  // Active by default: a closed goal is history, not something to work on.
  const [status, setStatus] = useState<GoalStatus | null>('ACTIVE');
  const { scope, projects } = projectFilter;
  const [query, setQuery] = useState('');
  const search = query.trim();
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let live = true;
    listGoals(client, {
      ...(status !== null && { status }),
      ...(scope.kind === 'project' ? { projectId: scope.projectId } : {}),
    })
      .then((rows) => {
        if (!live) return;
        setGoals(scope.kind === 'inbox' ? rows.filter((goal) => goal.projectId === null) : rows);
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (live) setFailure(workFailureText(failureOf(error)));
      });
    return () => {
      live = false;
    };
  }, [client, scope, status, revision, nonce]);

  const fields = useMemo<FilterField[]>(
    () => [
      projectFilterField(projectFilter),
      {
        kind: 'select',
        key: 'status',
        label: t('work.taskDetailsPane.status'),
        noneLabel: t('work.goalsView.anyStatus'),
        defaultValue: 'ACTIVE',
        options: [
          { id: 'ACTIVE', label: t('work.goalDetailsPane.active') },
          { id: 'ACHIEVED', label: t('work.goalDetailsPane.achieved') },
          { id: 'ABANDONED', label: t('work.goalDetailsPane.abandoned') },
        ],
      },
    ],
    [projectFilter],
  );

  const actions = useMemo(
    () => (
      <>
        {/* Keyed: the views share one header slot, and without a key the next
            view would inherit this one's open field. */}
        <ViewSearch
          key="goals"
          label={t('work.goalsView.searchGoals')}
          placeholder={t('work.goalsView.searchGoalsByNameOr')}
          value={query}
          onChange={setQuery}
        />
        <FilterMenu
          fields={fields}
          values={{ project: scopeKey(scope), status }}
          onApply={(values) => {
            projectFilter.onScopeChange(scopeFromKey(String(values['project'])));
            setStatus((values['status'] as GoalStatus | null) ?? null);
          }}
        />
        <Button
          variant="primary"
          size="sm"
          onPress={() => setAdding(true)}
          className="h-8 gap-1 rounded-[10px] text-[12px] font-medium"
        >
          <IconPlus className="size-3.5" stroke={2} />
          {t('work.goalsView.newGoal')}
        </Button>
      </>
    ),
    [fields, projectFilter, scope, status, query],
  );
  useEffect(() => onHeaderActions(actions), [actions, onHeaderActions]);

  const dialog = (
    <NewGoalDialog
      isOpen={adding}
      onOpenChange={setAdding}
      client={client}
      projects={projects}
      defaultProjectId={scope.kind === 'project' ? scope.projectId : null}
      onCreated={(goalId) => {
        reload();
        onOpenGoal(goalId);
      }}
    />
  );

  if (goals === null) {
    return failure === null ? null : (
      <p role="alert" className="p-6 text-[13px] text-danger">
        {failure}
      </p>
    );
  }
  // "No goals yet" only when there are none at all; a filter or a search
  // that hides every goal says so instead.
  const filtered = scope.kind !== 'all' || status !== 'ACTIVE' || search !== '';
  const shown =
    search === ''
      ? goals
      : goals.filter((goal) => matchesQuery(search, [goal.title, goal.outcome]));
  if (shown.length === 0 && filtered) {
    return (
      <>
        <WorkNoMatch query={search} />
        {dialog}
      </>
    );
  }
  if (goals.length === 0) {
    return (
      <>
        <WorkEmptyState
          view="goals"
          action={
            <Button
              variant="secondary"
              size="sm"
              onPress={() => setAdding(true)}
              className="h-8 rounded-[10px] text-[12px]"
            >
              {t('work.goalsView.addAGoal')}
            </Button>
          }
        />
        {dialog}
      </>
    );
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,420px),1fr))] gap-3 p-4">
      {orderGoals(shown).map((goal) => (
        <GoalCard
          key={goal.id}
          goal={goal}
          project={projects.find((project) => project.id === goal.projectId)}
          selected={selectedGoalId === goal.id}
          onOpen={() => onOpenGoal(goal.id)}
        />
      ))}
      {dialog}
    </div>
  );
}

export function GoalCard({
  goal,
  project,
  selected,
  onOpen,
}: {
  goal: GoalWithProgress;
  project: ProjectWithCounts | undefined;
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const pct = percent(goal.progress);
  const progress = progressText(goal.progress);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      className={`crewaid-goal-card flex flex-col gap-3 rounded-card border bg-surface p-4 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/40 ${
        selected ? 'border-accent/60' : 'border-border hover:border-foreground/20'
      } ${goal.status === 'ACTIVE' ? '' : 'opacity-70'}`}
    >
      <div className="flex items-start gap-2">
        {project !== undefined ? (
          <span
            aria-label={project.name}
            className="mt-1.5 size-2 shrink-0 rounded-full"
            style={{ backgroundColor: project.color }}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold leading-5 text-foreground">{goal.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
            {goal.targetOn === null ? null : (
              <span className="flex items-center gap-1">
                <IconClock className="size-3" stroke={1.8} />
                {shortDate(goal.targetOn)}
              </span>
            )}
            {project === undefined ? null : <span>{project.name}</span>}
            {goal.status === 'ACHIEVED' ? (
              <span className="text-success">{t('work.goalDetailsPane.achieved')}</span>
            ) : null}
            {goal.status === 'ABANDONED' ? (
              <span>{t('work.goalDetailsPane.abandoned')}</span>
            ) : null}
          </div>
        </div>
        {readyToClose(goal) ? (
          <span className="shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
            {t('work.goalDetailsPane.readyToClose')}
          </span>
        ) : null}
      </div>

      {progress === null ? null : (
        <div className="flex flex-col gap-1">
          <ProgressBar
            aria-label={t('work.goal.progressLabel', { goal: goal.title })}
            value={pct ?? 0}
            size="sm"
            color={readyToClose(goal) ? 'success' : 'accent'}
          >
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
          <span className="text-[12px] text-muted">
            {progress} · {pct}%
          </span>
        </div>
      )}

      {goal.series.length === 0 ? null : (
        <ul className="flex flex-col gap-0.5 text-[12px]">
          {goal.series.map((series) => (
            <li key={series.seriesId} className="flex items-center gap-1.5 text-foreground">
              <IconRepeat className="size-3 text-muted" stroke={1.8} />
              <span className={series.enabled ? '' : 'text-muted'}>
                {rateText(series.title, series.rate)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {goal.routineCount === 0 ? null : (
        <span className="text-[12px] text-muted">
          {t('work.goal.routines', { count: goal.routineCount })}
        </span>
      )}
    </button>
  );
}

function NewGoalDialog({
  isOpen,
  onOpenChange,
  client,
  projects,
  defaultProjectId,
  onCreated,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  client: ApiClient;
  projects: readonly ProjectWithCounts[];
  defaultProjectId: string | null;
  onCreated: (goalId: string) => void;
}) {
  const t = useT();
  const overlay = useOverlayState({ isOpen, onOpenChange });
  const [title, setTitle] = useState('');
  const [outcome, setOutcome] = useState('');
  const [targetOn, setTargetOn] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setTitle('');
    setOutcome('');
    setTargetOn('');
    setProjectId(defaultProjectId);
    setFailure(null);
  }, [isOpen, defaultProjectId]);

  async function save(): Promise<void> {
    if (title.trim() === '' || saving) return;
    setSaving(true);
    try {
      const goal = await createGoal(client, {
        title: title.trim(),
        ...(outcome.trim() !== '' && { outcome: outcome.trim() }),
        ...(targetOn !== '' && { targetOn }),
        ...(projectId !== null && { projectId }),
      });
      onCreated(goal.id);
      onOpenChange(false);
    } catch (error) {
      setFailure(workFailureText(failureOf(error)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal state={overlay}>
      <Modal.Backdrop>
        <Modal.Container size="cover" placement="center" className="h-fit sm:w-auto">
          <Modal.Dialog
            aria-label={t('work.goalsView.newGoal')}
            className="flex h-fit w-[440px] max-w-[92vw] flex-col gap-4 rounded-card bg-surface p-5"
          >
            <h2 className="text-[15px] font-semibold">{t('work.goalsView.newGoal')}</h2>
            <div>
              <label htmlFor="goal-title" className={FIELD_LABEL}>
                {t('work.deliverablePane.goal')}
              </label>
              <input
                id="goal-title"
                autoFocus
                value={title}
                maxLength={200}
                placeholder={t('work.goalsView.shipTheMvp')}
                onChange={(event) => setTitle(event.target.value)}
                className={SETTINGS_INPUT_CLASS}
              />
            </div>
            <div>
              <label htmlFor="goal-outcome" className={FIELD_LABEL}>
                {t('work.goalDetailsPane.whatItLooksLikeWhen')}
              </label>
              <textarea
                id="goal-outcome"
                rows={3}
                value={outcome}
                onChange={(event) => setOutcome(event.target.value)}
                className={`${SETTINGS_INPUT_CLASS} h-auto resize-none py-2 leading-[18px]`}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="goal-target" className={FIELD_LABEL}>
                  {t('work.goalDetailsPane.targetDate')}
                </label>
                <input
                  id="goal-target"
                  type="date"
                  value={targetOn}
                  onChange={(event) => setTargetOn(event.target.value)}
                  className={SETTINGS_INPUT_CLASS}
                />
              </div>
              <div>
                <span className={FIELD_LABEL}>{t('work.deliverablePane.project')}</span>
                <Picker
                  label={t('work.deliverablePane.project')}
                  value={projectId}
                  noneLabel={t('work.boardState.noProject')}
                  options={projects
                    .filter((project) => project.status === 'ACTIVE')
                    .map((project) => ({ id: project.id, label: project.name }))}
                  onChange={setProjectId}
                />
              </div>
            </div>
            {failure === null ? null : (
              <p role="alert" className="text-[12px] text-danger">
                {failure}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="tertiary"
                size="sm"
                onPress={() => onOpenChange(false)}
                className="h-8 rounded-[10px] text-[12px] font-medium"
              >
                {t('work.goalsView.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                isDisabled={saving || title.trim() === ''}
                onPress={() => void save()}
                className="h-8 rounded-[10px] text-[12px] font-medium"
              >
                {saving ? t('work.goalsView.adding') : t('work.goalsView.addGoal')}
              </Button>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
