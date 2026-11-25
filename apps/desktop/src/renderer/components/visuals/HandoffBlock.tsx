import { Button, Chip } from '@heroui/react';
import {
  IconAlertCircle,
  IconArrowUpRight,
  IconCheck,
  IconFileText,
  IconMessageQuestion,
} from '@tabler/icons-react';
import {
  resolveVisualForRender,
  type VisualHandoffBlock,
  type VisualHandoffItem,
} from '@crewaid/shared';
import { useT } from '../../i18n/i18n';
import type { TranscriptMessage } from '../../state/viewTypes';
import { formatPreviewInternalPaths } from '../markdown/internalPaths';
import { resultValue } from '../tools/toolPresentation';
import {
  isFoldedToolPart,
  partField,
  type FoldedToolPart,
  type ToolActivityPart,
} from '../tools/toolParts';

export interface HandoffArtifactTarget {
  readonly label: string;
  readonly deliverableId?: string | undefined;
  readonly attachmentId?: string | undefined;
}

export interface HandoffActions {
  readonly onOpenDeliverable?: ((target: HandoffArtifactTarget) => void) | undefined;
  readonly onReviewDecision?: ((replyText: string) => void) | undefined;
}

export interface LatestHandoffSummary {
  readonly messageId: string;
  readonly title: string | undefined;
  readonly block: VisualHandoffBlock;
  readonly revisionCount: number;
}

function toolCallsInPart(part: TranscriptMessage['parts'][number]): readonly (FoldedToolPart | TranscriptMessage['parts'][number])[] {
  if (part.type === 'tool-activity') {
    const calls = (part as Partial<ToolActivityPart>).calls;
    return Array.isArray(calls) ? calls : [];
  }
  if (part.type === 'tool-call' || part.type === 'tool-invocation') {
    return [part];
  }
  return [];
}

/**
 * Finds the most recent valid `handoff` block across a thread's messages
 * (preserving older revisions in transcript history while keeping the latest
 * handoff one click away in the right rail).
 */
export function extractLatestHandoff(
  messages: readonly TranscriptMessage[],
): LatestHandoffSummary | null {
  let latest: LatestHandoffSummary | null = null;
  let count = 0;
  for (const msg of messages) {
    for (const part of msg.parts) {
      for (const candidate of toolCallsInPart(part)) {
        const toolName = isFoldedToolPart(candidate)
          ? candidate.toolName
          : typeof partField(candidate, 'toolName') === 'string'
            ? (partField(candidate, 'toolName') as string)
            : undefined;
        if (toolName !== 'present_visual') continue;
        const input = isFoldedToolPart(candidate) ? candidate.input : partField(candidate, 'input');
        const output = isFoldedToolPart(candidate)
          ? candidate.output
          : partField(candidate, 'output');
        const payload = resolveVisualForRender(input, resultValue(output));
        if (payload === null) continue;
        for (const block of payload.blocks) {
          if (block.kind === 'handoff') {
            count += 1;
            latest = {
              messageId: msg.id,
              title: payload.title,
              block,
              revisionCount: count,
            };
          }
        }
      }
    }
  }
  return latest;
}

function isOpenableItem(item: VisualHandoffItem): boolean {
  return (
    item.status !== 'unpublished' &&
    (item.deliverableId !== undefined || item.attachmentId !== undefined)
  );
}

/**
 * First-class structured handoff block rendered in strict section order:
 * Outcome -> Ready to review -> Still open -> Waiting on you.
 */
