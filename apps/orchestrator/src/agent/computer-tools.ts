import { randomUUID } from 'node:crypto';

import { tool } from './tool-contract.js';
import { NativeToolInputs } from '@crewaid/shared';

import type { ToolSandboxSession } from '@crewaid/sandbox-core';

import { CONTAINED_BUILTIN, OBSERVING_BUILTIN, SENSITIVE_BUILTIN } from './tool-registry.js';
import type { RegisteredTool, ToolContext } from './tool-registry.js';
import type { MachineSeatPort } from './machine-tools.js';
import { seatEnv } from './seat-env.js';
import { MACHINE_HOME, gitConfigWriteRefusal, resolveWorkspacePath } from './workspace-paths.js';

/**
 * The four computer built-ins: `screenshot`, `shell`,
 * `fs_read`, `fs_write`.
 *
 * Like the browser four, they take what they need from the TURN inside
 * `execute` rather than when they are built, so registering them costs
 * nothing and a turn that only answers starts no desktop.
 *
 * Where these sit
 *
 * `shell` bypasses every path check `fs_read` and `fs_write` make — it
 * executes as the same uid and can read anything that uid can. So the scoping
 * in `workspace-paths.ts` is a guardrail against a confused model, never a
 * boundary against a determined one. The boundary is the container, and
 * it is per user. That is the argument for being strict in the
 * tools that CAN check, not against it: the rejection cases are the
 * mistakes a model makes, not the attacks a jailbreak mounts.
 *
 * `shell` is also the one tool §6/M5 singles out as "always requires approval
 * by default". Nothing in this file implements that: approval is the auto-review
 * matcher's and the rules live on the bot, which is what lets an
 * operator decide otherwise for their own machine. What this file owes that
 * sentence is a `description` an operator reading an approval prompt can judge,
 * which is why the command is quoted back verbatim in the result.
 *
 * Failures are results
 *
 * Same polarity as the browser tools: a refused path or a command that exited
 * non-zero comes back as text the model can read and act on, not as an
 * exception. A non-zero exit especially — that is the normal way a shell
 * reports something, and a model that sees the stderr fixes the command.
 */

/** Ceilings on what one tool call may bring back into the context window. */
const MAX_OUTPUT_CHARS = 16_000;
const MAX_WRITE_BYTES = 1024 * 1024;
/** Slice fetch ceiling passed to `readTextFileRange` when reading large files. */
const RANGE_FETCH_MAX_BYTES = 64 * 1024;

/**
 * Format read lines with 1-based `cat -n`-style tab prefixes (`12\tcode`),
 * keeping the 16k-character ceiling as the default bound and adding a range
 * footer only when the output was truncated or explicitly sliced.
 */
function formatReadOutput(input: {
  readonly path: string;
  readonly text: string;
  readonly startLine: number;
  readonly endLineRequested: number | undefined;
  readonly totalLines: number;
  readonly totalChars: number;
  readonly byteTruncated: boolean;
}): string {
  const { path, text, startLine, endLineRequested, totalLines, totalChars, byteTruncated } = input;
  if (totalLines === 0) {
    return startLine > 1 ? `fs_read: ${path} is empty (0 lines)` : '';
  }
  if (startLine > totalLines) {
    return `fs_read: ${path} has ${totalLines.toLocaleString('en-US')} line(s); startLine ${startLine} is past end of file.`;
  }
  // From here at least one line is in range, so an empty `text` is one blank
  // line and still gets its number.
  const lines = text.split('\n');
  const out: string[] = [];
  let usedChars = 0;
  let charTruncated = false;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? '';
    const cleanLine = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const formatted = `${startLine + i}\t${cleanLine}`;
    const separator = out.length === 0 ? 0 : 1;
    if (usedChars + separator + formatted.length > MAX_OUTPUT_CHARS) {
      if (out.length === 0) {
        out.push(formatted.slice(0, MAX_OUTPUT_CHARS));
      }
      charTruncated = true;
      break;
    }
    out.push(formatted);
    usedChars += separator + formatted.length;
  }

  const shownEnd = startLine + out.length - 1;
  const sliced = startLine > 1 || endLineRequested !== undefined || shownEnd < totalLines;
  const body = out.join('\n');

  if (charTruncated && totalLines === 1 && out.length === 1) {
    return `${body}\n… truncated: ${totalChars.toLocaleString('en-US')} characters in total (line 1 of 1).`;
  }
  if (charTruncated || byteTruncated || shownEnd < totalLines) {
    return (
      `${body}\n[lines ${startLine}–${shownEnd} of ${totalLines.toLocaleString('en-US')} — ` +
      'pass startLine/endLine to read more]'
    );
  }
  if (sliced) {
    return `${body}\n[lines ${startLine}–${shownEnd} of ${totalLines.toLocaleString('en-US')}]`;
  }
  return body;
}

