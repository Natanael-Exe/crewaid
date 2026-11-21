import { Button } from '@heroui/react';
import { IconFlag, IconRepeat, IconTrash, IconX } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import type {
  BotWithSandbox,
  GoalDetailResponse,
  ProjectWithCounts,
  UpdateGoalBody,
} from '@crewaid/shared';
import { failureOf } from '../api';
import type { ApiClient } from '../api/apiClient';
import { deleteGoal, getGoal, updateGoal } from '../api/work';
import { AttachmentCard } from '../components/attachments/AttachmentCard';
import { BotAvatar } from '../components/BotAvatar';
import { lastRunView, scheduleText } from '../routines/routinesState';
import { SETTINGS_INPUT_CLASS } from '../settings/SettingsLayout';
import { BOARD_COLUMNS, STATUS_LABELS, columnCards } from './boardState';
import { Picker } from './Fields';
import { percent, progressText, rateText, readyToClose } from './goalsState';
import { workFailureText } from './workErrors';
import { usageText } from './workState';
import { useT, currentLocale } from '../i18n/i18n';

/**
 * A goal's details in the rail: its outcome, its tasks by
 * status, its recurring tasks' done rates, the routines working toward it
 * with their last result, and what has been delivered for it — and the two
 * ways the user closes it, *Mark achieved* and *Abandon*.
 */
