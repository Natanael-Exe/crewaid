import type { ReactNode } from 'react';
import { IconChevronRight } from '@tabler/icons-react';
import {
  partField,
  registerPartRenderer,
  type AnyPart,
  type PartRenderContext,
} from './PartRenderer';
import { StreamingMarkdown } from './markdown/StreamingMarkdown';
import { useT } from '../i18n/i18n';

/**
 * The model's thinking, as something a person reads past rather than
 * through.
 *
 * `reasoning` parts have always been persisted (PRD M1 stores the SDK's parts
 * verbatim) and, until this renderer existed, the registry's fallback printed
 * `[unsupported part type: reasoning]` into the transcript — twice per step on
 * a reasoning model, which is what the operator actually saw.
 *
 * ONE state, collapsed, live or settled. The first cut showed live thinking
 * outright, on the theory that it is the only sign of life between one
 * sentence and the next — and on a reasoning model that turned the transcript
 * into a wall of working-out that pushed the answer off screen while it was
 * still being written, which is worse than the silence it replaced. What
 * actually answers "is it alive" is the working row, which says
 * how long it has been going; the thinking itself is evidence to open when an
 * answer is surprising, so it starts closed and stays that way until somebody
 * opens it — including while the turn is running.
 *
 * The body is capped and scrolls on its own. A long thought can run to
 * thousands of words, and expanding one must not turn the transcript into a
 * page of it: the row takes at most a screen-third, and the rest is read by
 * scrolling inside the box, which also keeps the transcript's own scroll (and
 * its tail-follow) where the operator left them.
 *
 * It is NOT in a bubble. A bubble is something the bot said to the operator;
 * thinking is work in progress, and giving it the same treatment as speech is
 * how a transcript turns into a log.
 */

/** A run of adjacent thinking, folded into one row. */
export interface ReasoningBlockPart {
  type: 'reasoning-block';
  text: string;
  /** Present only while the run is still arriving. */
  state?: 'streaming';
  [key: string]: unknown;
}

function textOf(part: AnyPart): string {
  const text = partField(part, 'text');
  return typeof text === 'string' ? text : '';
}

function isReasoning(part: AnyPart): boolean {
  return part.type === 'reasoning' || part.type === 'reasoning-block';
}

/**
 * Fold adjacent `reasoning` parts into one row, in place.
 *
 * ADJACENT, not all of them: a run of thinking that was interrupted by a
 * sentence the bot said, or by a tool call, is a separate pause to think, and
 * merging the two would attach the reasoning from before an action to the
 * reasoning from after it.
 *
 * A run is joined with a blank line rather than concatenated. The SDK emits
 * one part per reasoning block, so the parts are paragraphs — pasted together
 * they are the same run-on wall this fold exists to break up.
 */
export function groupReasoning(parts: readonly AnyPart[]): AnyPart[] {
  const grouped: AnyPart[] = [];
  let run: AnyPart[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    const texts = run.map(textOf).filter((text) => text !== '');
    if (texts.length > 0) {
      const streaming = run.some((part) => partField(part, 'state') === 'streaming');
      const block: ReasoningBlockPart = {
        type: 'reasoning-block',
        text: texts.join('\n\n'),
        ...(streaming ? { state: 'streaming' as const } : {}),
      };
      grouped.push(block);
    }
    run = [];
  };

  for (const part of parts) {
    if (isReasoning(part)) {
      run.push(part);
      continue;
    }
    flush();
    grouped.push(part);
  }
  flush();
  return grouped;
}

/**
 * How tall the opened body may get before it scrolls on its own.
 *
 * Sixteen lines of the same 19px rhythm the transcript uses: enough to read a
 * real stretch of reasoning without turning the row into a page, and small
 * enough that the answer above it never leaves the screen.
 */
const REASONING_BODY_MAX_HEIGHT_CLASS = 'max-h-[320px]';

export function ReasoningPart({
  part,
  context,
}: {
  part: AnyPart;
  context?: PartRenderContext | undefined;
}): ReactNode {
  const t = useT();
  const text = textOf(part);
  if (text === '') return null;
  const streaming = partField(part, 'state') === 'streaming';

  return (
    <details
      data-reasoning={streaming ? 'streaming' : 'settled'}
      className="group/reasoning my-1.5 text-[12px] text-muted"
    >
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md py-1 pe-2 select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus/60 [&::-webkit-details-marker]:hidden">
        <IconChevronRight
          aria-hidden
          className="size-3.5 transition-transform duration-200 group-open/reasoning:rotate-90 rtl:group-open/reasoning:-rotate-90 motion-reduce:transition-none rtl:-scale-x-100"
          stroke={1.8}
        />
        <span>{streaming ? t('reasoning.thinking') : t('reasoning.thought')}</span>
      </summary>
      <div className="mt-1 max-w-[72%] border-s-2 border-current/15 ps-2.5 text-[13px] leading-[19px]">
        <div
          data-reasoning-body
          // `overscroll-contain`: the box scrolls, and reaching its end must
          // not hand the gesture to the transcript underneath — which is
          // following the tail, and would answer a flick through the thinking
          // by moving the conversation.
          className={`${REASONING_BODY_MAX_HEIGHT_CLASS} overflow-y-auto overscroll-contain pe-1.5`}
        >
          <StreamingMarkdown source={text} streaming={context?.streaming === true} />
        </div>
      </div>
    </details>
  );
}

// Both the raw SDK part and the folded run resolve to the same renderer: a
// history page that starts mid-run hands over a lone `reasoning` part, and it
// should read as thinking rather than as nothing.
registerPartRenderer('reasoning', ReasoningPart);
registerPartRenderer('reasoning-block', ReasoningPart);