/**
 * How long a command may run, enforced INSIDE the container.
 *
 * This used to be an `AbortSignal.timeout` and nothing else, which bounded
 * the orchestrator's WAIT and not the machine: when the tool stopped waiting,
 * nothing stopped the command. A `pnpm install` outlived the turn that asked
 * for it, and kept going after the operator had moved on — not for the two
 * minutes the constant suggests, but until it finished on its own. Measured,
 * not assumed: neither `spawn.kill` nor an aborted `run` stops a
 * process the sandbox started (the evidence directory).
 */
const SHELL_TIMEOUT_S = 120;
const SHELL_TIMEOUT_MS = SHELL_TIMEOUT_S * 1000;
/**
 * The orchestrator's own bound, deliberately LONGER than the container's.
 *
 * Whichever fires first decides what the model is told, and the container's
 * is the one that can say something useful — `timeout` exits 124 and the tool
 * turns that into "hit the 120s limit". If this fired first the model would
 * get a transport abort instead, for the same event.
 */
const SHELL_WAIT_MS = SHELL_TIMEOUT_MS + 10_000;
/**
 * How long a command has to die after TERM before it is killed outright.
 * `timeout` handles this for the timeout path; the cancel path below sends
 * only TERM, because a turn ending is not a reason to deny a command its own
 * cleanup.
 */
const SHELL_KILL_AFTER = '5s';

/**
 * One shell-quoted argument.
 *
 * The command reaches the sandbox as a string that a shell will parse, and it
 * is model-written, so it is wrapped rather than trusted: single quotes stop
 * every metacharacter, and the `'\''` dance is how a single quote is carried
 * through single quotes. Without this, a command containing a quote would end
 * the wrapper's own quoting and the rest would run as the WRAPPER's words.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The tag that makes a running command findable from a second shell.
 *
 * Written as a leading no-op on its own line rather than a trailing comment: a
 * `#` appended after a model-written command is swallowed by a trailing
 * backslash or an unterminated heredoc, and then nothing can be found. A `:`
 * builtin with the tag as its argument cannot be escaped backwards into.
 */
function taggedCommand(command: string, id: string): string {
  return `: ${shellQuote(`crewaid-shell:${id}`)}\n${command}`;
}

/**
 * Stop everything a tagged command started, by process group.
 *
 * `setsid` on the way in put the command in a session of its own, so its
 * children share one process group and `kill -- -PGID` reaches all of them.
 * Killing only the matched pids would leave whatever the command spawned — a
 * backgrounded child survives a kill aimed at its parent.
 *
 * `[c]rewaid-shell:` is the standard self-exclusion: the bracket matches the same
 * text while the pattern itself does not contain it, so this command line is
 * not one of its own hits. Without it the loop kills its own process group and
 * stops partway through, leaving part of the tree alive.
 *
 * Swept three times a second apart rather than once. A cancel can land in the
 * moment between the check below and the command actually reaching the
 * machine, and a single sweep at that instant finds nothing while the command
 * starts immediately after — cancelled in the transcript and running in the
 * container.
 */
