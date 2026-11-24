import { Button } from '@heroui/react';
import { IconArrowsDiagonal, IconLoader2, IconX } from '@tabler/icons-react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { FocusScope } from 'react-aria';
import type { BotWithSandbox, ScreenControlStatePayload } from '@crewaid/shared';
import RFB from '@novnc/novnc';
import type { RecordingView, WakeStatus } from '../state/chatReducer';
import type { BotMutation, OpenScreenStream, SeatControlRequest } from '../state/useChat';
import type { ScreenStreamHandle } from './screenStreamClient';
import { HeldInput } from './heldInput';
import { RecordingControls } from './RecordingControls';
import { hasFramebufferRectangles, RfbChannel } from './rfbChannel';
import { ScreenPlaceholder } from './ScreenPlaceholder';
import {
  SEAT_CONTROL_LABELS,
  SEAT_RENEW_EVERY_MS,
  seatControlView,
  type SeatControlView,
} from './seatControlState';
import { screenCardPresentation, VIEWER_DISPLAY_POLICY } from './screenCardState';
import { useT } from '../i18n/i18n';

export interface ScreenCardProps {
  readonly bot: BotWithSandbox | null;
  /** The full-window viewer is open. Owned by the shell, not by this card. */
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  /** WebSocket `screen.subscribe`, which makes this window a watcher; returns the unsubscribe. */
  readonly watchScreen: (botId: string) => () => void;
  readonly sendScreenInput: (botId: string, rfb: Uint8Array) => boolean;
  /** The desktop's pixels, on a stream of their own. */
  readonly openScreenStream: OpenScreenStream;
  /** How this bot's outstanding wake is going, if there is one. */
  readonly wake: WakeStatus | undefined;
  /** The operator explicitly asking for this computer. */
  readonly onWake: (botId: string) => void;
  readonly onReleaseIdentity?: (botId: string) => Promise<BotMutation<void>>;
  /** The teaching flow for this bot, as `chatReducer` assembled it. */
  readonly recording: RecordingView | undefined;
  /** "Teach a task" — starts a recording from the full-screen view. */
  readonly onTeachTask: () => void;
  /** Stop the recording and settle its outcome. */
  readonly onStopRecording: () => void;
  /** Throw the take away — recording, compile or finished draft. */
  readonly onDiscardRecording: () => void;
  /** Open the review surface for the draft a recording compiled. */
  readonly onReviewSkill: () => void;
  /** Who drives this bot's seat, as the server last said. */
  readonly seatControl: ScreenControlStatePayload | undefined;
  /** Take, renew or release this window's control of the seat. */
  readonly controlScreen: (botId: string, request: SeatControlRequest) => void;
}

/**
 * The bot's live desktop (M2-FE-01 thumbnail, M2-FE-02 full-screen viewer).
 *
 * noVNC decodes; this component only owns the lifecycle around it —
 * subscribe, feed, tear down — and the states where there is nothing to show.
 *
 * Why the wake lives on this card and nowhere else (,)
 *
 * §16 names exactly one UI gesture that may wake a computer: explicitly
 * opening it from its rail card. Selecting a bot, rendering this card,
 * subscribing to frames and health polling are all listed as things that must
 * NOT — and the reason is arithmetic rather than taste. The rail card is
 * mounted for whichever bot is selected, and the sidebar's thumbnails are one
 * subscription each: a wake triggered by rendering would start a container for
 * every bot the operator clicked past, on a host whose ceiling is six.
 *
 * So the wake is a button, and it is the only caller. Mounting this component
 * issues no request; neither does expanding, which stays available only for a
 * desktop that is already live.
 *
 * Why expanding is a restyle and not a second viewer
 *
 * The rail thumbnail and the full-screen viewer are ONE viewer wearing two
 * sets of classes, on the same DOM node, driving the same noVNC instance. They
 * are not two components, and they are deliberately not two streams: each
 * stream is a connection the server encodes for, and a second one would make
 * the server replace its upstream and repaint both for nothing.
 *
 * A quality change is a message on the open stream, not a reconnect. The
 * server re-encodes in place, preserving both ends' compression dictionaries
 * across every expand and collapse.
 *
 * Why the canvas is keyed on the sandbox
 *
 * Everything below the effect is disposable: an RFB connection cannot be
 * repointed at a different desktop, and a restarted sandbox is a different
 * desktop even when the bot is the same. Selecting another bot, or a restart
 * that changes the geometry, therefore builds a new viewer rather than
 * reconfiguring the old one — which is also what keeps the synthetic
 * ServerInit honest, since it declares a geometry captured at mount.
 */
