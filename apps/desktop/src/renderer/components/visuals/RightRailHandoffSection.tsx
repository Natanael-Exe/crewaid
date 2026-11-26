import { Button } from '@heroui/react';
import { IconArrowUpRight, IconFileText, IconMessageQuestion } from '@tabler/icons-react';
import { useT } from '../../i18n/i18n';
import { formatPreviewInternalPaths } from '../markdown/internalPaths';
import type { HandoffActions, LatestHandoffSummary } from './HandoffBlock';

/**
 * Compact right-rail summary of the active conversation's latest handoff and
 * pending user decisions, occupying space recovered from the compact sleeping
 * Computer card.
 */
export function RightRailHandoffSection({
  handoff,
  onJumpToHandoff,
  actions,
}: {
  readonly handoff: LatestHandoffSummary;
  readonly onJumpToHandoff: (messageId: string) => void;
  readonly actions: HandoffActions;
}) {
  const t = useT();
  const pathLabel = t('tools.path');
  const clean = (value: string) => formatPreviewInternalPaths(value, pathLabel);
  const { block } = handoff;
  const openableFiles = block.readyToReview.filter(
    (item) =>
      item.status !== 'unpublished' &&
      (item.deliverableId !== undefined || item.attachmentId !== undefined),
  );

  return (
    <section
      data-rail-handoff
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-caption font-semibold text-foreground">
          {t('visuals.handoff.currentHandoff')}
        </h3>
        <Button
          size="sm"
          variant="ghost"
          data-rail-jump-handoff
          onPress={() => onJumpToHandoff(handoff.messageId)}
          className="h-6 min-h-0 rounded-full px-2 text-micro text-accent"
        >
          {t('visuals.handoff.jumpToCard')}
        </Button>
      </div>

      <p className="m-0 line-clamp-3 text-caption leading-[18px] text-muted">
        {clean(block.outcome)}
      </p>

      {openableFiles.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-micro font-medium text-muted">
            {t('visuals.handoff.readyToReview')} ({openableFiles.length})
          </span>
          {openableFiles.slice(0, 4).map((item, idx) => {
            const label = clean(item.label);
            return (
              <Button
                key={`${item.deliverableId ?? item.attachmentId ?? label}-${idx}`}
                size="sm"
                variant="ghost"
                data-rail-handoff-file
                onPress={() =>
                  actions.onOpenDeliverable?.({
                    label,
                    deliverableId: item.deliverableId,
                    attachmentId: item.attachmentId,
                  })
                }
                className="h-7 justify-between rounded-lg px-2 text-caption text-foreground"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <IconFileText aria-hidden className="size-3.5 shrink-0 text-muted" stroke={1.8} />
                  <span className="truncate">{label}</span>
                </span>
                <IconArrowUpRight aria-hidden className="size-3.5 shrink-0 text-muted" stroke={1.8} />
              </Button>
            );
          })}
        </div>
      ) : null}

      {block.waitingOnYou.length > 0 ? (
        <div
          data-rail-pending-decisions
          className="flex flex-col gap-2 border-t border-separator/70 pt-2.5"
        >
          <span className="flex items-center gap-1 text-micro font-medium text-accent">
            <IconMessageQuestion aria-hidden className="size-3.5" stroke={1.9} />
            <span>
              {t('visuals.handoff.pendingDecisions', { count: block.waitingOnYou.length })}
            </span>
          </span>
          {block.waitingOnYou.map((decision) => (
            <div key={decision.id} className="flex flex-col gap-1.5">
              <p className="m-0 text-caption font-medium text-foreground">
                {clean(decision.question)}
              </p>
              <div className="flex flex-wrap gap-1">
                {decision.options.map((option, idx) => (
                  <Button
                    key={`${decision.id}-${idx}`}
                    size="sm"
                    variant="secondary"
                    data-rail-decision-option={`${decision.id}:${idx}`}
                    onPress={() => actions.onReviewDecision?.(option.replyText)}
                    className="h-6 min-h-0 rounded-full px-2.5 text-micro font-medium"
                  >
                    {clean(option.label)}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
