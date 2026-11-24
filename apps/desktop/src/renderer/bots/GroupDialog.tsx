import { Button, Input, Modal, TextArea, useOverlayState } from '@heroui/react';
import { useEffect, useState } from 'react';
import { BOT_GROUP_INSTRUCTIONS_MAX, BOT_GROUP_NAME_MAX, type BotGroup } from '@crewaid/shared';
import type { ApiFailure } from '../api';
import { writeFailureMessage } from './botProfileForm';
import { useT } from '../i18n/i18n';

/** What the dialog saves: the two things a group is. */
export type GroupDraft = { readonly name: string; readonly instructions: string };

/**
 * Create or edit a bot group.
 *
 * One dialog for both, because a group is only two fields and the second one
 * is the point: the instructions are what every bot in the group reads, so
 * they sit in front of the operator every time the group is named, not
 * behind a separate menu item they may never find.
 *
 * Like the bot dialog, a failed save keeps what was typed.
 */
export function GroupDialog({
  isOpen,
  onOpenChange,
  group,
  forBotName,
  onSave,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** The group being edited, or null to create one. */
  group: BotGroup | null;
  /** When creating from a bot's "Move to", the bot that will go in it. */
  forBotName?: string | undefined;
  onSave: (draft: GroupDraft) => Promise<{ ok: true } | { ok: false; failure: ApiFailure }>;
}) {
  const t = useT();
  const overlay = useOverlayState({ isOpen, onOpenChange });
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName(group?.name ?? '');
    setInstructions(group?.instructions ?? '');
    setFailure(null);
    setSubmitted(false);
  }, [isOpen, group]);

  const issue = name.trim() === '' ? t('bots.groupDialog.giveTheGroupAName') : null;

  async function save(): Promise<void> {
    setSubmitted(true);
    if (issue !== null || saving) return;
    setSaving(true);
    setFailure(null);
    const result = await onSave({ name: name.trim(), instructions });
    setSaving(false);
    if (result.ok) {
      onOpenChange(false);
      return;
    }
    setFailure(writeFailureMessage(result.failure));
  }

  const title = group === null ? t('bots.groupDialog.newGroup') : t('bots.groupDialog.editGroup');
  return (
    <Modal state={overlay}>
      <Modal.Backdrop>
        <Modal.Container size="md" placement="center" scroll="inside">
          <Modal.Dialog aria-label={title}>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading className="text-body font-semibold">{title}</Modal.Heading>
              {group === null && forBotName !== undefined ? (
                <p className="mt-1 text-caption text-muted">
                  {t('bots.group.goesInto', { name: forBotName })}
                </p>
              ) : null}
            </Modal.Header>

            <Modal.Body className="flex flex-col gap-4">
              <div>
                <label htmlFor="group-name" className="mb-1.5 block text-caption text-muted">
                  {t('bots.botFields.name')}
                </label>
                <Input
                  id="group-name"
                  variant="secondary"
                  value={name}
                  maxLength={BOT_GROUP_NAME_MAX}
                  placeholder={t('bots.groupDialog.salesTeam')}
                  onChange={(event) => setName(event.target.value)}
                  className="w-full"
                />
              </div>

              <div>
                <label
                  htmlFor="group-instructions"
                  className="mb-1.5 block text-caption text-muted"
                >
                  {t('bots.groupDialog.instructions')}
                </label>
                <TextArea
                  id="group-instructions"
                  variant="secondary"
                  rows={6}
                  value={instructions}
                  maxLength={BOT_GROUP_INSTRUCTIONS_MAX}
                  placeholder={t('bots.groupDialog.whatEveryBotInThis')}
                  onChange={(event) => setInstructions(event.target.value)}
                  className="w-full resize-none"
                />
                <p className="mt-1.5 text-micro leading-4 text-foreground-faint">
                  {t('bots.groupDialog.everyBotInTheGroup')}
                </p>
              </div>

              {submitted && issue !== null ? (
                <p role="alert" className="text-caption text-danger">
                  {issue}
                </p>
              ) : null}
              {failure === null ? null : (
                <p role="alert" className="text-caption text-danger">
                  {failure}
                </p>
              )}
            </Modal.Body>

            <Modal.Footer className="gap-2">
              <Button variant="tertiary" size="sm" onPress={() => onOpenChange(false)}>
                {t('bots.botRowMenu.cancel')}
              </Button>
              <Button variant="primary" size="sm" isDisabled={saving} onPress={() => void save()}>
                {saving
                  ? t('bots.botProfilePane.saving')
                  : group === null
                    ? t('bots.createBotDialog.create')
                    : t('bots.botProfilePane.save')}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/**
 * The confirmation before a group goes. It says where the bots end up,
 * because "delete group" reads as "delete these bots" until told otherwise.
 */
export function DeleteGroupDialog({
  group,
  onOpenChange,
  onConfirm,
}: {
  group: BotGroup | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (group: BotGroup) => void;
}) {
  const t = useT();
  const overlay = useOverlayState({ isOpen: group !== null, onOpenChange });
  return (
    <Modal state={overlay}>
      <Modal.Backdrop>
        <Modal.Container size="sm" placement="center" scroll="inside">
          <Modal.Dialog
            aria-label={
              group === null
                ? t('bots.groupDialog.deleteGroup')
                : t('bots.group.delete', { name: group.name })
            }
          >
            <Modal.Header>
              <Modal.Heading className="text-body font-semibold">
                {group === null
                  ? t('bots.group.deleteFallback')
                  : t('bots.group.deleteTitle', { name: group.name })}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="text-footnote leading-[18px] text-muted">
                {t('bots.groupDialog.itsBotsMoveToUnassigned')}
              </p>
            </Modal.Body>
            <Modal.Footer className="gap-2">
              <Button variant="tertiary" size="sm" onPress={() => onOpenChange(false)}>
                {t('bots.botRowMenu.cancel')}
              </Button>
              <Button
                variant="danger-soft"
                size="sm"
                onPress={() => {
                  if (group !== null) onConfirm(group);
                  onOpenChange(false);
                }}
              >
                {t('bots.groupDialog.deleteGroup')}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
