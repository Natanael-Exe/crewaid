import { Button } from '@heroui/react';
import type { RecordingView } from '../state/chatReducer';
import { recordingCardPresentation, type RecordingCardAction } from './recordingCardState';

/**
 * The recording cluster in the full-screen viewer's footer (M3-FE-01,
 * M3-FE-02).
 *
 * Its own module for the same reason as `ScreenPlaceholder`: `ScreenCard`
 * imports noVNC at the top level and noVNC touches `window` on import, so the
 * suite that renders with `renderToStaticMarkup` cannot load it. The whole
 * decision lives in `recordingCardState`; this draws it.
 *
 * Start/stop lives HERE and not on the rail because this is the only surface
 * that takes input — a recording is a demonstration, and there is
 * nowhere else to demonstrate one. Review does not share that constraint (the
 * skill outlives the demonstration) but is announced on the same cluster,
 * because a finished recording's outcome is where the draft becomes known.
 */
export function RecordingControls({
  recording,
  live,
  onTeach,
  onStop,
  onDiscard,
  onReview,
}: {
  recording: RecordingView | undefined;
  live: boolean;
  onTeach: () => void;
  onStop: () => void;
  /** Throw the take away — live capture, running compile, or draft. */
  onDiscard: () => void;
  onReview: () => void;
}) {
  const presentation = recordingCardPresentation(recording, live);
  if (presentation.phase === 'idle' && presentation.actions.length === 0) return null;

  // One map per concern, keyed by the action the state module decided on —
  // the module owns WHAT is offered, this owns how a press and a weight are
  // spelled in HeroUI's vocabulary.
  const handlers: Record<RecordingCardAction['kind'], () => void> = {
    teach: onTeach,
    stop: onStop,
    discard: onDiscard,
    review: onReview,
  };
  const variants: Record<RecordingCardAction['emphasis'], 'primary' | 'ghost' | 'danger-soft'> = {
    primary: 'primary',
    quiet: 'ghost',
    danger: 'danger-soft',
  };

  return (
    <div
      data-recording-phase={presentation.phase}
      className="window-no-drag flex min-w-0 items-center gap-2 text-[12px]"
    >
      {presentation.indicator ? (
        <span
          data-recording-indicator
          aria-hidden="true"
          className="size-1.5 shrink-0 animate-pulse rounded-full bg-red-500"
        />
      ) : null}
      {presentation.label !== null ? (
        <span className="shrink-0 text-black">{presentation.label}</span>
      ) : null}
      {presentation.counter !== null ? (
        <span data-recording-counter className="shrink-0 text-black tabular-nums">
          {presentation.counter}
        </span>
      ) : null}
      {presentation.message !== null ? (
        // The one channel for facts the operator must not miss: the D-042
        // truncation sentence, the D-044 failure reason, a stop that did not
        // land, the name of the draft that is ready. `role="status"` is what
        // announces them, as `SkillReviewBody` already does for its own
        // notices — the counter beside it deliberately stays silent, because
        // it changes several times a second. `title` is there because the row
        // is shared with buttons and these sentences truncate; without it the
        // read that fetched the reason is hidden behind an ellipsis.
        <span
          data-recording-message
          role="status"
          title={presentation.message}
          className="min-w-0 truncate text-black"
        >
          {presentation.message}
        </span>
      ) : null}
      {presentation.actions.map((action) => (
        <Button
          key={action.kind}
          variant={variants[action.emphasis]}
          size="sm"
          isDisabled={action.disabled}
          data-recording-action={action.kind}
          onPress={handlers[action.kind]}
          className={`h-7 shrink-0 rounded-lg px-3 text-[12px] font-medium ${
            action.emphasis === 'quiet' ? 'text-black' : ''
          }`}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}
