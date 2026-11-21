import { Button, Modal, useOverlayState } from '@heroui/react';
import { useEffect, useState } from 'react';
import type { Bot } from '@crewaid/shared';
import { BotFields } from './BotFields';
import type { BotMutation } from '../state/useChat';
import {
  draftIssue,
  NEW_BOT_DRAFT,
  toCreateBody,
  writeFailureMessage,
  type BotDraft,
} from './botProfileForm';
import { useT } from '../i18n/i18n';

/**
 * The sidebar's "+".
 *
 * The reference app opens a combined "search or create" overlay that doubles
 * as a bot switcher and a group-chat creator. Neither maps here — the sidebar
 * is already the switcher, and group chat has no §3 model — so this is the
 * create half alone rather than a shell whose other two thirds do nothing.
 *
 * The draft survives a failed create: the operator's typing is the expensive
 * part, and a dialog that clears itself on a network blip throws it away.
 */

export function CreateBotDialog({
  isOpen,
  onOpenChange,
  onCreate,
  onCreated,
  initialDraft,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (body: ReturnType<typeof toCreateBody>) => Promise<BotMutation<Bot>>;
  onCreated: (bot: Bot) => void;
  /** A bot template's profile, to review and change before creating. */
  initialDraft?: BotDraft | null | undefined;
}) {
  const t = useT();
  const overlay = useOverlayState({ isOpen, onOpenChange });
  const [draft, setDraft] = useState<BotDraft>(NEW_BOT_DRAFT);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  // A fresh dialog starts empty, or from the template it was opened for; a
  // reopened one does not inherit the last attempt's error.
  useEffect(() => {
    if (!isOpen) return;
    setDraft(initialDraft ?? NEW_BOT_DRAFT);
    setFailure(null);
    setSubmitted(false);
  }, [isOpen, initialDraft]);

  const issue = draftIssue(draft);

  async function create(): Promise<void> {
    setSubmitted(true);
    if (issue !== null || creating) return;
    setCreating(true);
    setFailure(null);
    const result = await onCreate(toCreateBody(draft));
    setCreating(false);
    if (result.ok) {
      onCreated(result.value);
      onOpenChange(false);
      return;
    }
    setFailure(writeFailureMessage(result.failure));
  }

  return (
    <Modal state={overlay}>
      <Modal.Backdrop>
        <Modal.Container
          size="cover"
          placement="center"
          className="sm:w-auto h-fit"
          scroll="inside"
        >
          <Modal.Dialog
            aria-label={t('bots.createBotDialog.newBot')}
            className="crewaid-create-bot-dialog flex h-fit max-h-[80vh] w-[600px] max-w-[92vw] flex-col gap-4 overflow-y-auto rounded-card bg-surface p-5"
          >
            <h2 className="text-[15px] font-semibold">{t('bots.createBotDialog.newBot')}</h2>

            <BotFields draft={draft} onChange={setDraft} idPrefix="new-bot" promptRows={5} />

            {/* Held back until submit: naming the empty fields the moment the
                dialog opens scolds the operator for not having typed yet. */}
            {submitted && issue !== null ? (
              <p role="alert" className="text-[12px] text-danger">
                {issue}
              </p>
            ) : null}
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
                {t('bots.botRowMenu.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                isDisabled={creating}
                onPress={() => void create()}
                className="h-8 rounded-[10px] text-[12px] font-medium"
              >
                {creating ? t('bots.createBotDialog.creating') : t('bots.createBotDialog.create')}
              </Button>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
