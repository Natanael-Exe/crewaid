import type { BotWithSandbox } from '@crewaid/shared';
import type { WakeStatus } from '../state/chatReducer';
import { t } from '../i18n/i18n';

/**
 * What the screen surface should be showing, and how.
 *
 * Split from the component because everything interesting here is a decision
 * about a `Sandbox` row, and the component around it is a canvas noVNC owns —
 * untestable in this suite, which renders with `renderToStaticMarkup` and has
 * no DOM. Keeping the decision pure is what makes it testable at all.
 */
export type ScreenCardView =
  | { readonly kind: 'no-bot' }
  /** A computer that has never been started, or that idle stop put back down. */
  | { readonly kind: 'stopped'; readonly caption: string }
  | { readonly kind: 'starting'; readonly caption: string }
  /**
   * The host is full. Deliberately not `failed`: nothing about this
   * bot is wrong, the same request succeeds once a slot frees, and telling the
   * operator their computer is broken would send them looking for a fault that
   * is not there.
   */
  | { readonly kind: 'capacity'; readonly caption: string; readonly detail: string }
  /**
   * `detail` is copy already written for the operator — a wake refusal, which
   * D-093 normalised. `reason` is the raw diagnostic off the row, which was
   * not: it is kept so it can sit one hover away, never as the message.
   */
  | {
      readonly kind: 'failed';
      readonly caption: string;
      readonly detail: string | null;
      readonly reason: string | null;
    }
  | {
      readonly kind: 'live';
      readonly caption: string;
      readonly widthPx: number;
      readonly heightPx: number;
    };

/**
 * The one thing the operator can press on a card with no picture.
 *
 * `open` and `retry` do exactly the same thing, and the difference is only the
 * sentence: a computer that has never been asked for is not a computer that
 * refused, and offering "Try again" for the first attempt implies a failure
 * that never happened.
 */
export interface ScreenCardAction {
  readonly kind: 'open' | 'retry';
  readonly label: string;
}

/**
 * The §4.3 quality the rail thumbnail asks for.
 *
 * A thumbnail a few hundred pixels wide cannot show the difference a higher
 * setting buys, and the shared stream settles on the MAXIMUM any subscriber
 * requested — so asking low here costs the operator's full-screen
 * view nothing while keeping the rail cheap when it is the only viewer.
 */
export const THUMBNAIL_QUALITY = 3;

/**
 * The §4.3 quality the full-screen viewer asks for — the top of the 0..9 range.
 *
 * This is the only view where the desktop is rendered near 1:1, so it is the
 * only one where Tight's JPEG artefacts land on things the operator has to
 * read: a terminal's output, a URL bar, a file name. The acceptance criterion
 * is literally "click the terminal icon, type `touch /home/bot/proof.txt`" —
 * which is not a thing you can do against a picture you cannot read.
 *
 * The cost is bounded and temporary: one desktop, only while the viewer is
 * open, dropping back to {@link THUMBNAIL_QUALITY} the moment it closes.
 */
export const FULLSCREEN_QUALITY = 9;

/**
 * R8, as this renderer implements it: scale the PICTURE, never the display.
 *
 * A named constant rather than two assignments buried in an effect, because
 * the pair only means R8 together — `scaleViewport` alone is a preference, and
 * `resizeSession: true` alone would have noVNC negotiate a new framebuffer
 * size with the server the first time the viewer is not exactly 1280x800.
 *
 * Nothing enforces this at the protocol level for the good reason that nothing
 * has to: `RfbChannel` is a dead end for client messages, so a SetDesktopSize
 * noVNC produced would be refused there rather than reaching x11vnc (see the
 * R8 case in `rfbChannel.test.ts`). This constant keeps it from getting that
 * far, and keeps the reason next to the values.
 */
export const VIEWER_DISPLAY_POLICY = {
  scaleViewport: true,
  resizeSession: false,
} as const;

