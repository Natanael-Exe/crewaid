import { Button, Chip, Modal, useOverlayState } from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';
import type { LocalConnectorPromptEvent, LocalConnectorPromptResponse } from '../../preload';
import { localConnectorBridge } from '../bridge';
import { useT } from '../i18n/i18n';

/**
 * Shell-level listener for in-app local task confirmations and ACP
 * `session/request_permission` prompts from desktop-managed connectors (D-242).
 */
export function LocalConnectorPromptHost() {
  const [prompt, setPrompt] = useState<LocalConnectorPromptEvent | null>(null);

  useEffect(() => {
    let active = true;
    void localConnectorBridge.currentPrompt().then((existing) => {
      if (active && existing !== null) setPrompt(existing);
    });
    const unsubscribe = localConnectorBridge.onPrompt((next) => {
      if (active) setPrompt(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const handleRespond = useCallback((response: LocalConnectorPromptResponse) => {
    setPrompt((current) => (current?.requestId === response.requestId ? null : current));
    void localConnectorBridge.respondPrompt(response);
  }, []);

  return <LocalConnectorPromptDialog prompt={prompt} onRespond={handleRespond} />;
}

export interface LocalConnectorPromptDialogProps {
  readonly prompt: LocalConnectorPromptEvent | null;
  readonly onRespond: (response: LocalConnectorPromptResponse) => void;
}

/**
 * Presentational modal body exported separately so static-markup tests can
 * verify both `confirm_task` and `request_permission` without React Aria portals.
 */
export function LocalConnectorPromptBody({
  prompt,
  onRespond,
}: {
  readonly prompt: LocalConnectorPromptEvent;
  readonly onRespond: (response: LocalConnectorPromptResponse) => void;
}) {
  const t = useT();

  if (prompt.kind === 'confirm_task') {
    const folderDisplay =
      prompt.relativeCwd === '.'
        ? prompt.workspaceName
        : `${prompt.workspaceName}/${prompt.relativeCwd}`;
    const reportLabel =
      prompt.reportMode === 'full'
        ? t('settings.localHarnesses.reportMode.full')
        : t('settings.localHarnesses.reportMode.summary');
    return (
      <div className="flex flex-col gap-3" data-local-connector-prompt="confirm_task">
        <p className="text-footnote leading-[18px] text-muted">
          {t('settings.localHarnesses.prompt.confirmSubtitle', {
            bot: prompt.botName,
            harness: prompt.harness,
            folder: folderDisplay,
          })}
        </p>

        <div className="space-y-1.5 rounded-card bg-surface-secondary px-3.5 py-2.5 text-caption">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">{t('settings.localHarnesses.prompt.folderLabel')}</span>
            <span className="truncate font-mono text-foreground" dir="ltr">
              {folderDisplay}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">{t('settings.localHarnesses.prompt.reportLabel')}</span>
            <span className="text-foreground">{reportLabel}</span>
          </div>
          {prompt.verifyCommand === undefined ? null : (
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted">{t('settings.localHarnesses.prompt.verifyLabel')}</span>
              <code className="truncate font-mono text-foreground" dir="ltr">
                {prompt.verifyCommand}
              </code>
            </div>
          )}
        </div>

        <div className="space-y-1">
          <div className="text-caption font-medium text-muted">
            {t('settings.localHarnesses.prompt.promptLabel')}
          </div>
          <pre
            dir="auto"
            data-local-connector-prompt-text
            className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-separator bg-field px-3 py-2 font-mono text-caption leading-[18px] text-foreground"
          >
            {prompt.prompt}
          </pre>
        </div>

        <div className="mt-1 flex items-center justify-end gap-2">
          <Button
            variant="tertiary"
            size="sm"
            onPress={() =>
              onRespond({ kind: 'confirm_task', requestId: prompt.requestId, approved: false })
            }
          >
            {t('settings.localHarnesses.prompt.decline')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onPress={() =>
              onRespond({ kind: 'confirm_task', requestId: prompt.requestId, approved: true })
            }
          >
            {t('settings.localHarnesses.prompt.runLocally')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-local-connector-prompt="request_permission">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-footnote leading-[18px] text-muted">
          {t('settings.localHarnesses.prompt.permissionSubtitle', {
            connector: prompt.connectorName,
          })}
        </p>
        <Chip size="sm" variant="soft" color="warning">
          {prompt.toolKind}
        </Chip>
      </div>

      <div className="rounded-card bg-surface-secondary px-3.5 py-2.5">
        <div className="text-footnote font-medium text-foreground">{prompt.title}</div>
        {prompt.locations.length === 0 ? null : (
          <div className="mt-1.5 space-y-0.5">
            <div className="text-caption text-muted">
              {t('settings.localHarnesses.prompt.filesLabel')}
            </div>
            <ul className="space-y-0.5 font-mono text-caption text-foreground" dir="ltr">
              {prompt.locations.map((loc) => (
                <li key={loc} className="truncate">
                  {loc}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="tertiary"
          size="sm"
          onPress={() =>
            onRespond({
              kind: 'request_permission',
              requestId: prompt.requestId,
              outcome: 'cancelled',
            })
          }
        >
          {t('settings.localHarnesses.prompt.deny')}
        </Button>
        {prompt.options.map((opt) => {
          const isReject = opt.kind === 'reject_once' || opt.kind === 'reject_always';
          const isPrimary = opt.kind === 'allow_once';
          return (
            <Button
              key={opt.optionId}
              variant={isReject ? 'danger-soft' : isPrimary ? 'primary' : 'secondary'}
              size="sm"
              onPress={() =>
                onRespond({
                  kind: 'request_permission',
                  requestId: prompt.requestId,
                  outcome: 'selected',
                  optionId: opt.optionId,
                })
              }
            >
              {opt.name}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export function LocalConnectorPromptDialog({ prompt, onRespond }: LocalConnectorPromptDialogProps) {
  const t = useT();

  const failClosed = useCallback(() => {
    if (prompt === null) return;
    if (prompt.kind === 'confirm_task') {
      onRespond({ kind: 'confirm_task', requestId: prompt.requestId, approved: false });
    } else {
      onRespond({
        kind: 'request_permission',
        requestId: prompt.requestId,
        outcome: 'cancelled',
      });
    }
  }, [prompt, onRespond]);

  const overlay = useOverlayState({
    isOpen: prompt !== null,
    onOpenChange: (open) => {
      if (!open) failClosed();
    },
  });

  if (prompt === null) return null;

  const title =
    prompt.kind === 'confirm_task'
      ? t('settings.localHarnesses.prompt.confirmTitle')
      : t('settings.localHarnesses.prompt.permissionTitle');

  return (
    <Modal state={overlay}>
      <Modal.Backdrop>
        <Modal.Container size="md" placement="center" scroll="inside">
          <Modal.Dialog aria-label={title}>
            <Modal.Header>
              <Modal.Heading className="text-body font-semibold">{title}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <LocalConnectorPromptBody prompt={prompt} onRespond={onRespond} />
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
