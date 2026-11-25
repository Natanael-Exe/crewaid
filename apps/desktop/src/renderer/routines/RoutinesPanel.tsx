import { Alert, Button, Chip, Input, Modal, Skeleton, Switch, TextArea } from '@heroui/react';
import { IconPencil, IconPlayerPlay, IconPlus, IconTarget, IconTrash } from '@tabler/icons-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  CreateRoutineBody,
  GoalWithProgress,
  Routine,
  UpdateRoutineBody,
} from '@crewaid/shared';

import {
  createRoutine,
  deleteRoutine,
  failureOf,
  listRoutines,
  runRoutineNow,
  updateRoutine,
  type ApiClient,
} from '../api';
import { EmptyState, IconButtonTooltip } from '../components/ui';
import { listGoals } from '../api/work';
import { Picker } from '../work/Fields';
import { EndsField, ScheduleField, TimezonePicker } from './RoutineScheduleFields';
import { formatDay } from './scheduleChoices';
import {
  createBodyOf,
  draftFromRoutine,
  draftProblem,
  emptyDraft,
  isInFlight,
  lastRunView,
  routineEnded,
  routinesForBot,
  scheduleText,
  updateBodyOf,
  type RoutineDraft,
  type RunTone,
} from './routinesState';
import { defaultTimezone } from '../settings/accountSettings';
import { useT } from '../i18n/i18n';

/**
 * The right rail's routine panel: create, edit, enable/disable,
 * run-now and last-run status, for the selected bot.
 *
 * It lists what the bot scheduled for itself beside the operator's own,
 * marked, because a schedule nobody can see is the failure M8-BE-08 exists
 * to prevent. Every write re-reads the list rather than patching it
 * locally: the server is what decides a disabled routine is unscheduled or a
 * cron is valid, and the panel shows its answer.
 *
 * Why it polls
 *
 * A run's outcome lands in `lastStatus` long after the 202, and nothing on
 * the WebSocket announces it. The panel re-reads on a short interval while
 * any routine is running or was just started, and on a long one otherwise, so
 * a schedule that fired while the operator watched does not sit at "Never
 * run". The whole list is one small query for one user's routines.
 */

export type RoutineActions = {
  readonly list: () => Promise<Routine[]>;
  readonly create: (body: CreateRoutineBody) => Promise<unknown>;
  readonly update: (id: string, body: UpdateRoutineBody) => Promise<unknown>;
  readonly remove: (id: string) => Promise<void>;
  readonly runNow: (id: string) => Promise<unknown>;
  /** The user's active goals, for the form's Goal and the row's chip. */
  readonly goals?: () => Promise<readonly GoalWithProgress[]>;
};

export function liveRoutineActions(client: ApiClient): RoutineActions {
  return {
    list: () => listRoutines(client),
    create: (body) => createRoutine(client, body),
    update: (id, body) => updateRoutine(client, id, body),
    remove: (id) => deleteRoutine(client, id),
    runNow: (id) => runRoutineNow(client, id),
    goals: () => listGoals(client, { status: 'ACTIVE' }),
  };
}

const ACTIVE_POLL_MS = 3_000;
const IDLE_POLL_MS = 30_000;

const TONE_CHIP: Record<RunTone, 'success' | 'danger' | 'accent' | 'default'> = {
  success: 'success',
  danger: 'danger',
  accent: 'accent',
  default: 'default',
};

type Editing = { readonly kind: 'new' } | { readonly kind: 'edit'; readonly routine: Routine };

export type RoutinesPanelProps = {
  readonly botId: string | null;
  readonly actions: RoutineActions;
  /** Rows to render before the first read lands — the render tests' seam. */
  readonly initial?: readonly Routine[];
  /** Seeded read failure for render tests; live mounts always start clear. */
  readonly initialReadProblem?: string | null;
  readonly now?: () => Date;
};

