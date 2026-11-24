import { Button, Input, Modal, Switch, TextArea, useOverlayState } from '@heroui/react';
import { useEffect, useState } from 'react';
import type { BotWithSandbox, GoalWithProgress, ProjectWithCounts } from '@crewaid/shared';
import { failureOf } from '../api';
import type { ApiClient } from '../api/apiClient';
import { createTask, startTask } from '../api/work';
import { BotAvatar } from '../components/BotAvatar';
import { EndsField, ScheduleField, TimezonePicker } from '../routines/RoutineScheduleFields';
import { defaultTimezone } from '../settings/accountSettings';
import { FIELD_LABEL, Picker } from './Fields';
import { workFailureText } from './workErrors';
import { useT } from '../i18n/i18n';

export type NewTaskDefaults = {
  readonly projectId: string | null;
  readonly goalId?: string | null;
  readonly assigneeBotId?: string | null;
  readonly parentId?: string | null;
  /** Prefilled from a transcript message ("Create task from message"). */
  readonly title?: string;
  readonly brief?: string;
};

/**
 * Add a task: title, brief, assignee, project, goal, due date
 * — and Repeat, which makes it a recurring task with the routine form's own
 * schedule fields. "Add & start" is the one way to create and start
 * at once, and it goes through the same Start route with a key made once for
 * this press; plain "Add" starts nothing.
 */
