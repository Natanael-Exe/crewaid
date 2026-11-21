import { randomUUID } from 'node:crypto';

import { tool } from './tool-contract.js';
import { NativeToolInputs } from '@crewaid/shared';
import { ATTACHMENT_MAX_BYTES } from '@crewaid/shared';

import type { Seat } from '../sandbox/seat.service.js';

import type { AttachmentPort } from './skill-tools.js';
import { SEAT_BUILTIN, CONTAINED_BUILTIN, OBSERVING_BUILTIN } from './tool-registry.js';
import type { RegisteredTool, ToolContext } from './tool-registry.js';
import { seatEnv } from './seat-env.js';
import { MACHINE_HOME } from './workspace-paths.js';

/**
 * The machine-level built-ins: eyes, hands and a camera on the bot's own
 * desktop (§6/M5's `screenshot`/`shell` captured the PAGE and the terminal;
 * these reach the screen a human would see).
 *
 * Every one of them works the same way, and the way matters: they resolve the
 * bot's SEAT — its own X display on the shared machine — and exec a
 * standard desktop utility (`scrot`, `xdotool`, `ffmpeg`) against it through
 * the reduced sandbox session. Nothing here opens CDP, so recording or
 * pointing never starts a browser (the rule D-061 made explicit), and nothing
 * here can touch a sibling bot's seat, because the display the seat owns is
 * the one its tools address.
 *
 * WHY THESE ARE TOOLS AND NOT `shell` RECIPES
 *
 * The bot already has `shell`, and `DISPLAY=:10 xdotool click 1` is one line
 * away. The gap was never capability — it was REFLEX. A model with only a
 * shell treats the desktop as an undocumented machine: it fought captchas by
 * hand, took screenshots of an empty display because its shell's `DISPLAY`
 * names the machine's root screen and not its seat, and only described the
 * tools it wished it had. A named tool with a description that says WHEN to
 * reach for it is what turns "I could do this" into "I do this first".
 *
 * Coordinates
 *
 * The pointer tools take pixel coordinates, so aiming is `capture_screen` +
 * click, not guesswork. The seat's geometry is fixed for its lifetime and
 * is returned with every capture; the tools refuse coordinates outside it
 * rather than clicking the void and reporting success.
 *
 * Failures are results
 *
 * Same polarity as every other built-in: a missing utility, a refused
 * coordinate or an ffmpeg that never came up comes back as a sentence the
 * model can act on. Exit 127 is called out specifically — an older sandbox
 * image without `ffmpeg` must read as "this machine lacks the tool" rather
 * than a mystery code.
 */

/** How long one recording may run before ffmpeg stops itself. */
const RECORD_MAX_SECONDS = 600;

/** How long `record_screen_stop` waits for ffmpeg to finalize the file. */
const RECORD_STOP_WAIT_ROUNDS = 150;

/** Where the recording's live process id is kept, inside the container. */
const RECORD_PID_FILE = '/tmp/crewaid-recording.pid';

/** Where ffmpeg's own chatter goes, so a failed start is diagnosable. */
const RECORD_LOG_FILE = '/tmp/crewaid-recording.log';

/**
 * POSIX single-quoting for a value interpolated into a shell command line —
 * the same wrapper `skill-tools.ts` applies to model-supplied paths. Every
 * value quoted here is orchestrator-written (a display name, a fixed path,
 * model coordinates validated as integers first), but the wrapper costs
 * nothing and keeps one rule: nothing reaches the shell unquoted.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The message a tool gives the model when it could not do the thing. */