export function ScreenCard({
  bot,
  expanded,
  onExpandedChange,
  watchScreen,
  sendScreenInput,
  openScreenStream,
  wake,
  onWake,
  onReleaseIdentity,
  recording,
  onTeachTask,
  onStopRecording,
  onDiscardRecording,
  onReviewSkill,
  seatControl,
  controlScreen,
}: ScreenCardProps) {
  const t = useT();
  const presentation = screenCardPresentation(bot, expanded, wake);
  const { view, caption, placeholder, placeholderDetail, canExpand, quality, interactive, action } =
    presentation;
  const live = view.kind === 'live' ? view : null;
  const botId = bot?.id ?? null;
  const control = seatControlView(seatControl);
  const controlKnown = seatControl !== undefined;
  // The full-screen view takes input only while this window holds the
  // seat. Watching is never permission to drive.
  const driving = interactive && control.kind === 'driving';
  useSeatLease(expanded && botId !== null ? botId : null, control, controlScreen);
  const expandRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [controlNotice, setControlNotice] = useState<{
    readonly message: string;
    readonly hint: boolean;
  } | null>(null);
  const previousControl = useRef({ botId, kind: control.kind });

  useEffect(() => {
    const previous = previousControl.current;
    previousControl.current = { botId, kind: control.kind };
    if (!expanded || previous.botId !== botId || !controlKnown) {
      setControlNotice(null);
      return;
    }
    if (previous.kind === control.kind) return;
    if (control.kind === 'driving') {
      setControlNotice({
        message: t('screen.screenCard.youAreInControlBot'),
        hint: false,
      });
    } else if (
      control.kind === 'available' &&
      (previous.kind === 'driving' || previous.kind === 'taking')
    ) {
      setControlNotice({
        message: t('screen.screenCard.theBotHasControlAgain'),
        hint: false,
      });
    } else {
      setControlNotice(null);
    }
  }, [botId, control.kind, controlKnown, expanded]);

  useEffect(() => {
    if (controlNotice === null) return;
    const timeout = window.setTimeout(() => setControlNotice(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [controlNotice]);

  // Escape closes, which is the only way out that does not need a mouse.
  // Bound to the WINDOW and in the CAPTURE phase, which is what makes it work
  // at all now that the picture takes keystrokes. noVNC grabs keydown on its
  // own canvas and calls `preventDefault` on everything it forwards, so a
  // card-scoped or bubbling handler would see Escape only after noVNC had
  // already sent it to the sandbox — leaving the operator with no way out that
  // the remote desktop could not swallow first. Capturing at the window runs
  // ahead of the canvas, and `stopPropagation` is what keeps this one key
  // local while every other key still reaches the desktop.
  useEffect(() => {
    if (!expanded) return undefined;
    // A live desktop focuses its own canvas (see ScreenViewer) because that is
    // the only element keystrokes are useful to. A placeholder has nothing to
    // type into, and a contained focus scope with nothing focused would trap
    // the keyboard, so the close button is the landing place there.
    if (!interactive) closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onExpandedChange(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      expandRef.current?.focus();
    };
  }, [expanded, interactive, onExpandedChange]);

  return (
    <FocusScope contain={expanded}>
      <div
        // One node, two presentations. Swapping the classes rather than the
        // element is what lets noVNC keep its canvas across the transition —
        // see the D-037 note above.
        data-screen-surface={expanded ? 'fullscreen' : 'rail'}
        {...(expanded
          ? { role: 'dialog' as const, 'aria-modal': true, 'aria-label': caption }
          : {})}
        className={
          expanded
            ? 'fixed inset-0 z-50 flex flex-col-reverse bg-background text-foreground'
            : 'flex flex-col overflow-hidden rounded-card border border-border bg-surface text-surface-foreground'
        }
      >
        <div
          onPointerDownCapture={(event) => {
            if (
              expanded &&
              control.kind === 'available' &&
              event.target instanceof Element &&
              event.target.closest('[data-screen-state="live"]') !== null
            ) {
              setControlNotice({
                message: t('screen.screenCard.clickTakeControlAboveTo'),
                hint: true,
              });
            }
          }}
          className={
            expanded
              ? 'crewaid-screen-ambient relative min-h-0 w-full flex-1'
              : 'crewaid-screen-ambient relative aspect-[16/10] w-full'
          }
          // The computer's own desktop: its pixels and pointer geometry are left to right.
          dir="ltr"
        >
          {live === null || botId === null ? (
            <ScreenPlaceholder
              kind={view.kind}
              message={placeholder ?? caption}
              detail={placeholderDetail}
              action={botId === null ? null : action}
              onAct={botId === null ? undefined : () => onWake(botId)}
            />
          ) : (
            <ScreenViewer
              // A restart is a new desktop even for the same bot; the geometry is
              // in the key because the ServerInit already went out with the old
              // one. `expanded` is deliberately NOT in the key.
              key={`${botId}:${live.widthPx}x${live.heightPx}`}
              botId={botId}
              widthPx={live.widthPx}
              heightPx={live.heightPx}
              name={live.caption}
              quality={quality}
              interactive={driving}
              watchScreen={watchScreen}
              sendScreenInput={sendScreenInput}
              openScreenStream={openScreenStream}
            />
          )}
          {!expanded && canExpand ? (
            /*
             * A plain button, and deliberately not HeroUI's. The shared button
             * chrome answers a press by scaling itself — `.button:active {
             * transform: scale(0.97) }` — and this is the whole screen: the
             * flinch reads as the desktop being dragged, and it pulls the
             * rounded corners in with it. The press feedback here is the veil's
             * own opacity instead, which changes no geometry (and a utility
             * could not have overridden that scale: HeroUI's stylesheet is
             * unlayered, so it beats every layered Tailwind class).
             *
             * `flex items-center justify-center` is what `.button` used to
             * contribute: without a flex container the label below is a block
             * and stretches the full width of the screen.
             */
            <button
              ref={expandRef}
              type="button"
              aria-label={t('screen.screenCard.viewFullScreen')}
              onClick={() => onExpandedChange(true)}
              className="group absolute inset-0 z-20 flex h-full w-full min-w-0 cursor-pointer items-center justify-center rounded-t-card rounded-b-none bg-transparent p-0 text-white select-none transition-colors duration-200 hover:bg-black/15 focus-visible:bg-black/15 active:bg-black/25"
            >
              <span
                data-screen-open-label="true"
                className="flex translate-y-1 items-center gap-2 rounded-full border border-white/15 bg-[#17191d]/90 px-4 py-2.5 text-[13px] font-medium opacity-0 shadow-[0_8px_24px_rgb(11_28_48_/_22%)] backdrop-blur-md transition duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 group-active:opacity-80"
              >
                <IconArrowsDiagonal className="size-4" stroke={1.8} />
                {t('screen.screenCard.open')}
              </span>
            </button>
          ) : null}
          {expanded && controlNotice !== null ? (
            <div
              role="status"
              data-screen-control-notice
              className="pointer-events-none absolute bottom-6 left-1/2 z-30 w-max max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-2xl border border-border bg-surface px-4 py-3 text-center text-[13px] text-foreground shadow-lg"
            >
              {controlNotice.message}
            </div>
          ) : null}
        </div>
        <div
          hidden={!expanded && control.kind !== 'taken'}
          className={
            expanded
              ? 'crewaid-screen-toolbar window-drag flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 py-2 pl-[88px] pe-3 text-[13px] text-foreground'
              : 'flex items-center justify-between gap-2 px-3 py-2 text-[11px] text-muted'
          }
        >
          <span className="truncate" hidden={!expanded && control.kind !== 'taken'}>
            {!expanded && control.kind === 'taken'
              ? t('screen.screenCard.someoneElseIsInControl')
              : caption}
          </span>
          <div className={`flex min-w-0 flex-wrap items-center gap-2 ${expanded ? '' : 'ms-auto'}`}>
            {/* M3-FE-01: the teaching flow lives on THIS surface — D-038 makes
                the full-screen view the only one that takes input, so it is
                the only one where a demonstration can happen. */}
            {expanded && botId !== null && view.kind === 'live' ? (
              <SeatControlBar
                control={control}
                hint={controlNotice?.hint === true}
                onTake={() => {
                  setControlNotice(null);
                  controlScreen(botId, { action: 'take' });
                }}
                onHandBack={(epoch) => controlScreen(botId, { action: 'release', epoch })}
              />
            ) : null}
            {expanded &&
            botId !== null &&
            onReleaseIdentity !== undefined &&
            view.kind === 'live' ? (
              <IdentityRelease
                key={botId}
                botId={botId}
                control={control}
                recording={recording}
                onRelease={onReleaseIdentity}
              />
            ) : null}
            {expanded ? (
              <RecordingControls
                recording={recording}
                live={view.kind === 'live'}
                onTeach={onTeachTask}
                onStop={onStopRecording}
                onDiscard={onDiscardRecording}
                onReview={onReviewSkill}
              />
            ) : null}
            {expanded ? (
              <Button
                variant="ghost"
                isIconOnly
                size="sm"
                ref={closeRef}
                aria-label={t('screen.screenCard.closeFullScreen')}
                onPress={() => onExpandedChange(false)}
                className="window-no-drag size-7 shrink-0 rounded-lg text-foreground"
              >
                <IconX className="size-4" stroke={1.8} />
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </FocusScope>
  );
}

function ScreenViewer({
  botId,
  widthPx,
  heightPx,
  name,
  quality,
  interactive,
  watchScreen,
  sendScreenInput,
  openScreenStream,
}: {
  botId: string;
  widthPx: number;
  heightPx: number;
  name: string;
  quality: number;
  interactive: boolean;
  watchScreen: ScreenCardProps['watchScreen'];
  sendScreenInput: ScreenCardProps['sendScreenInput'];
  openScreenStream: ScreenCardProps['openScreenStream'];
}) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [hasPicture, setHasPicture] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const streamRef = useRef<ScreenStreamHandle | null>(null);
  /** The quality the open stream was last told; null while none is open. */
  const streamQuality = useRef<number | null>(null);
  const rfbRef = useRef<InstanceType<typeof RFB> | null>(null);
  // What the sandbox is holding on this viewer's behalf. A ref rather than
  // state: nothing renders from it, and a re-render per keystroke on a path
  // that also carries every mouse move is exactly what this component avoids.
  const heldRef = useRef(new HeldInput());
  const readPresentation = useEffectEvent(() => ({ name, quality, interactive }));
  const forwardInput = useEffectEvent((message: Uint8Array) => {
    // `viewOnly` is the primary gate. Keep the presentation check here too so
    // an event already queued while collapsing cannot leak out of the rail.
    if (!interactive) return;
    // Record BEFORE sending, and record only what is actually sent: the
    // tracker's whole value is that it cannot disagree with what the sandbox
    // was told, and a send that fails leaves nothing held to release.
    if (sendScreenInput(botId, message)) heldRef.current.observe(message);
  });
  const releaseHeldInput = useEffectEvent(() => {
    // Stop noVNC before unwinding the wire state. Its viewOnly setter clears
    // its local key list but drops the releases, which we send ourselves.
    if (rfbRef.current !== null) rfbRef.current.viewOnly = true;
    const releases = heldRef.current.release();
    if (releases.some((message) => message[0] === 5)) {
      // End noVNC's DOM mouse capture as well. Otherwise its full-window
      // capture overlay and cached button mask survive an interrupted drag.
      // viewOnly keeps this synthetic mouseup off the wire; the tracked
      // release below retains the actual remote pointer position.
      window.dispatchEvent(new MouseEvent('mouseup', { buttons: 0 }));
    }
    for (const message of releases) sendScreenInput(botId, message);
  });

  // DECLARED FIRST, and the order is load-bearing: React runs cleanups in
  // declaration order, so this one's release messages go out while the
  // `screen.subscribe` below is still in force. Membership IS the authorisation for
  // `screen.input`, so a release sent after the unsubscribe would be
  // refused — the stuck key would survive, and the refusal would surface as a
  // connection error for an event the operator never knowingly sent.
  useEffect(() => {
    const rfb = rfbRef.current;
    if (rfb !== null) {
      rfb.viewOnly = !interactive;
      // noVNC creates its canvas with `tabIndex = -1` and grabs keydown on it,
      // so until something focuses it every keystroke goes to whatever else
      // has focus and the desktop silently ignores the operator.
      if (interactive) rfb.focus();
    }
    if (!interactive) return undefined;
    // Whatever is still down when capture ends has to be released by us —
    // noVNC drops its own releases on the way out. See heldInput.ts.
    return () => releaseHeldInput();
  }, [interactive]);

  // The canvas and its stream: rebuilt for a new desktop or an explicit
  // reconnect, never for a presentation change, which only adjusts quality.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;

    const initial = readPresentation();
    const channel = new RfbChannel({
      widthPx,
      heightPx,
      name: initial.name,
      onProtocolError: setFailure,
      onInput: forwardInput,
    });
    const rfb = new RFB(container, channel as unknown as WebSocket);
    // noVNC exposes viewOnly as a property, not a constructor option.
    // Set it before the handshake can attach keyboard and pointer handlers.
    rfb.viewOnly = !initial.interactive;
    rfbRef.current = rfb;
    // Mounting straight into the full-screen surface — a restart that changes
    // the geometry while the viewer is open rebuilds this component — has to
    // take focus here too; the effect above already ran against no instance.
    if (initial.interactive) rfb.focus();
    setFailure(null);
    setHasPicture(false);
    // R8: the display size is fixed for the container's lifetime, so the only
    // legal way to fit 1280x800 into a rail — or across a 27" monitor — is to
    // scale what we were sent. `resizeSession` would ask the server to change
    // it, which §5 forbids. Both halves live in one named constant because
    // only the pair means R8.
    rfb.scaleViewport = VIEWER_DISPLAY_POLICY.scaleViewport;
    rfb.resizeSession = VIEWER_DISPLAY_POLICY.resizeSession;
    // The decoded picture keeps its aspect ratio. noVNC's default dark
    // background otherwise appears as a border in the fractional gutters
    // after the same canvas returns from full screen to the rounded preview.
    rfb.background = 'transparent';

    // Order matters: the handshake has to be able to reach noVNC's handlers,
    // which `new RFB` installed above, and frames must not arrive before it.
    // Close the stream if noVNC tears itself down so a dead decoder does not
    // leave the WebSocket and upstream x11vnc pump running in the background.
    const onDisconnect = () => {
      streamRef.current?.close();
      setFailure(t('screen.screenStreamClient.theDisplayDisconnected'));
    };
    rfb.addEventListener('disconnect', onDisconnect);
    channel.start();

    const stream = openScreenStream(botId, initial.quality, {
      onRfb: (bytes) => {
        channel.deliver(bytes);
        // A server message type 0 is a FramebufferUpdate. Keep the connecting
        // treatment over noVNC's empty canvas until at least one rectangle is
        // available to paint; zero-rectangle keepalives are not a picture.
        if (hasFramebufferRectangles(bytes)) setHasPicture(true);
      },
      onEnded: (ending) => {
        setFailure(
          ending.kind === 'not-running'
            ? t('screen.screenCard.theComputerIsNotRunning')
            : ending.message,
        );
      },
    });
    streamRef.current = stream;
    streamQuality.current = initial.quality;

    // noVNC only releases keys on WINDOW blur. Focus can move to local chrome
    // without blurring the window, and mouse buttons are not released by its
    // keyboard handler at all. Pause capture for both kinds of focus loss.
    const onCanvasBlur = () => {
      releaseHeldInput();
      // Toolbar focus must release held keys, but must not disable pointer
      // movement until another click. Keyboard events still belong to the
      // focused element; noVNC listens on its canvas, not on the toolbar.
      if (document.hasFocus()) rfb.viewOnly = !readPresentation().interactive;
    };
    const onCanvasFocus = () => {
      rfb.viewOnly = !readPresentation().interactive;
    };
    const onWindowBlur = (event: FocusEvent) => {
      if (event.target === window) releaseHeldInput();
    };
    const onWindowFocus = (event: FocusEvent) => {
      if (event.target === window) onCanvasFocus();
    };
    container.addEventListener('blur', onCanvasBlur, true);
    container.addEventListener('focus', onCanvasFocus, true);
    window.addEventListener('blur', onWindowBlur, true);
    window.addEventListener('focus', onWindowFocus, true);

    return () => {
      // This effect can restart while `interactive` stays true (a reconnect),
      // so the interactivity effect's cleanup alone is insufficient.
      releaseHeldInput();
      stream.close();
      if (streamRef.current === stream) streamRef.current = null;
      streamQuality.current = null;
      container.removeEventListener('blur', onCanvasBlur, true);
      container.removeEventListener('focus', onCanvasFocus, true);
      window.removeEventListener('blur', onWindowBlur, true);
      window.removeEventListener('focus', onWindowFocus, true);
      // `disconnect` tears down noVNC's canvas and its decoders; closing the
      // channel underneath it first would make that look like a server drop.
      rfb.removeEventListener('disconnect', onDisconnect);
      rfb.disconnect();
      if (rfbRef.current === rfb) rfbRef.current = null;
      channel.close();
    };
  }, [attempt, botId, heightPx, openScreenStream, widthPx]);

  // DECLARED AFTER the two above, for the same reason the interactivity effect
  // is declared first: cleanups run in declaration order, so held keys are let
  // go of while this window is still a watcher, and only then does it stop
  // being one. A new §4.2 socket re-runs only this — membership is the
  // socket's, the pixels are not.
  useEffect(() => {
    const unsubscribe = watchScreen(botId);
    return () => {
      releaseHeldInput();
      unsubscribe();
    };
  }, [botId, watchScreen]);

  useEffect(() => {
    if (streamQuality.current === null || streamQuality.current === quality) return;
    // On the open stream, without reconnecting: both ends keep their
    // compression history across an expand or a collapse.
    streamRef.current?.setQuality(quality);
    streamQuality.current = quality;
  }, [quality]);

  return (
    <>
      <div ref={containerRef} data-screen-state="live" className="absolute inset-0" />
      {failure === null && !hasPicture ? (
        <div
          role="status"
          aria-live="polite"
          data-screen-loading="true"
          className="crewaid-screen-ambient absolute inset-0 z-10 grid place-items-center px-4 text-center"
        >
          <div className="flex flex-col items-center gap-3 text-[#3d617b]">
            <span className="grid size-10 place-items-center rounded-2xl border border-white/55 bg-white/45 shadow-[0_8px_28px_rgb(48_112_158_/_14%)] backdrop-blur-md">
              <IconLoader2 className="size-5 animate-spin" stroke={1.8} />
            </span>
            <span className="text-[12px] font-medium">
              {t('screen.screenCard.connectingToDisplay')}
            </span>
          </div>
        </div>
      ) : failure === null ? null : (
        <div className="absolute inset-0 z-10 grid place-items-center bg-surface-secondary px-4 text-center text-[12px] text-muted">
          <div className="flex flex-col items-center gap-3">
            <span role="status">{failure}</span>
            <Button size="sm" onPress={() => setAttempt((value) => value + 1)}>
              {t('screen.screenCard.reconnectDisplay')}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * While this window holds the seat, renew the lease; when the view
 * closes, hand the seat back rather than leaving the bot waiting for the
 * lease to run out.
 */
function useSeatLease(
  botId: string | null,
  control: SeatControlView,
  controlScreen: (botId: string, request: SeatControlRequest) => void,
): void {
  const held = control.kind === 'driving' || control.kind === 'taking' ? control.epoch : null;
  useEffect(() => {
    if (botId === null || held === null) return undefined;
    const renew = setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        controlScreen(botId, { action: 'renew', epoch: held });
      }
    }, SEAT_RENEW_EVERY_MS);
    return () => clearInterval(renew);
  }, [botId, held, controlScreen]);

  // The hold as of the last commit. Updated in an effect, not during render,
  // so the cleanup below still sees the hold the closing render cleared.
  const latest = useRef<{ botId: string | null; epoch: number | null }>({
    botId: null,
    epoch: null,
  });
  useEffect(() => {
    latest.current = { botId, epoch: held };
  });
  useEffect(
    () => () => {
      const { botId: heldBot, epoch } = latest.current;
      if (heldBot !== null && epoch !== null) {
        controlScreen(heldBot, { action: 'release', epoch });
      }
    },
    [botId, controlScreen],
  );
}

function SeatControlBar({
  control,
  hint,
  onTake,
  onHandBack,
}: {
  control: SeatControlView;
  hint: boolean;
  onTake: () => void;
  onHandBack: (epoch: number) => void;
}) {
  const t = useT();
  return (
    <div
      data-seat-control={control.kind}
      className="window-no-drag flex min-w-0 items-center gap-2"
    >
      {control.kind === 'taking' || control.kind === 'taken' ? (
        <span role="status" className="truncate text-[12px] text-muted">
          {SEAT_CONTROL_LABELS[control.kind]}
        </span>
      ) : null}
      {control.kind === 'available' ? (
        <Button
          size="sm"
          variant="secondary"
          onPress={onTake}
          data-control-hint={hint || undefined}
        >
          {t('screen.screenCard.takeControl')}
        </Button>
      ) : null}
      {control.kind === 'driving' || control.kind === 'taking' ? (
        <Button size="sm" variant="secondary" onPress={() => onHandBack(control.epoch)}>
          {control.kind === 'driving'
            ? t('screen.screenCard.handBack')
            : t('screen.screenCard.cancel')}
        </Button>
      ) : null}
    </div>
  );
}

function IdentityRelease({
  botId,
  control,
  recording,
  onRelease,
}: {
  botId: string;
  control: SeatControlView;
  recording: RecordingView | undefined;
  onRelease: (botId: string) => Promise<BotMutation<void>>;
}) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const available =
    control.kind === 'available' &&
    !['starting', 'recording', 'stopping'].includes(recording?.kind ?? '') &&
    !pending;
  const release = async () => {
    setPending(true);
    setMessage(null);
    try {
      const result = await onRelease(botId);
      setMessage(
        result.ok
          ? t('screen.screenCard.sharedLoginReleasedTheNext')
          : result.failure.code === 'CONFLICT'
            ? t('screen.screenCard.handTheScreenBackStop')
            : result.failure.message,
      );
    } catch {
      setMessage(t('screen.screenCard.theLoginReleaseCouldNot'));
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      className="window-no-drag flex items-center gap-2"
      title={t('screen.screenCard.handControlBackAndStop')}
    >
      {message !== null ? (
        <span role="status" className="max-w-64 text-xs">
          {message}
        </span>
      ) : null}
      <Button
        size="sm"
        variant="secondary"
        isDisabled={!available}
        onPress={() => {
          void release();
        }}
      >
        {t('screen.screenCard.releaseSharedLogin')}
      </Button>
    </div>
  );
}