/** The whole presentation: what to draw, where, and at what §4.3 quality. */
export interface ScreenCardPresentation {
  readonly view: ScreenCardView;
  /** The full-window overlay rather than the rail's card. */
  readonly expanded: boolean;
  /** WebSocket `screen.subscribe` quality for the surface currently showing. */
  readonly quality: number;
  /** Whether the expand affordance is offered at all. */
  readonly canExpand: boolean;
  /** Whether this surface forwards the operator's input to the sandbox. */
  readonly interactive: boolean;
  /** Header text for both surfaces. */
  readonly caption: string;
  /** Copy for the states with no picture; `null` while one is live. */
  readonly placeholder: string | null;
  /**
   * The raw reason behind `placeholder`, for a title attribute — never the
   * message itself. `null` whenever the placeholder is already the whole story.
   */
  readonly placeholderDetail: string | null;
  /** The affordance offered on a card with no picture; `null` when busy or live. */
  readonly action: ScreenCardAction | null;
}

/**
 * What this card should be showing, from the durable row and the operator's
 * own outstanding request.
 *
 * The two are separate inputs because they can disagree, and the disagreement
 * is the interesting moment: for the first beat after a click the row still
 * honestly says `STOPPED`, and rendering that would answer "open this
 * computer" with "the computer is not open". The row is read on its own
 * below, then the request is laid over it in the order the operator
 * experiences.
 */
export function screenCardView(
  bot: BotWithSandbox | null,
  wake: WakeStatus | undefined = undefined,
): ScreenCardView {
  if (bot === null) return { kind: 'no-bot' };
  const durable = durableView(bot);

  // 1. A live picture wins outright. Something is on screen, and nothing said
  // about a request can be more useful than the desktop itself — a wake
  // that resolves against an already-running computer is exactly what
  // The idempotent ensure-ready is for.
  if (durable.kind === 'live' || wake === undefined) return durable;
  // 2. Then anything in flight, whether the row knows about it yet or not.
  if (wake.kind === 'waking') return { kind: 'starting', caption: durable.caption };
  // 3. The row's own STARTING outranks a stale refusal: something is coming up.
  if (durable.kind === 'starting') return durable;
  // 4. Then the refusal, capacity kept distinct from failure.
  return wake.kind === 'capacity'
    ? { kind: 'capacity', caption: durable.caption, detail: wake.message }
    : { kind: 'failed', caption: durable.caption, detail: wake.message, reason: null };
}

/** Everything but `no-bot`, which is a fact about the shell rather than a row. */
type DurableScreenCardView = Exclude<ScreenCardView, { kind: 'no-bot' }>;

/** What the `Sandbox` row alone says, with no request of the operator's in it. */
function durableView(bot: BotWithSandbox): DurableScreenCardView {
  const caption = t('screen.screenCardState.botsScreen', { botName: bot.name });
  const sandbox = bot.sandbox;

  // A bot with no `Sandbox` row has never been started. That is the same
  // situation as STOPPED for this card, and saying "no sandbox" would be
  // describing our schema rather than anything the operator can act on.
  if (sandbox === null) return { kind: 'stopped', caption };

  switch (sandbox.state) {
    case 'RUNNING':
      return { kind: 'live', caption, widthPx: sandbox.widthPx, heightPx: sandbox.heightPx };
    case 'STARTING':
      return { kind: 'starting', caption };
    case 'STOPPED':
      return { kind: 'stopped', caption };
    case 'UNHEALTHY':
    case 'ERROR':
      // `lastError` is the only place the reason survives — the WebSocket frame that
      // announced the transition is long gone by the time anyone looks — but it
      // is a DIAGNOSTIC, not a message, so it travels as `reason` and the card
      // says something the operator can act on instead.
      return { kind: 'failed', caption, detail: null, reason: sandbox.lastError };
  }
}