export function GoalDetailsPane({
  client,
  goalId,
  revision,
  bots,
  projects,
  onClose,
  onOpenTask,
}: {
  client: ApiClient;
  goalId: string;
  revision: number;
  bots: readonly BotWithSandbox[];
  projects: readonly ProjectWithCounts[];
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const t = useT();
  const [goal, setGoal] = useState<GoalDetailResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    let live = true;
    getGoal(client, goalId)
      .then((row) => {
        if (live) setGoal(row);
      })
      .catch((error: unknown) => {
        if (live) setFailure(workFailureText(failureOf(error)));
      });
    return () => {
      live = false;
    };
  }, [client, goalId, revision, nonce]);

  const patch = useCallback(
    async (body: UpdateGoalBody) => {
      setFailure(null);
      try {
        await updateGoal(client, goalId, body);
        setNonce((value) => value + 1);
      } catch (error) {
        setFailure(workFailureText(failureOf(error)));
      }
    },
    [client, goalId],
  );

  return (
    <aside
      aria-label={t('work.goalDetailsPane.goalDetails')}
      className="crewaid-work-detail flex h-full min-h-0 flex-col"
    >
      <header className="window-drag flex h-12 shrink-0 items-center justify-between px-4">
        <span className="text-[12px] font-medium text-muted">{t('work.deliverablePane.goal')}</span>
        <Button
          variant="ghost"
          isIconOnly
          size="sm"
          aria-label={t('work.goalDetailsPane.closeGoalDetails')}
          onPress={onClose}
          className="window-no-drag size-7 rounded-lg text-muted"
        >
          <IconX className="size-4" stroke={1.8} />
        </Button>
      </header>
      {goal === null ? (
        failure === null ? null : (
          <p role="alert" className="px-4 text-[12px] text-danger">
            {failure}
          </p>
        )
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          <input
            key={`title-${goal.title}`}
            aria-label={t('work.deliverablePane.goal')}
            defaultValue={goal.title}
            onBlur={(event) => {
              const title = event.target.value.trim();
              if (title !== '' && title !== goal.title) void patch({ title });
            }}
            className="w-full rounded-lg border border-transparent bg-transparent px-1.5 py-1 text-[15px]! font-semibold outline-none hover:border-border focus:border-field-border focus:bg-field"
          />

          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {goal.status === 'ACTIVE' ? (
              readyToClose(goal) ? (
                <span className="rounded-full bg-success/15 px-2 py-0.5 font-medium text-success">
                  {t('work.goalDetailsPane.readyToClose')}
                </span>
              ) : (
                <span className="text-muted">{t('work.goalDetailsPane.active')}</span>
              )
            ) : (
              <span
                className={goal.status === 'ACHIEVED' ? 'font-medium text-success' : 'text-muted'}
              >
                {goal.status === 'ACHIEVED'
                  ? t('work.goalDetailsPane.achieved')
                  : t('work.goalDetailsPane.abandoned')}
                {goal.closedAt === null
                  ? ''
                  : ` · ${goal.closedAt.toLocaleDateString(currentLocale())}`}
              </span>
            )}
            {progressText(goal.progress) === null ? null : (
              <span className="text-muted">
                {t('work.goal.progress', {
                  progress: progressText(goal.progress) ?? '',
                  percent: percent(goal.progress) ?? 0,
                })}
              </span>
            )}
            {usageText(goal.usage) === null ? null : (
              <span data-goal-usage className="text-muted">
                {t('work.goal.used', { usage: usageText(goal.usage) ?? '' })}
              </span>
            )}
          </div>

          <div className="grid grid-cols-[88px_1fr] items-center gap-x-3 gap-y-2 text-[13px]">
            <span className="text-muted">{t('work.goalDetailsPane.target')}</span>
            <input
              aria-label={t('work.goalDetailsPane.targetDate')}
              type="date"
              value={goal.targetOn ?? ''}
              onChange={(event) =>
                void patch({ targetOn: event.target.value === '' ? null : event.target.value })
              }
              className={`${SETTINGS_INPUT_CLASS} h-8`}
            />
            <span className="text-muted">{t('work.deliverablePane.project')}</span>
            <Picker
              label={t('work.deliverablePane.project')}
              value={goal.projectId}
              noneLabel={t('work.boardState.noProject')}
              options={projects
                .filter((project) => project.status === 'ACTIVE' || project.id === goal.projectId)
                .map((project) => ({ id: project.id, label: project.name }))}
              onChange={(projectId) => void patch({ projectId })}
            />
          </div>

          <Section title={t('work.goalDetailsPane.outcome')}>
            <textarea
              key={`outcome-${goal.outcome ?? ''}`}
              aria-label={t('work.goalDetailsPane.outcome')}
              rows={3}
              defaultValue={goal.outcome ?? ''}
              placeholder={t('work.goalDetailsPane.whatItLooksLikeWhen')}
              onBlur={(event) => {
                const outcome = event.target.value.trim();
                if (outcome !== (goal.outcome ?? ''))
                  void patch({ outcome: outcome === '' ? null : outcome });
              }}
              className={`${SETTINGS_INPUT_CLASS} h-auto resize-y py-2 leading-[18px]`}
            />
          </Section>

          {goal.tasks.length === 0 ? null : (
            <Section title={t('work.botTasksSection.tasks')}>
              {[...BOARD_COLUMNS, 'CANCELLED' as const].map((status) => {
                const rows = columnCards(goal.tasks, status);
                if (rows.length === 0) return null;
                return (
                  <div key={status} className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-muted">
                      {STATUS_LABELS[status]} · {rows.length}
                    </span>
                    {rows.map((row) => {
                      const who =
                        row.assigneeBotId === null
                          ? undefined
                          : bots.find((bot) => bot.id === row.assigneeBotId);
                      return (
                        <button
                          key={row.id}
                          type="button"
                          onClick={() => onOpenTask(row.id)}
                          className="flex items-center gap-2 rounded-md px-1.5 py-1 text-start text-[13px]! hover:bg-background-secondary/60"
                        >
                          <span
                            className={`min-w-0 flex-1 truncate ${status === 'DONE' || status === 'CANCELLED' ? 'text-muted' : ''}`}
                          >
                            {row.title}
                          </span>
                          {who === undefined ? null : <BotAvatar bot={who} size="sm" />}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </Section>
          )}

          {goal.series.length === 0 ? null : (
            <Section title={t('work.goalDetailsPane.recurring')}>
              {goal.series.map((series) => (
                <span key={series.seriesId} className="flex items-center gap-1.5 text-[13px]">
                  <IconRepeat className="size-3.5 text-muted" stroke={1.8} />
                  {rateText(series.title, series.rate)}
                  {series.enabled ? null : (
                    <span className="text-[11px] text-muted">
                      {t('work.goalDetailsPane.stopped')}
                    </span>
                  )}
                </span>
              ))}
            </Section>
          )}

          {goal.routines.length === 0 ? null : (
            <Section title={t('work.goalDetailsPane.routines')}>
              {goal.routines.map((routine) => {
                const who = bots.find((bot) => bot.id === routine.botId);
                const last = lastRunView(routine, new Date());
                return (
                  <div key={routine.id} className="flex items-start gap-2 text-[13px]">
                    {who === undefined ? null : <BotAvatar bot={who} size="sm" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{routine.name}</div>
                      <div className="text-[11px] text-muted">
                        {scheduleText(routine.cron)} · {last.label}
                      </div>
                    </div>
                  </div>
                );
              })}
            </Section>
          )}

          {goal.deliverables.length === 0 ? null : (
            <Section title={t('work.goalDetailsPane.deliverables')}>
              {goal.deliverables.map((item) =>
                item.attachment === null ? (
                  <span key={item.id} className="text-[13px]">
                    {item.title}
                  </span>
                ) : (
                  <AttachmentCard key={item.id} attachment={item.attachment} />
                ),
              )}
            </Section>
          )}

          {failure === null ? null : (
            <p role="alert" className="text-[12px] text-danger">
              {failure}
            </p>
          )}

          <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-separator pt-3">
            {goal.status === 'ACTIVE' ? (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  onPress={() => void patch({ status: 'ACHIEVED' })}
                  className="h-8 gap-1 rounded-[10px] text-[12px] font-medium"
                >
                  <IconFlag className="size-3.5" stroke={1.8} />
                  {t('work.goalDetailsPane.markAchieved')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => void patch({ status: 'ABANDONED' })}
                  className="h-8 rounded-[10px] text-[12px]"
                >
                  {t('work.goalDetailsPane.abandon')}
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onPress={() => void patch({ status: 'ACTIVE' })}
                className="h-8 rounded-[10px] text-[12px]"
              >
                {t('work.goalDetailsPane.reopen')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onPress={() =>
                armed
                  ? void deleteGoal(client, goal.id)
                      .then(onClose)
                      .catch((error: unknown) => setFailure(workFailureText(failureOf(error))))
                  : setArmed(true)
              }
              className="ms-auto h-8 gap-1 rounded-[10px] text-[12px] text-danger"
            >
              <IconTrash className="size-3.5" stroke={1.8} />
              {armed
                ? t('work.goalDetailsPane.deleteItsTasksStay')
                : t('work.goalDetailsPane.delete')}
            </Button>
          </div>
        </div>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-medium tracking-[0.02em] text-muted">{title}</h3>
      {children}
    </section>
  );
}