function failure(action: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${action} failed: ${detail}`;
}

/** How the seat is resolved for the turn's bot — `AgentBrowserService.ensureSeatFor`. */
export interface MachineSeatPort {
  ensureSeatFor(botId: string): Promise<Seat>;
}

/**
 * A coordinate the pointer tools accept, validated against the seat's fixed
 * geometry (R8). Refused as a readable result rather than clamped: a model
 * told its 1500 is beyond the 1280-wide screen asks for 1279; a model whose
 * click silently landed on the wrong pixel retries the same call.
 */
function coordinate(input: number, span: number, axis: 'x' | 'y'): string | null {
  if (!Number.isInteger(input)) {
    return `${axis} ${input} is not a whole pixel number`;
  }
  if (input < 0 || input >= span) {
    return `${axis} ${input} is outside the screen (0–${span - 1}; it is ${span}px ${axis === 'x' ? 'wide' : 'tall'})`;
  }
  return null;
}

/** xdotool's button number for a named mouse action. */
const MOUSE_BUTTONS = {
  left: '1',
  middle: '2',
  right: '3',
  up: '4',
  down: '5',
} as const;

export function machineTools(deps: {
  machines: MachineSeatPort;
  attachments: AttachmentPort;
}): RegisteredTool[] {
  return [
    {
      name: 'capture_screen',
      behavior: OBSERVING_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            "A picture of this bot's machine's WHOLE screen — every window, menu and dialog " +
            'on your desktop, not just the browser page. Reach for it before pointer work so ' +
            'you can aim, and whenever what you need is visible but not readable as text: a ' +
            'canvas, a map, a nested iframe, a captcha, a native dialog, a control no selector ' +
            'matches. Coordinates for the mouse tools are pixels from the top-left, so capture ' +
            'first, then click where you saw the thing.',
          inputSchema: NativeToolInputs.capture_screen,
          execute: async () => {
            try {
              const observed = context.seat?.beginObservation();
              const seat = await deps.machines.ensureSeatFor(context.botId);
              const session = await context.session();
              // The bot's OWN area, not `/tmp` — and kept, not deleted.
              //
              // A capture used to live in `/tmp` for the length of one call
              // and then be removed, which made it an image the model could see
              // and nothing else: no path to attach, and nothing a teammate
              // could be handed. Measured, from a live session: a bot asked to
              // attach its screenshot answered "the screenshot I take only
              // exists inside my reply as an image, not as a file on the
              // machine", and then went behind this tool's back with
              // `shell` + `scrot` — which is how the wrong display got
              // photographed in the first place. Recordings have always been
              // files under `agents/<botId>/recordings`; a capture is the same
              // kind of evidence and now lands beside them.
              const dir = `${MACHINE_HOME}/agents/${context.botId}/screenshots`;
              const stamp = new Date().toISOString().replace(/[:.]/g, '-');
              const path = `${dir}/screen-${stamp}-${randomUUID()}.png`;
              const captured = await session.run({
                command: `mkdir -p ${shellQuote(dir)} || exit 1; scrot ${shellQuote(path)}`,
                env: seatEnv(seat),
              });
              if (captured.exitCode === 127) {
                return 'capture_screen failed: this machine has no screenshot utility installed.';
              }
              if (captured.exitCode !== 0) {
                return (
                  `capture_screen failed (exit ${captured.exitCode}): ` +
                  `${captured.stderr.trim() || 'no error output'}`
                );
              }
              const bytes = await session.readBinaryFile({ path });
              if (bytes === null) {
                return 'capture_screen failed: the capture file vanished before it could be read.';
              }
              observed?.();
              return {
                bytes: bytes.byteLength,
                base64: Buffer.from(bytes).toString('base64'),
                path,
                widthPx: seat.widthPx,
                heightPx: seat.heightPx,
              };
            } catch (error) {
              return failure('capture_screen', error);
            }
          },
          toModelOutput: ({
            output,
          }: {
            output:
              | string
              | { bytes: number; base64: string; path: string; widthPx: number; heightPx: number };
          }) => {
            // Failures are strings and travel as text; a capture is an image
            // the provider receives as a file part, plus one line that makes
            // the pointer tools' coordinate space unambiguous and says where
            // the file is.
            if (typeof output === 'string') return { type: 'text' as const, value: output };
            return {
              type: 'content' as const,
              value: [
                {
                  type: 'file' as const,
                  data: { type: 'data' as const, data: output.base64 },
                  mediaType: 'image/png',
                },
                {
                  type: 'text' as const,
                  text:
                    `The screen is ${output.widthPx}x${output.heightPx}px. ` +
                    'Mouse coordinates are pixels from the top-left corner. ' +
                    `The image is saved at ${output.path}: attach_file it to put it in the chat, ` +
                    'or copy it into the shared area to give a teammate the file.',
                },
              ],
            };
          },
        }),
    },
    {
      name: 'record_screen_start',
      behavior: CONTAINED_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            "Start recording this bot's screen to a video. Use it when you are about to " +
            'demonstrate something working — the video is attached to your reply as evidence ' +
            'when you stop it. Only one recording runs at a time; it stops itself after ' +
            `${RECORD_MAX_SECONDS / 60} minutes, but call record_screen_stop as soon as the ` +
            'moment you wanted has happened.',
          inputSchema: NativeToolInputs.record_screen_start,
          execute: async () => {
            try {
              const seat = await deps.machines.ensureSeatFor(context.botId);
              const session = await context.session();
              const live = await session.run({
                command:
                  `pid=$(cat ${shellQuote(RECORD_PID_FILE)} 2>/dev/null || true); ` +
                  `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo running; else echo idle; fi`,
              });
              if (live.stdout.trim() === 'running') {
                return (
                  'record_screen_start: a recording is already running. ' +
                  'Call record_screen_stop first.'
                );
              }
              // The bot's own area — the same layout `fs_write` guards — so a
              // recording is a file the bot can also re-read or rename later.
              const dir = `${MACHINE_HOME}/agents/${context.botId}/recordings`;
              const stamp = new Date().toISOString().replace(/[:.]/g, '-');
              const video = `${dir}/screen-${stamp}.mp4`;
              const started = await session.run({
                // `nohup … &` detaches ffmpeg from this exec: the exec exits at
                // once, and ffmpeg keeps recording as an ordinary container
                // process. `$!` is then genuinely ffmpeg's pid (one backgrounded
                // simple command, not a `&&` list, where it would name the
                // wrapping subshell). Output is redirected so no stream is left
                // open for `run()` to wait behind, and `-t` is ffmpeg's OWN
                // bound — a recording the turn never stops still ends, the
                // same way `timeout` bounds a shell command on the machine.
                command:
                  `mkdir -p ${shellQuote(dir)} || exit 1; ` +
                  `nohup ffmpeg -y -nostdin ` +
                  `-f x11grab -video_size ${seat.widthPx}x${seat.heightPx} ` +
                  `-framerate 10 -i ${shellQuote(seat.display)} ` +
                  `-c:v libx264 -preset veryfast -pix_fmt yuv420p ` +
                  `-movflags +faststart -t ${RECORD_MAX_SECONDS} ` +
                  `${shellQuote(video)} >${shellQuote(RECORD_LOG_FILE)} 2>&1 & ` +
                  `echo $! > ${shellQuote(RECORD_PID_FILE)}`,
                env: seatEnv(seat),
              });
              if (started.exitCode !== 0) {
                return (
                  `record_screen_start failed (exit ${started.exitCode}): ` +
                  `${started.stderr.trim() || 'no error output'}`
                );
              }
              return (
                `Recording started — saving to ${video}. ` +
                'Call record_screen_stop when the moment you want has happened; ' +
                'the video is attached to your reply automatically when you do.'
              );
            } catch (error) {
              return failure('record_screen_start', error);
            }
          },
        }),
    },
    {
      name: 'record_screen_stop',
      behavior: CONTAINED_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Stop the running screen recording. The video is finalized, attached to your ' +
            'reply as evidence, and its path is returned. Use it once the thing you are ' +
            'demonstrating has happened on screen.',
          inputSchema: NativeToolInputs.record_screen_stop,
          execute: async (_input, options) => {
            try {
              const seat = await deps.machines.ensureSeatFor(context.botId);
              const session = await context.session();
              // SIGINT, not SIGKILL: ffmpeg finalizes the mp4 container's
              // index when interrupted, and a killed ffmpeg leaves a file no
              // player will open. The wait loop is bounded; a stuck encoder is
              // reported rather than abandoned.
              const stopped = await session.run({
                command:
                  `pid=$(cat ${shellQuote(RECORD_PID_FILE)} 2>/dev/null || true); ` +
                  `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then ` +
                  `kill -INT "$pid"; ` +
                  `for i in $(seq 1 ${RECORD_STOP_WAIT_ROUNDS}); do ` +
                  `kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done; fi; ` +
                  `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo STILL_RUNNING; ` +
                  `else rm -f ${shellQuote(RECORD_PID_FILE)}; echo STOPPED; fi`,
                env: seatEnv(seat),
              });
              if (stopped.stdout.includes('STILL_RUNNING')) {
                return (
                  'record_screen_stop: the recorder did not stop within 30s. ' +
                  'Wait a moment and call record_screen_stop again.'
                );
              }
              // The pid file is gone, but WHICH file was being written is not
              // carried across execs — the newest recording in the bot's own
              // area is the answer, and the pid file was per-bot to begin with
              // (one recording at a time). `ls -t` names it.
              const newest = await session.run({
                command:
                  `ls -t ${shellQuote(`${MACHINE_HOME}/agents/${context.botId}/recordings`)}` +
                  `/*.mp4 2>/dev/null | head -n 1`,
                env: seatEnv(seat),
              });
              const video = newest.stdout.trim().split('\n')[0]?.trim() ?? '';
              if (video === '') {
                return (
                  'record_screen_stop: no recording was found — nothing was running, ' +
                  'or record_screen_start was never called on this machine.'
                );
              }
              const sized = await session.run({ command: `stat -c %s ${shellQuote(video)}` });
              if (sized.exitCode !== 0) {
                return `record_screen_stop failed: ${video} vanished before it could be read.`;
              }
              const size = Number.parseInt(sized.stdout.trim(), 10);
              if (Number.isFinite(size) && size > ATTACHMENT_MAX_BYTES) {
                return (
                  `The recording at ${video} is ${size} bytes — over the ` +
                  `${ATTACHMENT_MAX_BYTES}-byte attachment limit, so it was NOT attached. ` +
                  'Compress it first (ffmpeg -i <file> -c:v libx264 -crf 32 <smaller>.mp4) ' +
                  'and attach the smaller file with attach_file.'
                );
              }
              const bytes = await session.readBinaryFile({ path: video });
              if (bytes === null) {
                return `record_screen_stop failed: ${video} vanished before it could be read.`;
              }
              const stored = await deps.attachments.storeFromBot({
                userId: context.userId,
                // Claims this call's own host, exactly as attach_file does:
                // the reply being composed, or this call's tool result (D-190).
                messageId: await context.attachmentHost(options.toolCallId),
                filename: video.split('/').pop() ?? 'screen-recording.mp4',
                bytes: Buffer.from(bytes),
                // D-136: evidence is a deliverable too, filed like any other.
                filing: { triggerMessageId: context.trigger.id, sourcePath: video },
              });
              return (
                `Recording stopped: ${stored.filename} (${stored.sizeBytes} bytes) was ` +
                'attached to your reply as evidence.'
              );
            } catch (error) {
              // An attachment the allowlist or the cap refused throws from
              // storeFromBot; the model still gets the path so it can retry
              // through attach_file after fixing the file.
              return failure('record_screen_stop', error);
            }
          },
        }),
    },
    {
      name: 'mouse_move',
      behavior: SEAT_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            "Move the machine's mouse pointer to a pixel position on your screen. Use it to " +
            'hover (tooltips, menus that open on hover) or to position before a drag. Capture ' +
            'the screen first so the coordinates are ones you have seen.',
          inputSchema: NativeToolInputs.mouse_move,
          execute: async ({ x, y }: { x: number; y: number }) => {
            try {
              const seat = await deps.machines.ensureSeatFor(context.botId);
              const bad = coordinate(x, seat.widthPx, 'x') ?? coordinate(y, seat.heightPx, 'y');
              if (bad !== null) return `mouse_move refused: ${bad}.`;
              const session = await context.session();
              const moved = await session.run({
                command: `xdotool mousemove --sync ${x} ${y}`,
                env: seatEnv(seat),
              });
              if (moved.exitCode === 127) {
                return 'mouse_move failed: this machine has no xdotool installed.';
              }
              if (moved.exitCode !== 0) {
                return (
                  `mouse_move failed (exit ${moved.exitCode}): ` +
                  `${moved.stderr.trim() || 'no error output'}`
                );
              }
              return `Pointer is at (${x}, ${y}).`;
            } catch (error) {
              return failure('mouse_move', error);
            }
          },
        }),
    },
    {
      name: 'mouse_click',
      behavior: SEAT_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            "Click the machine's mouse at a pixel position on your screen — the pointer is " +
            'moved there first. This is a REAL click on the desktop: it works on canvases, ' +
            'maps, nested iframes, captchas, native menus and window controls that selector ' +
            'based clicking cannot reach. Capture the screen first and click where you saw ' +
            'the target.',
          inputSchema: NativeToolInputs.mouse_click,
          execute: async ({
            x,
            y,
            button,
          }: {
            x: number;
            y: number;
            button?: 'left' | 'middle' | 'right' | 'double' | undefined;
          }) => {
            try {
              const seat = await deps.machines.ensureSeatFor(context.botId);
              const bad = coordinate(x, seat.widthPx, 'x') ?? coordinate(y, seat.heightPx, 'y');
              if (bad !== null) return `mouse_click refused: ${bad}.`;
              const session = await context.session();
              // `--sync` on the move is what makes the click land where the
              // model aimed: without it, xdotool can press before the pointer
              // has actually arrived, and the click goes to wherever the
              // pointer was.
              const press =
                button === 'double'
                  ? 'click --repeat 2 1'
                  : `click ${MOUSE_BUTTONS[button ?? 'left']}`;
              const clicked = await session.run({
                command: `xdotool mousemove --sync ${x} ${y} ${press}`,
                env: seatEnv(seat),
              });
              if (clicked.exitCode === 127) {
                return 'mouse_click failed: this machine has no xdotool installed.';
              }
              if (clicked.exitCode !== 0) {
                return (
                  `mouse_click failed (exit ${clicked.exitCode}): ` +
                  `${clicked.stderr.trim() || 'no error output'}`
                );
              }
              return `Clicked ${button ?? 'left'} at (${x}, ${y}). Capture the screen to see what changed.`;
            } catch (error) {
              return failure('mouse_click', error);
            }
          },
        }),
    },
    {
      name: 'mouse_scroll',
      behavior: SEAT_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            "Scroll the machine's mouse wheel at the pointer's current position — use " +
            'mouse_move first to park the pointer over the thing that should scroll. ' +
            'Scrolls whatever is under the pointer, including desktop windows and lists ' +
            'inside the page that page-level scrolling misses.',
          inputSchema: NativeToolInputs.mouse_scroll,
          execute: async ({
            direction,
            amount,
          }: {
            direction: 'up' | 'down';
            amount?: number | undefined;
          }) => {
            try {
              const seat = await deps.machines.ensureSeatFor(context.botId);
              const session = await context.session();
              const clicks = Math.min(Math.max(amount ?? 3, 1), 10);
              const scrolled = await session.run({
                command: `xdotool click --repeat ${clicks} ${MOUSE_BUTTONS[direction === 'up' ? 'up' : 'down']}`,
                env: seatEnv(seat),
              });
              if (scrolled.exitCode === 127) {
                return 'mouse_scroll failed: this machine has no xdotool installed.';
              }
              if (scrolled.exitCode !== 0) {
                return (
                  `mouse_scroll failed (exit ${scrolled.exitCode}): ` +
                  `${scrolled.stderr.trim() || 'no error output'}`
                );
              }
              return `Scrolled ${direction} ${clicks}.`;
            } catch (error) {
              return failure('mouse_scroll', error);
            }
          },
        }),
    },
    {
      name: 'keyboard',
      behavior: SEAT_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            "Type text or press key combinations through the machine's REAL keyboard, into " +
            'whatever window has focus (focus follows the pointer: move or click first). ' +
            'This reaches native dialogs, the terminal, and browser fields that resist ' +
            'synthetic input. Give `text` to type it verbatim, `keys` to press combinations ' +
            'like "ctrl+l", "Return", "Escape", or both.',
          inputSchema: NativeToolInputs.keyboard,
          execute: async ({
            text,
            keys,
          }: {
            text?: string | undefined;
            keys?: string[] | undefined;
          }) => {
            if ((text === undefined || text === '') && (keys === undefined || keys.length === 0)) {
              return 'keyboard refused: give text to type, keys to press, or both.';
            }
            try {
              const seat = await deps.machines.ensureSeatFor(context.botId);
              const session = await context.session();
              const commands: string[] = [];
              if (text !== undefined && text !== '') {
                commands.push(`xdotool type --delay 25 -- ${shellQuote(text)}`);
              }
              if (keys !== undefined && keys.length > 0) {
                // Each key name is quoted, so a model-invented key with a
                // space is refused by xdotool rather than split into two.
                commands.push(`xdotool key -- ${keys.map(shellQuote).join(' ')}`);
              }
              const typed = await session.run({
                command: commands.join(' && '),
                env: seatEnv(seat),
              });
              if (typed.exitCode === 127) {
                return 'keyboard failed: this machine has no xdotool installed.';
              }
              if (typed.exitCode !== 0) {
                return (
                  `keyboard failed (exit ${typed.exitCode}): ` +
                  `${typed.stderr.trim() || 'no error output'}`
                );
              }
              return 'Sent to the focused window. Capture the screen to see the result.';
            } catch (error) {
              return failure('keyboard', error);
            }
          },
        }),
    },
  ];
}