export function NewTaskDialog({
  isOpen,
  onOpenChange,
  client,
  bots,
  projects,
  goals,
  defaults,
  onCreated,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  client: ApiClient;
  bots: readonly BotWithSandbox[];
  projects: readonly ProjectWithCounts[];
  goals: readonly GoalWithProgress[];
  defaults: NewTaskDefaults;
  onCreated: (taskId: string | null) => void;
}) {
  const t = useT();
  const overlay = useOverlayState({ isOpen, onOpenChange });
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [goalId, setGoalId] = useState<string | null>(null);
  const [dueOn, setDueOn] = useState('');
  const [repeats, setRepeats] = useState(false);
  const [cron, setCron] = useState('');
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [endsOn, setEndsOn] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [startKey, setStartKey] = useState<string>(() => crypto.randomUUID());

  useEffect(() => {
    if (!isOpen) return;
    setTitle(defaults.title ?? '');
    setBrief(defaults.brief ?? '');
    setAssignee(defaults.assigneeBotId ?? null);
    setProjectId(defaults.projectId);
    setGoalId(defaults.goalId ?? null);
    setDueOn('');
    setRepeats(false);
    setCron('');
    setTimezone(defaultTimezone());
    setEndsOn(null);
    setFailure(null);
    setStartKey(crypto.randomUUID());
  }, [isOpen, defaults]);

  const subtask = defaults.parentId != null;
  const problem =
    title.trim() === ''
      ? t('work.newTaskDialog.giveTheTaskATitle')
      : repeats && cron === ''
        ? t('work.newTaskDialog.chooseWhenItRepeats')
        : null;

  async function save(start: boolean): Promise<void> {
    if (problem !== null || saving) return;
    setSaving(true);
    setFailure(null);
    try {
      const made = await createTask(client, {
        title: title.trim(),
        ...(brief.trim() !== '' && { brief: brief.trim() }),
        ...(assignee !== null && { assigneeBotId: assignee }),
        ...(subtask ? { parentId: defaults.parentId } : { projectId, goalId }),
        ...(dueOn !== '' && !repeats && { dueOn }),
        ...(repeats && { repeat: { cron, timezone, endsOn } }),
      });
      if (start && made.task !== null) await startTask(client, made.task.id, startKey);
      onCreated(made.task?.id ?? null);
      onOpenChange(false);
    } catch (error) {
      setFailure(workFailureText(failureOf(error)));
    } finally {
      setSaving(false);
    }
  }

  const heading = subtask ? t('work.taskDetailsPane.newSubtask') : t('work.newTaskDialog.newTask');
  return (
    <Modal state={overlay}>
      <Modal.Backdrop>
        <Modal.Container size="md" placement="center" scroll="inside">
          <Modal.Dialog aria-label={heading} className="sm:max-w-[480px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading className="text-body font-semibold">{heading}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <div>
                <label htmlFor="task-title" className={FIELD_LABEL}>
                  {t('work.messageWorkDialogs.title')}
                </label>
                <Input
                  id="task-title"
                  variant="secondary"
                  autoFocus
                  value={title}
                  maxLength={200}
                  placeholder={t('work.newTaskDialog.apiAuth')}
                  onChange={(event) => setTitle(event.target.value)}
                  className="w-full"
                />
              </div>
              <div>
                <label htmlFor="task-brief" className={FIELD_LABEL}>
                  {t('work.newTaskDialog.brief')}
                </label>
                <TextArea
                  id="task-brief"
                  variant="secondary"
                  rows={4}
                  value={brief}
                  placeholder={t('work.newTaskDialog.whatNeedsDoingWhatIt')}
                  onChange={(event) => setBrief(event.target.value)}
                  className="w-full resize-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className={FIELD_LABEL}>{t('work.newTaskDialog.assignee')}</span>
                  <Picker
                    label={t('work.newTaskDialog.assignee')}
                    value={assignee}
                    noneLabel={t('work.newTaskDialog.youUnassigned')}
                    options={bots.map((bot) => ({
                      id: bot.id,
                      label: bot.name,
                      adornment: <BotAvatar bot={bot} size="sm" />,
                    }))}
                    onChange={setAssignee}
                  />
                </div>
                {repeats ? null : (
                  <div>
                    <label htmlFor="task-due" className={FIELD_LABEL}>
                      {t('work.newTaskDialog.due')}
                    </label>
                    <Input
                      id="task-due"
                      variant="secondary"
                      type="date"
                      value={dueOn}
                      onChange={(event) => setDueOn(event.target.value)}
                      className="w-full tabular-nums"
                    />
                  </div>
                )}
                {subtask ? null : (
                  <>
                    <div>
                      <span className={FIELD_LABEL}>{t('work.deliverablePane.project')}</span>
                      <Picker
                        label={t('work.deliverablePane.project')}
                        value={projectId}
                        noneLabel={t('work.tasksView.inbox')}
                        options={projects
                          .filter((project) => project.status === 'ACTIVE')
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
                        onChange={setProjectId}
                      />
                    </div>
                    <div>
                      <span className={FIELD_LABEL}>{t('work.deliverablePane.goal')}</span>
                      <Picker
                        label={t('work.deliverablePane.goal')}
                        value={goalId}
                        noneLabel={t('work.deliverablePane.noGoal')}
                        options={goals
                          .filter((goal) => goal.status === 'ACTIVE')
                          .map((goal) => ({ id: goal.id, label: goal.title }))}
                        onChange={setGoalId}
                      />
                    </div>
                  </>
                )}
              </div>

              {subtask ? null : (
                <div className="flex flex-col gap-3 rounded-[10px] bg-background-secondary/50 p-3">
                  <Switch size="sm" isSelected={repeats} onChange={setRepeats} className="w-full">
                    <Switch.Content className="flex w-full items-center justify-between gap-3">
                      <span className="text-footnote">{t('work.newTaskDialog.repeat')}</span>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch.Content>
                  </Switch>
                  {repeats ? (
                    <>
                      <ScheduleField
                        cron={cron}
                        timezone={timezone}
                        endsOn={endsOn}
                        onCronChange={setCron}
                        onEndsChange={setEndsOn}
                      />
                      <TimezonePicker value={timezone} onChange={setTimezone} />
                      <EndsField endsOn={endsOn} timezone={timezone} onChange={setEndsOn} />
                      <p className="text-micro leading-4 text-muted">
                        {t('work.newTaskDialog.aFreshCopyLandsIn')}
                      </p>
                    </>
                  ) : null}
                </div>
              )}

              {failure === null ? null : (
                <p role="alert" className="text-caption text-danger">
                  {failure}
                </p>
              )}
            </Modal.Body>
            <Modal.Footer className="gap-2">
              <Button variant="tertiary" size="sm" onPress={() => onOpenChange(false)}>
                {t('work.goalsView.cancel')}
              </Button>
              {assignee !== null && !repeats ? (
                <Button
                  variant="secondary"
                  size="sm"
                  isDisabled={saving || problem !== null}
                  onPress={() => void save(true)}
                >
                  {t('work.newTaskDialog.addStart')}
                </Button>
              ) : null}
              <Button
                variant="primary"
                size="sm"
                isDisabled={saving || problem !== null}
                onPress={() => void save(false)}
              >
                {saving ? t('work.goalsView.adding') : t('work.newTaskDialog.add')}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