export function RoutinesPanel({
  botId,
  actions,
  initial,
  initialReadProblem = null,
  now = () => new Date(),
}: RoutinesPanelProps) {
  const t = useT();
  const [all, setAll] = useState<readonly Routine[] | null>(initial ?? null);
  /** A write the operator made failed: interrupting them is right. */
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * The background read failed. Not an alert: nobody asked for it, it repeats
   * on every poll, and an assistive-tech announcement per poll about a panel
   * the operator is not using would be noise. The last good list stays up.
   */
  const [readProblem, setReadProblem] = useState<string | null>(initialReadProblem);
  const [retryingRead, setRetryingRead] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const kickedAt = useRef(0);
  const lastFailedAction = useRef<{
    readonly key: string;
    readonly act: () => Promise<unknown>;
  } | null>(null);
  const [goals, setGoals] = useState<readonly GoalWithProgress[]>([]);
  useEffect(() => {
    // Goals are optional here: without any, the form has no Goal field and
    // no row carries a chip, exactly as before Work existed.
    actions
      .goals?.()
      .then(setGoals)
      .catch(() => setGoals([]));
  }, [actions, botId]);

  const refresh = useCallback(async () => {
    try {
      setAll(await actions.list());
      setReadProblem(null);
    } catch (error: unknown) {
      setReadProblem(failureOf(error).message);
    }
  }, [actions]);

  const retryRead = useCallback(async () => {
    setRetryingRead(true);
    try {
      await refresh();
    } finally {
      setRetryingRead(false);
    }
  }, [refresh]);

  useEffect(() => {
    setEditing(null);
    setManaging(false);
    setConfirmDelete(null);
    lastFailedAction.current = null;
    void refresh();
  }, [botId, refresh]);

  const mine = botId === null || all === null ? [] : routinesForBot(all, botId);
  const active = mine.some(isInFlight) || Date.now() - kickedAt.current < 15_000;
  useEffect(() => {
    if (botId === null) return undefined;
    const timer = setInterval(() => void refresh(), active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [botId, active, refresh]);

  /** One write, then the server's answer. The failure is the panel's to show. */
  const run = async (key: string, act: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key);
    try {
      await act();
      lastFailedAction.current = null;
      setProblem(null);
      await refresh();
      return true;
    } catch (error: unknown) {
      lastFailedAction.current = { key, act };
      setProblem(failureOf(error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const retryLastAction = async () => {
    const failed = lastFailedAction.current;
    if (failed === null || busy !== null) return;
    await run(failed.key, failed.act);
  };

  if (botId === null) return null;

  const form =
    editing === null ? null : (
      <RoutineForm
        key={editing.kind === 'edit' ? editing.routine.id : 'new'}
        isNew={editing.kind === 'new'}
        initial={
          editing.kind === 'edit'
            ? draftFromRoutine(editing.routine)
            : emptyDraft(defaultTimezone())
        }
        runsSkill={editing.kind === 'edit' && editing.routine.skillId !== null}
        goals={goals}
        busy={busy === 'form'}
        submitLabel={
          editing.kind === 'edit'
            ? t('routines.routinesPanel.save')
            : t('routines.routinesPanel.create')
        }
        onCancel={() => setEditing(null)}
        onSubmit={async (draft) => {
          const ok =
            editing.kind === 'new'
              ? await run('form', () => actions.create(createBodyOf(draft, botId)))
              : await run('form', async () => {
                  const body = updateBodyOf(draft, editing.routine);
                  if (body !== null) await actions.update(editing.routine.id, body);
                });
          if (ok) setEditing(null);
        }}
      />
    );

  return (
    <section
      aria-label={t('routines.routinesPanel.routines')}
      className="crewaid-routines flex flex-col gap-2 pt-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-footnote font-semibold text-foreground">
          {t('routines.routinesPanel.routines')}
        </h2>
        <div className="flex items-center gap-2">
          {mine.length === 0 ? null : (
            <Button
              variant="ghost"
              size="sm"
              onPress={() => setManaging(true)}
              className="h-8 px-1 text-footnote text-muted"
            >
              {t('routines.routinesPanel.manage')}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onPress={() => setEditing({ kind: 'new' })}
            className="h-8 gap-1 rounded-full bg-surface/85 px-3 text-footnote text-foreground"
          >
            <IconPlus className="size-3.5" stroke={1.8} aria-hidden />{' '}
            {t('routines.routinesPanel.createRoutine')}
          </Button>
        </div>
      </div>

      {problem !== null ? (
        <Alert status="danger" role="alert" className="items-center py-2 text-caption">
          <Alert.Indicator />
          <Alert.Content className="min-w-0 flex-1">
            <Alert.Description className="text-caption leading-4">{problem}</Alert.Description>
          </Alert.Content>
          {lastFailedAction.current === null ? null : (
            <Button
              variant="secondary"
              size="sm"
              isDisabled={busy !== null}
              onPress={() => void retryLastAction()}
              data-routines-action-retry
              className="h-7 shrink-0 rounded-full px-3 text-caption font-medium"
            >
              {t('routines.tryAgain')}
            </Button>
          )}
        </Alert>
      ) : null}

      {readProblem !== null && problem === null ? (
        <div
          role="status"
          data-routines-read-error
          className="flex items-center justify-between gap-2 text-caption leading-4 text-muted"
        >
          <p className="min-w-0 flex-1">{t('routines.loadFailed', { reason: readProblem })}</p>
          <Button
            variant="secondary"
            size="sm"
            isDisabled={retryingRead}
            onPress={() => void retryRead()}
            data-routines-retry
            className="h-7 shrink-0 rounded-full px-3 text-caption font-medium"
          >
            {t('routines.tryAgain')}
          </Button>
        </div>
      ) : null}

      {all === null && readProblem !== null ? null : all === null ? (
        <div
          role="status"
          aria-label={t('routines.routinesPanel.loadingRoutines')}
          className="flex flex-col gap-3 py-3"
        >
          {[0, 1].map((index) => (
            <div key={index} className="flex flex-col gap-2 px-1">
              <Skeleton className="h-3.5 w-1/2 rounded-full" />
              <Skeleton className="h-3 w-3/4 rounded-full" />
            </div>
          ))}
        </div>
      ) : mine.length === 0 && editing === null ? (
        <EmptyState size="sm" className="min-h-[160px] py-8">
          <EmptyState.Description className="max-w-[235px] text-footnote leading-5">
            {t('routines.routinesPanel.setAScheduleAndA')}
          </EmptyState.Description>
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {mine.map((routine) => (
            <RoutineRow
              key={routine.id}
              routine={routine}
              goal={goals.find((goal) => goal.id === routine.goalId)?.title ?? null}
              now={now()}
              busy={busy === routine.id}
              confirmingDelete={confirmDelete === routine.id}
              onToggle={(enabled) =>
                void run(routine.id, () => actions.update(routine.id, { enabled }))
              }
              onRunNow={() => {
                kickedAt.current = Date.now();
                void run(routine.id, () => actions.runNow(routine.id));
              }}
              onEdit={() => {
                setConfirmDelete(null);
                setEditing({ kind: 'edit', routine });
              }}
              onAskDelete={() => setConfirmDelete(routine.id)}
              onCancelDelete={() => setConfirmDelete(null)}
              onDelete={() => {
                setConfirmDelete(null);
                void run(routine.id, () => actions.remove(routine.id));
              }}
            />
          ))}
        </ul>
      )}
      <Modal
        isOpen={editing !== null || managing}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setManaging(false);
          }
        }}
      >
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog className="crewaid-routine-dialog w-[min(640px,calc(100vw-40px))] max-w-none rounded-[24px]">
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Heading>
                  {editing?.kind === 'new'
                    ? t('routines.routinesPanel.createRoutine')
                    : editing?.kind === 'edit'
                      ? t('routines.routinesPanel.editRoutine')
                      : t('routines.routinesPanel.manageRoutines')}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                {form ?? (
                  <ul className="flex flex-col gap-2">
                    {mine.map((routine) => (
                      <li key={routine.id} className="flex items-center justify-between gap-3 py-3">
                        <div>
                          <p className="font-medium">{routine.name}</p>
                          <p className="text-sm text-muted">{scheduleText(routine.cron)}</p>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          onPress={() => setEditing({ kind: 'edit', routine })}
                        >
                          {t('routines.edit', { name: routine.name })}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {problem === null ? null : (
                  <p role="alert" className="mt-3 text-sm text-danger">
                    {problem}
                  </p>
                )}
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </section>
  );
}

function RoutineRow({
  routine,
  goal,
  now,
  busy,
  confirmingDelete,
  onToggle,
  onRunNow,
  onEdit,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  readonly routine: Routine;
  /** The title of the goal it works toward, when it has one. */
  readonly goal: string | null;
  readonly now: Date;
  readonly busy: boolean;
  readonly confirmingDelete: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onRunNow: () => void;
  readonly onEdit: () => void;
  readonly onAskDelete: () => void;
  readonly onCancelDelete: () => void;
  readonly onDelete: () => void;
}) {
  const t = useT();
  const last = lastRunView(routine, now);
  const ended = routineEnded(routine, now);
  return (
    <li
      data-routine-id={routine.id}
      className="flex flex-col gap-2 rounded-[12px] border border-separator bg-background-secondary/40 px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-footnote font-medium text-foreground">
              {routine.name}
            </span>
            {routine.origin === 'BOT' ? (
              // The operator must be able to tell what the bot
              // scheduled for itself from what they set up.
              <Chip
                size="sm"
                variant="soft"
                color="warning"
                title={t('routines.routinesPanel.thisBotScheduledItItself')}
              >
                <Chip.Label>{t('routines.routinesPanel.setByBot')}</Chip.Label>
              </Chip>
            ) : null}
            {goal === null ? null : (
              <Chip
                size="sm"
                variant="soft"
                title={t('routines.routinesPanel.theGoalThisRoutineWorks')}
              >
                <IconTarget className="size-3 shrink-0" stroke={1.8} aria-hidden />
                <Chip.Label>{goal}</Chip.Label>
              </Chip>
            )}
          </div>
          <p className="mt-0.5 text-caption leading-4 text-muted" title={routine.cron}>
            {scheduleText(routine.cron)} · {routine.timezone.replaceAll('_', ' ')}
          </p>
          {routine.endsOn !== null ? (
            <p className={`mt-0.5 text-micro ${ended ? 'text-danger' : 'text-muted'}`}>
              {ended ? t('routines.routinesPanel.ended') : t('routines.routinesPanel.until')}{' '}
              {formatDay(routine.endsOn)}
            </p>
          ) : null}
        </div>
        <Switch
          size="sm"
          isSelected={routine.enabled}
          isDisabled={busy}
          onChange={onToggle}
          aria-label={t('routines.enabled', { name: routine.name })}
          className="shrink-0"
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
      </div>

      <div className="flex items-center gap-1">
        <Chip size="sm" variant="soft" color={TONE_CHIP[last.tone]}>
          <Chip.Label>{last.label}</Chip.Label>
        </Chip>
        <span className="flex-1" />
        {confirmingDelete ? (
          <>
            <span className="text-caption text-muted">{t('routines.routinesPanel.delete')}</span>
            <Button
              variant="danger-soft"
              size="sm"
              onPress={onDelete}
              className="h-7 rounded-lg px-2 text-caption"
            >
              {t('routines.routinesPanel.delete2')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onPress={onCancelDelete}
              className="h-7 rounded-lg px-2 text-caption"
            >
              {t('routines.routinesPanel.keep')}
            </Button>
          </>
        ) : (
          <>
            <IconButtonTooltip
              label={t('routines.runNow', { name: routine.name })}
              // A disabled or ended routine is refused by the server (409,
              // D-120/D-127); the button says so up front instead.
              isDisabled={busy || !routine.enabled || ended}
              onPress={onRunNow}
              className="size-7 rounded-lg text-muted"
            >
              <IconPlayerPlay className="size-3.5" stroke={1.8} />
            </IconButtonTooltip>
            <IconButtonTooltip
              label={t('routines.edit', { name: routine.name })}
              isDisabled={busy}
              onPress={onEdit}
              className="size-7 rounded-lg text-muted"
            >
              <IconPencil className="size-3.5" stroke={1.8} />
            </IconButtonTooltip>
            <IconButtonTooltip
              label={t('routines.delete', { name: routine.name })}
              isDisabled={busy}
              onPress={onAskDelete}
              className="size-7 rounded-lg text-muted"
            >
              <IconTrash className="size-3.5" stroke={1.8} />
            </IconButtonTooltip>
          </>
        )}
      </div>
    </li>
  );
}

function RoutineForm({
  isNew,
  initial,
  runsSkill,
  goals,
  busy,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  readonly isNew: boolean;
  readonly initial: RoutineDraft;
  readonly runsSkill: boolean;
  readonly goals: readonly GoalWithProgress[];
  readonly busy: boolean;
  readonly submitLabel: string;
  readonly onCancel: () => void;
  readonly onSubmit: (draft: RoutineDraft) => Promise<void>;
}) {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState<RoutineDraft>(initial);
  const [touched, setTouched] = useState(false);
  const blocked = draftProblem(draft, runsSkill, initial.endsOn);
  const set = (field: 'name' | 'cron' | 'timezone' | 'prompt') => (value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));
  const setEndsOn = (endsOn: string | null) => setDraft((current) => ({ ...current, endsOn }));

  return (
    <form
      aria-label={
        isNew ? t('routines.routinesPanel.newRoutine') : t('routines.routinesPanel.editRoutine')
      }
      className="crewaid-routine-form flex flex-col gap-2.5 rounded-[12px] border border-separator px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (blocked === null) void onSubmit(draft);
      }}
    >
      <Field id={`${id}-name`} label={t('routines.routinesPanel.name')}>
        <Input
          id={`${id}-name`}
          variant="secondary"
          value={draft.name}
          onChange={(event) => set('name')(event.target.value)}
          placeholder={t('routines.routinesPanel.morningDigest')}
          className="w-full"
        />
      </Field>
      <ScheduleField
        cron={draft.cron}
        timezone={draft.timezone}
        endsOn={draft.endsOn}
        onCronChange={set('cron')}
        onEndsChange={setEndsOn}
      />
      <TimezonePicker value={draft.timezone} onChange={set('timezone')} />
      <EndsField endsOn={draft.endsOn} timezone={draft.timezone} onChange={setEndsOn} />
      {goals.length === 0 && draft.goalId === null ? null : (
        <div className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-foreground">
            {t('routines.routinesPanel.goal')}
          </span>
          <Picker
            label={t('routines.routinesPanel.goal')}
            value={draft.goalId}
            noneLabel={t('routines.routinesPanel.noGoal')}
            options={goals.map((goal) => ({ id: goal.id, label: goal.title }))}
            onChange={(goalId) => setDraft((current) => ({ ...current, goalId }))}
          />
        </div>
      )}
      {runsSkill ? (
        <p className="text-caption text-muted">{t('routines.routinesPanel.runsASkillWithSaved')}</p>
      ) : (
        <Field id={`${id}-prompt`} label={t('routines.routinesPanel.whatShouldTheBotDo')}>
          <TextArea
            id={`${id}-prompt`}
            variant="secondary"
            value={draft.prompt}
            onChange={(event) => set('prompt')(event.target.value)}
            rows={3}
            placeholder={t('routines.routinesPanel.summariseYesterdaySUnreadEmail')}
            className="w-full"
          />
        </Field>
      )}
      {touched && blocked !== null ? (
        <p role="alert" className="text-caption text-danger">
          {blocked}
        </p>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          onPress={onCancel}
          className="h-8 rounded-[10px] px-3 text-caption"
        >
          {t('routines.routineScheduleFields.cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          isDisabled={busy}
          className="h-8 rounded-[10px] px-3.5 text-caption font-medium"
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-caption font-medium text-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
