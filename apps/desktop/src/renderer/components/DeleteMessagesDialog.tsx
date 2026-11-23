import { Button, Checkbox, Modal, useOverlayState } from '@heroui/react';
import { useEffect, useState } from 'react';
import type { ApiFailure } from '../api';
import { writeFailureMessage } from '../bots/botProfileForm';
import { t, useT } from '../i18n/i18n';

/** What is being deleted: one message, or the whole conversation. */
export type DeleteMessagesRequest =
  | { readonly kind: 'message'; readonly botId: string; readonly messageId: string }
  | { readonly kind: 'clear'; readonly botId: string };

/**
 * The confirmation for "Delete message" and "Clear chat".
 *
 * The question it exists to ask is the memory one. Deleting a transcript
 * never took what the bot learned from it (`Memory.messageId` is SetNull),
 * which is the right default and a surprising one: an operator clearing a chat
 * to make a bot forget something would find it still knows. So the choice is
 * put in front of them every time, unticked, with the consequence of each
 * answer spelled out.
 *
 * Deliverables are named because they are the other thing a person might
 * expect to lose, and they are kept either way.
 */
export function DeleteMessagesDialog({
  request,
  botName,
  onClose,
  onConfirm,
}: {
  request: DeleteMessagesRequest | null;
  botName: string;
  onClose: () => void;
  onConfirm: (
    request: DeleteMessagesRequest,
    forget: boolean,
  ) => Promise<{ ok: true } | { ok: false; failure: ApiFailure }>;
}) {
  const t = useT();
  const overlay = useOverlayState({
    isOpen: request !== null,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
  });
  const [forget, setForget] = useState(false);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Every opening starts unticked: an answer given for one message is not an
  // answer for the next.
  useEffect(() => {
    if (request === null) return;
    setForget(false);
    setWorking(false);
    setFailure(null);
  }, [request]);

  if (request === null) return null;
  const copy = deleteMessagesCopy(request.kind, botName);

  async function confirm(current: DeleteMessagesRequest): Promise<void> {
    if (working) return;
    setWorking(true);
    setFailure(null);
    const result = await onConfirm(current, forget);
    setWorking(false);
    if (result.ok) {
      onClose();
      return;
    }
    setFailure(deleteFailureMessage(result.failure, botName));
  }

  return (
    <Modal state={overlay}>
      <Modal.Backdrop>
        <Modal.Container size="sm" placement="center" scroll="inside">
          <Modal.Dialog aria-label={copy.title} data-delete-messages={request.kind}>
            <Modal.Header>
              <Modal.Heading className="text-body font-semibold">{copy.title}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3">
              <p className="text-footnote leading-[18px] text-muted">{copy.body}</p>
              <Checkbox
                isSelected={forget}
                onChange={setForget}
                data-forget-memory
                className="mt-1 items-start"
              >
                <Checkbox.Content className="flex items-start gap-2.5">
                  <Checkbox.Control className="mt-0.5 shrink-0">
                    {/* Its own checkmark, which draws itself only when selected. A child
                          replaces it, and an icon child is drawn either way. */}
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span className="flex flex-col gap-0.5">
                    <span className="text-footnote font-medium text-foreground">{copy.forget}</span>
                    <span className="text-caption leading-[17px] text-muted">
                      {forget ? copy.forgetOn : copy.forgetOff}
                    </span>
                  </span>
                </Checkbox.Content>
              </Checkbox>
              {failure === null ? null : (
                <p role="alert" className="text-caption leading-[17px] text-danger">
                  {failure}
                </p>
              )}
            </Modal.Body>
            <Modal.Footer className="gap-2">
              <Button variant="tertiary" size="sm" onPress={onClose}>
                {t('delete.cancel')}
              </Button>
              <Button
                variant="danger-soft"
                size="sm"
                isDisabled={working}
                onPress={() => void confirm(request)}
              >
                {copy.action}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/** The dialog's words, as data, so the static-markup suite can read them. */
export function deleteMessagesCopy(
  kind: DeleteMessagesRequest['kind'],
  botName: string,
): {
  readonly title: string;
  readonly body: string;
  readonly forget: string;
  readonly forgetOn: string;
  readonly forgetOff: string;
  readonly action: string;
} {
  const bot = botName;
  return kind === 'clear'
    ? {
        title: t('delete.clear.title', { bot }),
        body: t('delete.clear.body'),
        forget: t('delete.clear.forget', { bot }),
        forgetOn: t('delete.clear.forgetOn', { bot }),
        forgetOff: t('delete.clear.forgetOff', { bot }),
        action: t('delete.clear.action'),
      }
    : {
        title: t('delete.message.title'),
        body: t('delete.message.body'),
        forget: t('delete.message.forget', { bot }),
        forgetOn: t('delete.message.forgetOn', { bot }),
        forgetOff: t('delete.message.forgetOff', { bot }),
        action: t('delete.message.action'),
      };
}

/** A refusal in words that say what to do next. */
export function deleteFailureMessage(failure: ApiFailure, botName: string): string {
  switch (failure.code) {
    case 'CONFLICT':
      return t('delete.busy', { bot: botName });
    case 'NOT_FOUND':
      return t('delete.gone');
    default:
      return writeFailureMessage(failure);
  }
}
