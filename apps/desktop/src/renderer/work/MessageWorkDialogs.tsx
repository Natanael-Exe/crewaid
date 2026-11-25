import { Button, Input, Modal, useOverlayState } from '@heroui/react';
import { useEffect, useMemo, useState } from 'react';
import {
  projectPublicSpeech,
  type BotWithSandbox,
  type DeliverableView,
  type GoalWithProgress,
  type ProjectWithCounts,
} from '@crewaid/shared';
import { failureOf } from '../api';
import type { ApiClient } from '../api/apiClient';
import { createDeliverable, listGoals } from '../api/work';
import type { MessageWorkAction } from '../components/Transcript';
import { FIELD_LABEL } from './Fields';
import { taskDraftFromMessage, titleFromMessage } from './fromMessage';
import { NewTaskDialog } from './NewTaskDialog';
import { workFailureText } from './workErrors';
import { useT } from '../i18n/i18n';

/** The message a menu action was chosen on, and which action. */
export type MessageWorkRequest = {
  readonly action: MessageWorkAction;
  readonly message: { readonly id: string; readonly content: string };
};

/**
 * The transcript message menu's two dialogs. Each is
 * a draft: the new-task dialog opens with the message quoted as the brief,
 * and Save as deliverable asks for a title. Nothing exists until the user
 * saves, and a task made here starts nothing unless they press Add & start.
 */
export function MessageWorkDialogs({
  request,
  onClose,
  client,
  bots,
  projects,
  onTaskCreated,
  onOpenDeliverable,
}: {
  request: MessageWorkRequest | null;
  onClose: () => void;
  client: ApiClient;
  bots: readonly BotWithSandbox[];
  projects: readonly ProjectWithCounts[];
  onTaskCreated: (taskId: string | null) => void;
  onOpenDeliverable: (deliverable: DeliverableView) => void;
}) {
  const [goals, setGoals] = useState<readonly GoalWithProgress[]>([]);
  const content = projectPublicSpeech(request?.message.content ?? '');
  const defaults = useMemo(
    () => ({ projectId: null, ...taskDraftFromMessage(content) }),
    [content],
  );

  useEffect(() => {
    if (request?.action !== 'task') return;
    listGoals(client, { status: 'ACTIVE' })
      .then(setGoals)
      .catch(() => undefined);
  }, [client, request]);

  return (
    <>
      <NewTaskDialog
        isOpen={request?.action === 'task'}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        client={client}
        bots={bots}
        projects={projects}
        goals={goals}
        defaults={defaults}
        onCreated={onTaskCreated}
      />
      <SaveDeliverableDialog
        isOpen={request?.action === 'deliverable'}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        client={client}
        messageId={request?.message.id ?? null}
        suggestedTitle={titleFromMessage(content)}
        onOpenDeliverable={onOpenDeliverable}
      />
    </>
  );
}

function SaveDeliverableDialog({
  isOpen,
  onOpenChange,
  client,
  messageId,
  suggestedTitle,
  onOpenDeliverable,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  client: ApiClient;
  messageId: string | null;
  suggestedTitle: string;
  onOpenDeliverable: (deliverable: DeliverableView) => void;
}) {
  const t = useT();
  const overlay = useOverlayState({ isOpen, onOpenChange });
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<DeliverableView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setTitle(suggestedTitle);
    setSaving(false);
    setSaved(null);
    setFailure(null);
  }, [isOpen, suggestedTitle]);

  const save = async () => {
    if (messageId === null || title.trim() === '') return;
    setSaving(true);
    setFailure(null);
    try {
      setSaved(
        await createDeliverable(client, { kind: 'MESSAGE', messageId, title: title.trim() }),
      );
    } catch (error) {
      setFailure(workFailureText(failureOf(error)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal state={overlay}>
      <Modal.Backdrop>
        <Modal.Container size="sm" placement="center" scroll="inside">
          <Modal.Dialog
            aria-label={t('work.messageWorkDialogs.saveAsDeliverable')}
            className="sm:max-w-[420px]"
          >
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading className="text-body font-semibold">
                {t('work.messageWorkDialogs.saveAsDeliverable')}
              </Modal.Heading>
            </Modal.Header>
            {saved === null ? (
              <>
                <Modal.Body className="flex flex-col gap-3">
                  <div>
                    <label htmlFor="deliverable-title" className={FIELD_LABEL}>
                      {t('work.messageWorkDialogs.title')}
                    </label>
                    <Input
                      id="deliverable-title"
                      variant="secondary"
                      autoFocus
                      value={title}
                      maxLength={200}
                      placeholder={t('work.messageWorkDialogs.weeklyReport')}
                      onChange={(event) => setTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void save();
                      }}
                      className="w-full"
                    />
                    <p className="mt-1.5 text-caption text-muted">
                      {t('work.messageWorkDialogs.filedWhereTheMessageS')}
                    </p>
                  </div>
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
                  <Button
                    variant="primary"
                    size="sm"
                    isDisabled={saving || title.trim() === ''}
                    onPress={() => void save()}
                  >
                    {saving
                      ? t('work.messageWorkDialogs.saving')
                      : t('work.messageWorkDialogs.save')}
                  </Button>
                </Modal.Footer>
              </>
            ) : (
              <>
                <Modal.Body>
                  <p role="status" className="text-footnote">
                    {saved.task === null
                      ? t('work.saved.toDeliverables', { title: saved.title })
                      : t('work.saved.underTask', { title: saved.title, task: saved.task.title })}
                  </p>
                </Modal.Body>
                <Modal.Footer className="gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onPress={() => {
                      onOpenChange(false);
                      onOpenDeliverable(saved);
                    }}
                  >
                    {t('work.messageWorkDialogs.openInDeliverables')}
                  </Button>
                  <Button variant="primary" size="sm" onPress={() => onOpenChange(false)}>
                    {t('work.messageWorkDialogs.done')}
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