function killByTag(id: string): string {
  const pattern = shellQuote(`[c]rewaid-shell:${id}`);
  const sweep =
    `for p in $(pgrep -f ${pattern}); do ` +
    `pgid=$(ps -o pgid= -p "$p" | tr -d ' '); ` +
    `[ -n "$pgid" ] && kill -TERM "-$pgid" 2>/dev/null; ` +
    `done`;
  return `for i in 1 2 3; do ${sweep}; sleep 1; done; true`;
}

/** The message a tool gives the model when it could not do the thing. */
function failure(action: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${action} failed: ${detail}`;
}

/**
 * Bound what reaches the model, and say what was cut.
 *
 * §6/M5 truncates a tool result at 100 KB before the model sees it, and that
 * general seam is `tool-result-projection.ts`: the registry hangs
 * the ceiling on every tool's `toModelOutput` on the way out, so a tool that
 * bounds nothing is still bounded. These two cap lower and locally because
 * they are the ones that can produce arbitrary output on purpose — a `cat` of
 * a log, a `find /` — and 100 KB of `find` output is a ceiling, not a useful
 * tool result. A result that silently stopped mid-line also reads to a model
 * as a file that ends there, which is why this says what it cut.
 */
function bounded(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const kept = text.slice(0, MAX_OUTPUT_CHARS);
  return `${kept}\n… truncated: ${text.length.toLocaleString('en-US')} characters in total.`;
}

/**
 * The four computer built-ins, plus the one dependency that is not the turn's.
 *
 * `machines` is here for `shell` alone, and it is the seat rather than the
 * machine: a bot's command runs on the bot's own display (see `seat-env.ts`
 * for the capture that went to the wrong one). Everything else these tools
 * need travels in `ToolContext`.
 */
export function computerTools(deps: { machines: MachineSeatPort }): RegisteredTool[] {
  return [
    {
      name: 'screenshot',
      behavior: OBSERVING_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            "A picture of this bot's own screen, for when the page's text is not enough — " +
            'a layout question, a chart, an image, or a control you cannot find by selector. ' +
            'Prefer browser_read: text is cheaper and you can act on it directly.',
          // A tool with no arguments still needs a schema the providers accept.
          inputSchema: NativeToolInputs.screenshot,
          execute: async () => {
            const observed = context.seat?.beginObservation();
            const page = await context.browser();
            const png = await page.screenshot();
            observed?.();
            // The full typed result for our own code; `toModelOutput` below
            // decides what the MODEL gets. That is the separation M5-BE-12
            // asks for — truncation and projection must not destroy the value
            // the orchestrator still needs.
            return { bytes: png.byteLength, base64: png.toString('base64') };
          },
          // "returns an image part to the model". The SDK's own
          // mechanism, so the image reaches the provider as a file part rather
          // than as base64 inside a JSON string no model can see. The shape is
          // `@ai-sdk/provider`'s tagged file data — read off the live V4 union
          // rather than the V2 one that still ships beside it, which spells
          // the same thing `{type:'media', data}` and does not compile.
          toModelOutput: ({ output }: { output: { bytes: number; base64: string } }) => ({
            type: 'content' as const,
            value: [
              {
                type: 'file' as const,
                data: { type: 'data' as const, data: output.base64 },
                mediaType: 'image/png',
              },
            ],
          }),
        }),
    },
    {
      name: 'shell',
      // The one built-in classified `sensitive`, and not because the
      // container is precious: a shell is unbounded — it has the network, the
      // package manager and every file the bot can reach — so what it can do
      // is not a property of the tool but of the command. A bot whose rule
      // list is empty is therefore asked about all of them; the seeded
      // defaults narrow that to the commands that actually destroy something.
      behavior: SENSITIVE_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Run a shell command on this bot’s computer and return its output. ' +
            `The command starts in this bot's OWN area, ${MACHINE_HOME}/agents/${context.botId} — ` +
            `work you build lands there; ${MACHINE_HOME}/shared is the team's, and anything left ` +
            `directly in ${MACHINE_HOME} is on the machine every bot shares. ` +
            'The session is this bot’s own desktop: desktop programs you start here (`scrot`, ' +
            '`xdotool`, `wmctrl`, an editor, a file manager) act on the screen the user is ' +
            'watching, and windows you open appear on it. ' +
            'This usually needs a human to approve it, so say what you are doing in the same turn.',
          inputSchema: NativeToolInputs.shell,
          execute: async (
            { command }: { command: string },
            { abortSignal }: { abortSignal?: AbortSignal },
          ) => {
            if (command.trim() === '') return 'shell failed: a command is required';

            // The bot's OWN area, which the command starts in. The
            // mkdir + cd ride INSIDE the bash script rather than trusting
            // the exec's workingDirectory alone: a freshly provisioned
            // volume has no per-bot directories yet, and an exec whose
            // working directory does not exist answers an error instead of
            // the command's output. The cd falls back to MACHINE_HOME, so
            // the tool keeps working even if the area is somehow gone.
            const ownArea = `${MACHINE_HOME}/agents/${context.botId}`;
            const startDirVerdict =
              context.workingDirectory === undefined
                ? null
                : resolveWorkspacePath(
                    context.botId,
                    context.workingDirectory,
                    context.groupId ?? null,
                  );
            const startDir =
              startDirVerdict !== null && startDirVerdict.ok ? startDirVerdict.path : ownArea;

            // M5-BE-31. The handler goes on BEFORE anything is awaited, and
            // that ordering is the whole fix. `addEventListener('abort')`
            // never fires on a signal that has ALREADY aborted, so a listener
            // registered after `context.session` — which can take seconds
            // when the machine has to wake — silently does nothing whenever
            // the cancel lands during that wait. Measured: the listener fired
            // about one run in three, and the first reading of that was
            // "the SDK's signal is unreliable" rather than "we registered it
            // too late".
            //
            // The signal itself is the turn's own controller: `streamText`
            // passes it down and `mergeAbortSignals` returns it unchanged
            // when no per-tool timeout is configured (read from ai@7.0.89,
            // not assumed).
            const id = randomUUID();
            let session: ToolSandboxSession | undefined;
            const stopIt = (): void => {
              // Nothing to stop if the command never reached the machine.
              if (session === undefined) return;
              void (async () => {
                try {
                  await session.run({ command: killByTag(id) });
                } catch {
                  // The machine may already be gone, which is the one case
                  // where there is nothing left to stop.
                }
              })();
            };
            abortSignal?.addEventListener('abort', stopIt, { once: true });

            try {
              session = await context.session();
              // The cancel may have arrived while the machine was waking. The
              // listener above did its job and found nothing to kill, because
              // there was nothing yet — so the command must not start now.
              if (abortSignal?.aborted === true) {
                return 'shell: the turn was cancelled before the command started.';
              }
              // The bound that lives ON THE MACHINE.
              //
              // `SHELL_TIMEOUT_MS` bounded the orchestrator's WAIT and never
              // the machine, so a command whose orchestrator stopped waiting
              // — because the turn was cancelled, or because the process
              // died — ran to completion in the operator's container. This
              // line makes the bound the machine's own, so it holds even when
              // nothing is left to enforce it from outside. `--kill-after`
              // means a command that ignores TERM is still gone.
              //
              // `setsid` and the tag are M5-BE-31's, and they are needed
              // BECAUSE of the bound: an aborted `run` reaches the process
              // it started, which once the command is wrapped is `timeout` —
              // the shell under it and everything that shell spawned are
              // children that outlive it. So the command gets a session of
              // its own and a name, and the cancel path kills the whole
              // group rather than the one process the signal would reach.
              // The bot's OWN desktop, resolved before the command is built.
              //
              // Without this the command inherits the image's `DISPLAY=:1`, the
              // machine's root screen — so `scrot` photographed a desktop no
              // client shows and the operator, looking at the seat on the same
              // screen, got a picture of nothing they could see. The seat is
              // ENSURED rather than looked up, exactly as `capture_screen`
              // does: a bot running a command is a bot whose desktop is the
              // place its windows should land, and a seat that is not there yet
              // is one this call creates.
              //
              // A machine that cannot hand one over is not a reason to refuse
              // the command: `ls`, `git` and `pnpm` have nothing to do with a
              // display, and the resolution failure that matters (the container
              // gone) surfaces from `run` below with its own message.
              let env: Record<string, string>;
              try {
                env = seatEnv(await deps.machines.ensureSeatFor(context.botId));
              } catch {
                // Keep headless commands usable without borrowing another desktop.
                env = { DISPLAY: '', DBUS_SESSION_BUS_ADDRESS: '' };
              }
              if (abortSignal?.aborted) {
                return 'shell: the turn was cancelled before the command started.';
              }
              const result = await session.run({
                command:
                  `setsid timeout --kill-after=${SHELL_KILL_AFTER} ${SHELL_TIMEOUT_S}s ` +
                  `bash -lc ${shellQuote(
                    `mkdir -p ${shellQuote(ownArea)} && ` +
                      `cd ${shellQuote(startDir)} && ` +
                      taggedCommand(command, id),
                  )}`,
                workingDirectory: MACHINE_HOME,
                env,
                abortSignal:
                  abortSignal === undefined
                    ? AbortSignal.timeout(SHELL_WAIT_MS)
                    : AbortSignal.any([abortSignal, AbortSignal.timeout(SHELL_WAIT_MS)]),
              });
              if (result.exitCode === 124) {
                // `timeout`'s own exit code. Said plainly, because the model's
                // next move is to run something shorter — and "exit 124" on
                // its own reads like the command's.
                return bounded(
                  `shell: the command was still running after ${SHELL_TIMEOUT_S}s and was ` +
                    `stopped.\n${result.stdout.trim()}`,
                );
              }
              const stdout = result.stdout.trim();
              const stderr = result.stderr.trim();
              // A non-zero exit is how a shell reports things, not a fault:
              // the model is told the code and the stderr and usually fixes
              // the command itself.
              const parts = [
                `exit ${result.exitCode}`,
                stdout === '' ? null : `stdout:\n${stdout}`,
                stderr === '' ? null : `stderr:\n${stderr}`,
              ].filter((part): part is string => part !== null);
              return bounded(parts.join('\n'));
            } catch (error) {
              return failure(`shell ${JSON.stringify(command)}`, error);
            } finally {
              abortSignal?.removeEventListener('abort', stopIt);
            }
          },
        }),
    },
    {
      name: 'fs_read',
      behavior: OBSERVING_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            `Read a text file from this bot’s computer with 1-based line numbers. Your own area is ` +
            `${MACHINE_HOME}/agents/${context.botId}; ${MACHINE_HOME}/shared is the team's. ` +
            'A relative path is resolved against your own area. Pass startLine and endLine ' +
            'to read a specific slice of large files.',
          inputSchema: NativeToolInputs.fs_read,
          execute: async ({
            path,
            startLine,
            endLine,
          }: {
            path: string;
            startLine?: number | undefined;
            endLine?: number | undefined;
          }) => {
            const verdict = resolveWorkspacePath(
              context.botId,
              path,
              context.groupId ?? null,
              context.workingDirectory,
            );
            if (!verdict.ok) return `fs_read refused: ${verdict.reason}`;
            if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
              return `fs_read refused: endLine (${endLine}) must be greater than or equal to startLine (${startLine}).`;
            }
            const effectiveStart = startLine ?? 1;
            try {
              const session = await context.session();
              if (session.readTextFileRange !== undefined) {
                const ranged = await session.readTextFileRange({
                  path: verdict.path,
                  ...(startLine !== undefined ? { startLine } : {}),
                  ...(endLine !== undefined ? { endLine } : {}),
                  maxBytes: RANGE_FETCH_MAX_BYTES,
                });
                if (ranged === null) return `fs_read: ${verdict.path} does not exist`;
                if (ranged.binary) {
                  return (
                    `fs_read refused: ${JSON.stringify(verdict.path)} contains binary data. ` +
                    'This tool reads text files only. Use screenshot or capture_screen to view the computer; ' +
                    'use shell to extract text from binary documents first.'
                  );
                }
                return formatReadOutput({
                  path: verdict.path,
                  text: ranged.text,
                  startLine: ranged.startLine,
                  endLineRequested: endLine,
                  totalLines: ranged.totalLines,
                  totalChars: Math.max(ranged.text.length, ranged.totalBytes),
                  byteTruncated: ranged.byteTruncated,
                });
              }

              const text = await session.readTextFile({ path: verdict.path });
              if (text === null) return `fs_read: ${verdict.path} does not exist`;
              if (text.includes('\u0000'))
                return (
                  `fs_read refused: ${JSON.stringify(verdict.path)} contains binary data. ` +
                  'This tool reads text files only. Use screenshot or capture_screen to view the computer; ' +
                  'use shell to extract text from binary documents first.'
                );
              if (text === '') {
                return formatReadOutput({
                  path: verdict.path,
                  text: '',
                  startLine: effectiveStart,
                  endLineRequested: endLine,
                  totalLines: 0,
                  totalChars: 0,
                  byteTruncated: false,
                });
              }
              const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
              const allLines = normalized.split('\n');
              const from = effectiveStart - 1;
              const to =
                endLine === undefined ? allLines.length : Math.min(allLines.length, endLine);
              const slice = from >= allLines.length ? '' : allLines.slice(from, to).join('\n');
              return formatReadOutput({
                path: verdict.path,
                text: slice,
                startLine: effectiveStart,
                endLineRequested: endLine,
                totalLines: allLines.length,
                totalChars: text.length,
                byteTruncated: false,
              });
            } catch (error) {
              return failure(`fs_read ${JSON.stringify(verdict.path)}`, error);
            }
          },
        }),
    },
    {
      name: 'fs_write',
      behavior: CONTAINED_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            `Write a text file on this bot’s computer, creating or replacing it. Your own area ` +
            `is ${MACHINE_HOME}/agents/${context.botId}; ${MACHINE_HOME}/shared is the team's, and ` +
            'anything you put there every other bot on this machine can read.',
          inputSchema: NativeToolInputs.fs_write,
          execute: async ({ path, content }: { path: string; content: string }) => {
            const verdict = resolveWorkspacePath(
              context.botId,
              path,
              context.groupId ?? null,
              context.workingDirectory,
            );
            if (!verdict.ok) return `fs_write refused: ${verdict.reason}`;
            const gitRefusal = gitConfigWriteRefusal(verdict.path);
            if (gitRefusal !== null) return `fs_write refused: ${gitRefusal}`;
            const bytes = Buffer.byteLength(content, 'utf8');
            if (bytes > MAX_WRITE_BYTES) {
              // A model that meant to write a file this large has usually
              // pasted something back to itself, and the machine's volume is
              // shared by every tenant on it.
              return (
                `fs_write refused: ${bytes.toLocaleString('en-US')} bytes is over the ` +
                `${MAX_WRITE_BYTES.toLocaleString('en-US')}-byte limit for one write.`
              );
            }
            try {
              const session = await context.session();
              await session.writeTextFile({ path: verdict.path, content });
              return `wrote ${bytes.toLocaleString('en-US')} bytes to ${verdict.path}`;
            } catch (error) {
              return failure(`fs_write ${JSON.stringify(verdict.path)}`, error);
            }
          },
        }),
    },
  ];
}