export function HandoffBlock({
  block,
  actions,
}: {
  readonly block: VisualHandoffBlock;
  readonly actions?: HandoffActions | undefined;
}) {
  const t = useT();
  const pathLabel = t('tools.path');
  const clean = (value: string) => formatPreviewInternalPaths(value, pathLabel);

  const publishedCount = block.readyToReview.filter(
    (item) => item.status === 'published' && isOpenableItem(item),
  ).length;
  const totalCount = block.readyToReview.length;

  return (
    <div
      data-handoff-card
      data-handoff-revision={block.revision}
      className="flex flex-col gap-4"
    >
      {/* 1. Outcome */}
      <section data-handoff-section="outcome" className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h4 className="m-0 text-micro font-semibold uppercase tracking-[0.04em] text-muted">
            {t('visuals.handoff.outcome')}
          </h4>
          {block.revision !== undefined ? (
            <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-micro tabular-nums text-muted">
              {t('visuals.handoff.revision', { version: block.revision })}
            </span>
          ) : null}
        </div>
        <p className="m-0 text-body leading-[22px] text-foreground">{clean(block.outcome)}</p>
      </section>

      {/* 2. Ready to review */}
      {totalCount > 0 ? (
        <section
          data-handoff-section="ready-to-review"
          className="flex flex-col gap-2 border-t border-separator/70 pt-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h4 className="m-0 text-micro font-semibold uppercase tracking-[0.04em] text-muted">
              {t('visuals.handoff.readyToReview')}
            </h4>
            <span
              data-handoff-filed-count
              className="text-micro tabular-nums text-muted"
            >
              {t('visuals.handoff.filedCount', { ready: publishedCount, total: totalCount })}
            </span>
          </div>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {block.readyToReview.map((item, idx) => {
              const openable = isOpenableItem(item);
              const displayLabel = clean(item.label);
              return (
                <li
                  key={`${item.deliverableId ?? item.attachmentId ?? item.label}-${idx}`}
                  data-handoff-artifact
                  data-artifact-status={item.status}
                  data-deliverable-id={item.deliverableId}
                  className="flex items-center justify-between gap-2 rounded-xl border border-border/80 bg-surface-secondary/50 px-3 py-2"
                >
                  <div className="flex min-w-0 flex-1 items-start gap-2">
                    <IconFileText
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-muted"
                      stroke={1.7}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-footnote font-medium text-foreground">
                          {displayLabel}
                        </span>
                        {item.version !== undefined ? (
                          <span className="text-micro tabular-nums text-muted">
                            {t('visuals.handoff.revision', { version: item.version })}
                          </span>
                        ) : null}
                        {item.status === 'unpublished' ? (
                          <Chip size="sm" variant="soft" color="default" className="h-4 px-1.5">
                            <Chip.Label className="text-micro">
                              {t('visuals.handoff.unpublished')}
                            </Chip.Label>
                          </Chip>
                        ) : item.status === 'superseded' ? (
                          <Chip size="sm" variant="soft" color="warning" className="h-4 px-1.5">
                            <Chip.Label className="text-micro">
                              {t('visuals.handoff.superseded')}
                            </Chip.Label>
                          </Chip>
                        ) : null}
                      </div>
                      {item.owner !== undefined || item.note !== undefined ? (
                        <p className="m-0 mt-0.5 truncate text-micro text-muted">
                          {[item.owner, item.note === undefined ? undefined : clean(item.note)]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {openable ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      data-handoff-open
                      onPress={() =>
                        actions?.onOpenDeliverable?.({
                          label: displayLabel,
                          deliverableId: item.deliverableId,
                          attachmentId: item.attachmentId,
                        })
                      }
                      className="h-7 shrink-0 gap-1 rounded-full px-2.5 text-caption font-medium"
                    >
                      <span>{t('visuals.handoff.open')}</span>
                      <IconArrowUpRight aria-hidden className="size-3.5" stroke={1.8} />
                    </Button>
                  ) : (
                    <span className="shrink-0 text-micro text-muted">
                      {t('visuals.handoff.notAttached')}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* 3. Still open */}
      {block.stillOpen.length > 0 ? (
        <section
          data-handoff-section="still-open"
          className="flex flex-col gap-1.5 border-t border-separator/70 pt-3"
        >
          <h4 className="m-0 text-micro font-semibold uppercase tracking-[0.04em] text-muted">
            {t('visuals.handoff.stillOpen')}
          </h4>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {block.stillOpen.map((open, idx) => (
              <li
                key={`${open.item}-${idx}`}
                className="flex items-start gap-2 text-footnote text-foreground"
              >
                <IconAlertCircle
                  aria-hidden
                  className="mt-0.5 size-3.5 shrink-0 text-muted"
                  stroke={1.8}
                />
                <div className="min-w-0 flex-1">
                  <span>{clean(open.item)}</span>
                  {open.owner !== undefined ? (
                    <span className="ms-1.5 text-micro text-muted">· {open.owner}</span>
                  ) : null}
                  {open.blocker !== undefined ? (
                    <p className="m-0 mt-0.5 text-micro text-muted">{clean(open.blocker)}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 4. Waiting on you — Review-then-send decisions (visually distinct from tool approvals) */}
      {block.waitingOnYou.length > 0 ? (
        <section
          data-handoff-section="waiting-on-you"
          className="flex flex-col gap-2.5 border-t border-separator/70 pt-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h4 className="m-0 flex items-center gap-1.5 text-micro font-semibold uppercase tracking-[0.04em] text-accent">
              <IconMessageQuestion aria-hidden className="size-3.5" stroke={1.9} />
              <span>{t('visuals.handoff.waitingOnYou')}</span>
            </h4>
            <span className="text-micro text-muted">{t('visuals.handoff.reviewThenSendHint')}</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {block.waitingOnYou.map((decision) => (
              <div
                key={decision.id}
                data-decision-card={decision.id}
                className="flex flex-col gap-2 rounded-xl border border-accent/25 bg-accent/5 px-3.5 py-3"
              >
                <p className="m-0 text-footnote font-semibold text-foreground">
                  {clean(decision.question)}
                </p>
                {decision.recommendation !== undefined ? (
                  <p className="m-0 flex items-start gap-1.5 text-caption text-foreground">
                    <IconCheck
                      aria-hidden
                      className="mt-0.5 size-3.5 shrink-0 text-accent"
                      stroke={2}
                    />
                    <span>
                      <strong className="font-medium">
                        {t('visuals.handoff.recommendation')}:
                      </strong>{' '}
                      {clean(decision.recommendation)}
                    </span>
                  </p>
                ) : null}
                {decision.consequence !== undefined ? (
                  <p className="m-0 text-caption text-muted">
                    <strong className="font-medium text-foreground">
                      {t('visuals.handoff.consequence')}:
                    </strong>{' '}
                    {clean(decision.consequence)}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {decision.options.map((option, idx) => (
                    <Button
                      key={`${decision.id}-${idx}`}
                      size="sm"
                      variant="secondary"
                      data-decision-option={`${decision.id}:${idx}`}
                      onPress={() => actions?.onReviewDecision?.(option.replyText)}
                      className="h-7 rounded-full border border-border bg-surface px-3 text-caption font-medium text-foreground hover:border-accent/50"
                    >
                      {clean(option.label)}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
