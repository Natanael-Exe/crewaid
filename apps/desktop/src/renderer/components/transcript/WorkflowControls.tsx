import type { WorkflowChainSummary } from '@crewaid/shared';
import { Button, Popover } from '@heroui/react';
import { IconCheck, IconChevronDown, IconPlayerStop } from '@tabler/icons-react';
import { useState } from 'react';
import { useT } from '../../i18n/i18n';

export interface WorkflowControlsProps {
  chains: readonly WorkflowChainSummary[];
  botNameById: ReadonlyMap<string, string>;
  busyChainId?: string | null | undefined;
  onWrapUp: (chainId: string) => void;
  onStopWorkflow: (chainId: string) => void;
}

/**
 * Chain-scoped workflow lifecycle controls in the transcript header:
 * - Single active workflow: direct `Wrap up` and `Stop workflow` actions.
 * - Multiple active workflows: a compact chooser popover so the user selects
 *   which chain to close without guessing.
 */
export function WorkflowControls({
  chains,
  botNameById,
  busyChainId = null,
  onWrapUp,
  onStopWorkflow,
}: WorkflowControlsProps) {
  const t = useT();
  const [open, setOpen] = useState(false);

  if (chains.length === 0) return null;

  if (chains.length === 1) {
    const chain = chains[0]!;
    const busy = busyChainId === chain.chainId;
    const wrapping = chain.status === 'WRAPPING_UP';
    return (
      <div
        data-workflow-controls
        data-workflow-chain={chain.chainId}
        className="flex items-center gap-1.5"
      >
        {wrapping ? (
          <span
            data-workflow-wrapping-badge
            className="rounded-full bg-surface-secondary px-2.5 py-1 text-micro font-medium tabular-nums text-muted"
          >
            {t('transcript.workflow.wrappingUp', {
              done: chain.respondedOwners.length,
              total: chain.expectedOwners.length,
            })}
          </span>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            data-wrap-up-workflow
            isDisabled={busy}
            onPress={() => onWrapUp(chain.chainId)}
            className="h-7 gap-1 rounded-full px-2.5 text-caption font-medium"
          >
            <IconCheck aria-hidden className="size-3.5" stroke={1.9} />
            <span>{busy ? t('transcript.workflow.wrapping') : t('transcript.workflow.wrapUp')}</span>
          </Button>
        )}
        <Button
          size="sm"
          variant="danger-soft"
          data-stop-workflow
          isDisabled={busy}
          onPress={() => onStopWorkflow(chain.chainId)}
          className="h-7 gap-1 rounded-full px-2.5 text-caption font-medium"
        >
          <IconPlayerStop aria-hidden className="size-3.5" stroke={1.9} />
          <span>{busy ? t('transcript.workflow.stopping') : t('transcript.workflow.stop')}</span>
        </Button>
      </div>
    );
  }

  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <Button
          size="sm"
          variant="secondary"
          data-workflow-chooser
          className="h-7 gap-1 rounded-full px-2.5 text-caption font-medium"
        >
          <span>{t('transcript.workflow.choose', { count: chains.length })}</span>
          <IconChevronDown aria-hidden className="size-3.5" stroke={1.8} />
        </Button>
      </Popover.Trigger>
      <Popover.Content placement="bottom end" className="w-80 p-2">
        <Popover.Dialog aria-label={t('transcript.workflow.chooseHeading')}>
          <div className="mb-1.5 px-1.5 text-caption font-medium text-muted">
            {t('transcript.workflow.chooseHeading')}
          </div>
          <div className="flex flex-col gap-1.5">
            {chains.map((chain) => {
              const rootName = botNameById.get(chain.rootBotId) ?? chain.rootBotId;
              const busy = busyChainId === chain.chainId;
              const wrapping = chain.status === 'WRAPPING_UP';
              return (
                <div
                  key={chain.chainId}
                  data-workflow-option={chain.chainId}
                  className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface p-2"
                >
                  <div className="flex items-center justify-between gap-2 text-footnote">
                    <span className="truncate font-medium text-foreground">
                      {t('transcript.workflow.rootBy', { bot: rootName })}
                    </span>
                    <span className="shrink-0 text-micro tabular-nums text-muted">
                      {wrapping
                        ? t('transcript.workflow.wrappingUp', {
                            done: chain.respondedOwners.length,
                            total: chain.expectedOwners.length,
                          })
                        : t('transcript.workflow.participants', {
                            count: chain.participantBotIds.length,
                          })}
                    </span>
                  </div>
                  <div className="flex items-center justify-end gap-1.5">
                    {!wrapping ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        data-wrap-up-workflow={chain.chainId}
                        isDisabled={busy}
                        onPress={() => {
                          setOpen(false);
                          onWrapUp(chain.chainId);
                        }}
                        className="h-6 min-h-0 rounded-full px-2.5 text-micro font-medium"
                      >
                        {t('transcript.workflow.wrapUp')}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="danger-soft"
                      data-stop-workflow={chain.chainId}
                      isDisabled={busy}
                      onPress={() => {
                        setOpen(false);
                        onStopWorkflow(chain.chainId);
                      }}
                      className="h-6 min-h-0 rounded-full px-2.5 text-micro font-medium"
                    >
                      {t('transcript.workflow.stop')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