/**
 * Fold the sandbox state and the operator's expand request into one shape.
 *
 * Two things here are decisions rather than plumbing:
 *
 * - **A desktop that dies does not close the viewer.** `expanded` follows
 * what the operator asked for, not what there is to see, so a sandbox that
 * falls over while the viewer is open leaves the reason on screen instead
 * of dumping the operator back to the rail with nothing to read.
 * - **Quality follows the surface, not the subscription.** The two surfaces
 * are one subscription that changes level, so this is the whole of
 * the difference between them on the wire.
 * - **Only the full-screen surface takes input**. The rail
 * is a thumbnail a few hundred pixels wide, and `scaleViewport` means a
 * click in it is multiplied up to somewhere the operator never aimed —
 * onto a desktop they are watching out of the corner of their eye. It is
 * view-only so that a glance cannot become a keystroke, not because
 * forwarding from there would be hard.
 */
export function screenCardPresentation(
  bot: BotWithSandbox | null,
  expanded: boolean,
  wake: WakeStatus | undefined = undefined,
): ScreenCardPresentation {
  const view = screenCardView(bot, wake);
  return {
    view,
    expanded,
    quality: expanded ? FULLSCREEN_QUALITY : THUMBNAIL_QUALITY,
    // Expanding a placeholder would be a full-window box saying "not running".
    canExpand: view.kind === 'live',
    interactive: expanded && view.kind === 'live',
    caption: view.kind === 'no-bot' ? t('screen.screenCardState.noBotSelected') : view.caption,
    placeholder: placeholderFor(view),
    placeholderDetail: view.kind === 'failed' ? view.reason : null,
    action: actionFor(view),
  };
}

/**
 * What the operator reads when a computer is unwell.
 *
 * `Sandbox.lastError` is written for whoever is debugging the HOST. It names
 * the runtime id, the Docker volume and the recovery action in the
 * reconciliation sweep's own vocabulary — "Runtime cmu5xx… is missing;
 * workspace crewaid-workspace-cmu5xx… was preserved. Replacement requires an
 * explicit start/recovery action." Every noun in it is a thing the person
 * looking at this card cannot reach, and none of it answers what to do next.
 *
 * It is not deleted, because the operator of a self-hosted product is often
 * also the person who runs the server: it stays on the row, in the
 * orchestrator log, and one hover away on this card. It is simply not the
 * sentence.
 *
 * "Try again" is deliberately absent from the words — the button underneath
 * already is that, and D-093 asks for ONE next move, not the same move twice.
 */
function placeholderFor(view: ScreenCardView): string | null {
  switch (view.kind) {
    case 'live':
      return null;
    case 'no-bot':
      return t('screen.screenCardState.noBotSelected');
    case 'starting':
      return t('screen.screenCardState.wakingTheComputer');
    // Not "start it" — the computer wakes for whatever needs it, so what the
    // operator is being told is where it is, not that they forgot a step.
    case 'stopped':
      return t('screen.screenCardState.thisComputerIsAsleep');
    case 'capacity':
      return view.detail;
    case 'failed':
      return view.detail ?? t('screen.screenCardState.machineFailed');
  }
}

/**
 * The one press this card offers, and the states that deliberately offer none.
 *
 * There is no Stop. D-041 made waking automatic and idle stop the way a
 * computer goes back down, so a Stop button would be a lifecycle chore the
 * product exists to remove — and a press that could pull the desktop out from
 * under an agent turn or a recording still using it.
 */
function actionFor(view: ScreenCardView): ScreenCardAction | null {
  switch (view.kind) {
    // Nothing to ask for: one is already awake, one has no bot, and one is
    // already on its way — a second press would only ask the same question.
    case 'live':
    case 'no-bot':
    case 'starting':
      return null;
    case 'stopped':
      return { kind: 'open', label: t('screen.screenCardState.openComputer') };
    case 'capacity':
    case 'failed':
      return { kind: 'retry', label: t('screen.screenCardState.tryAgain') };
  }
}
