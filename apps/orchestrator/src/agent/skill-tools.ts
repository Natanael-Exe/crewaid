import { basename } from 'node:path';
import { tool } from './tool-contract.js';
import { NativeToolInputs } from '@crewaid/shared';

import { ATTACHMENT_MAX_BYTES } from '@crewaid/shared';

import { SEAT_BUILTIN, CONTAINED_BUILTIN } from './tool-registry.js';
import type { RegisteredTool, ToolContext } from './tool-registry.js';
import type { DeliverableFiling } from '../work/file-deliverable.js';

/**
 * `run_skill` and `attach_file`.
 *
 * `send_message` was here too, as a stub. M7-BE-01 made it real and moved it
 * to `interbot/send-message.tool.ts`, which is where its delivery queue lives
 * — the same rule that put these two here rather than in `BotsModule`: a tool
 * group registers itself from wherever its dependencies already are.
 *
 * ONE `run_skill`, NOT ONE TOOL PER SKILL
 *
 * §6/M5 spells it `run_skill(name, params)`, and that spelling settles a
 * question M5-BE-03 left open. A registry keyed on tool name, holding one
 * entry per skill, would put every bot's skills in every bot's tool set —
 * `Skill.botId` is per-bot, so that leaks a private skill sideways. One
 * built-in whose ARGUMENT is the name moves the reachability question to
 * where it can be answered correctly: a scoped query, per call, against the
 * calling bot.
 *
 * Failures are results
 *
 * Same rule the browser tools follow, and the words: a denial "returns a
 * tool result the model can react to, not an exception". A DRAFT skill, a
 * name that is not there, a script that threw — the model can choose
 * differently when told, and cannot when the turn dies.
 */

export interface SkillRunPort {
  runForBot(
    userId: string,
    botId: string,
    name: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    permit?: (revision: string, params: unknown) => Promise<void>,
  ): Promise<{ status: string; logs: string | null; error: string | null }>;
}

export interface AttachmentPort {
  /** Store bytes as an attachment owned by `userId`, claimed by `messageId`. */
  storeFromBot(input: {
    userId: string;
    messageId: string;
    filename: string;
    bytes: Buffer;
    /** Files it as a deliverable. */
    filing?: DeliverableFiling;
  }): Promise<{ id: string; filename: string; sizeBytes: number }>;
}

function failure(action: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${action} failed: ${detail}`;
}

/**
 * POSIX single-quoting for a path the MODEL supplied.
 *
 * `run` takes a shell string, so a path is interpolated into one. Single
 * quotes make every character literal except a single quote itself, which is
 * closed, escaped and reopened. Without this, a path is an injection point
 * into the bot's own computer.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Tool results are persisted verbatim; a whole log is not a tool result. */
const MAX_LOG_CHARS = 4_000;

export function skillTools(deps: {
  skills: SkillRunPort;
  attachments: AttachmentPort;
}): RegisteredTool[] {
  return [
    {
      name: 'run_skill',
      behavior: SEAT_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            "Run one of this bot's approved skills by name. Only APPROVED skills are " +
            'runnable — a skill still in draft cannot be run. Returns the run outcome.',
          inputSchema: NativeToolInputs.run_skill,
          execute: async (
            input: {
              name: string;
              params?: Record<string, unknown> | undefined;
            },
            options,
          ) => {
            const { name, params } = input;
            try {
              const outcome = await deps.skills.runForBot(
                context.userId,
                context.botId,
                name,
                params ?? {},
                options.abortSignal,
                context.policy?.skillPermit(options.toolCallId),
              );
              const logs = (outcome.logs ?? '').slice(0, MAX_LOG_CHARS);
              const truncated = (outcome.logs ?? '').length > MAX_LOG_CHARS ? ' …(truncated)' : '';
              if (outcome.status === 'SUCCEEDED') {
                return `${name} succeeded.${logs === '' ? '' : `\n${logs}${truncated}`}`;
              }
              // The failure a skill reports is the interesting half of the
              // result — the model can often fix the params and retry.
              return `${name} ${outcome.status.toLowerCase()}: ${outcome.error ?? 'no reason given'}${
                logs === '' ? '' : `\n${logs}${truncated}`
              }`;
            } catch (error) {
              return failure('run_skill', error);
            }
          },
        }),
    },
    {
      name: 'attach_file',
      behavior: CONTAINED_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            "Attach a file from this bot's computer to the reply, so the operator can " +
            'download it from the chat.',
          inputSchema: NativeToolInputs.attach_file,
          execute: async (
            input: {
              path: string;
              note?: string | undefined;
              taskId?: string | undefined;
              goalId?: string | undefined;
            },
            options,
          ) => {
            const { path, note } = input;
            try {
              // The REDUCED session. A tool cannot stop the sandbox or
              // change its network policy, and this is the object that makes
              // that true rather than a rule anyone has to remember.
              const session = await context.session();

              // Size is checked BEFORE the bytes are read, not after. The
              // attachment cap lives in `AttachmentsService.store`, which
              // sees a Buffer — so without this the orchestrator allocates
              // the whole file just to refuse it. The upload path is bounded
              // before buffering by multer; this is that bound for
              // the tool path. It matters because §7.3 makes the sandbox the
              // untrusted side and D-039 gives it no fixed-size disk: a skill
              // that writes a multi-GB file and then attaches it would
              // otherwise ask this process for multi-GB of heap.
              const sized = await session.run({ command: `stat -c %s ${shellQuote(path)}` });
              if (sized.exitCode !== 0) {
                return failure('attach_file', new Error(`no file at ${path}`));
              }
              const size = Number.parseInt(String(sized.stdout).trim(), 10);
              if (Number.isFinite(size) && size > ATTACHMENT_MAX_BYTES) {
                return failure(
                  'attach_file',
                  new Error(
                    `${path} is ${size} bytes, over the ${ATTACHMENT_MAX_BYTES}-byte attachment limit`,
                  ),
                );
              }

              const bytes = await session.readBinaryFile({ path });
              // null, not a throw, is how the session reports a path that is
              // not there — and a model that mistyped a path needs to be told
              // which path, not handed an empty attachment.
              if (bytes === null) return failure('attach_file', new Error(`no file at ${path}`));
              const buffer = Buffer.from(bytes);
              const stored = await deps.attachments.storeFromBot({
                userId: context.userId,
                // The host this call files under: the reply being
                // composed, or this call's own tool result.
                messageId: await context.attachmentHost(options.toolCallId),
                filename: basename(path),
                bytes: buffer,
                filing: {
                  triggerMessageId: context.trigger.id,
                  sourcePath: path,
                  ...(note !== undefined && { summary: note }),
                  ...(input.taskId !== undefined && { taskId: input.taskId }),
                  ...(input.goalId !== undefined && { goalId: input.goalId }),
                },
              });
              return `attached ${stored.filename} (${stored.sizeBytes} bytes)${
                note === undefined ? '' : ` — ${note}`
              }`;
            } catch (error) {
              return failure('attach_file', error);
            }
          },
        }),
    },
  ];
}
