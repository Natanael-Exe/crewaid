import { tool } from './tool-contract.js';
import { NativeToolInputs } from '@crewaid/shared';

import { CONTAINED_BUILTIN, OBSERVING_BUILTIN } from './tool-registry.js';
import type { RegisteredTool, ToolContext } from './tool-registry.js';
import { MACHINE_HOME } from './workspace-paths.js';
import {
  appendToDocument,
  counted,
  readDocument,
  replaceInDocument,
  type SharedDocument,
} from './shared-document.js';
import type { BoardStoreService } from './board-store.service.js';

/**
 * The shared task board, as a tool.
 *
 * Why a tool and not a skill
 *
 * A board is a file, and a bot already has `fs_read`/`fs_write`. What those
 * cannot give it is the two things the board is FOR:
 *
 * - AGREEMENT. Every bot on a machine has to mean the same file, without an
 * operator telling each one a path. A taught skill teaches one bot; a
 * built-in is the same board for all of them, including the bot created
 * tomorrow.
 * - A WRITE THAT DOES NOT DESTROY SOMEONE ELSE'S — which is
 * `shared-document.ts`, and the reason that file exists.
 *
 * The board note's other half — "a recorded demonstration of editing a file is
 * brittle where a typed write is not" — is the same point from the M3 side: a
 * compiled skill replays selectors against a page, and a board is not a page.
 *
 * Where it lives
 *
 * `/home/bot/shared/BOARD.md`. WORKSPACE §19 already says the shared area
 * holds "the project, worktrees, the board, memory", so the directory is not
 * a choice this file makes; only the filename is. It is on the MACHINE rather
 * than in the orchestrator's database because the board is the project's: it
 * lives where the work does, it is in the operator's volume, and it can be
 * read and edited by hand — or committed — without asking Crewaid for it.
 */

/** The one board every bot on a machine shares (WORKSPACE §19). */
export const BOARD_PATH = `${MACHINE_HOME}/shared/BOARD.md`;

const BOARD: SharedDocument = { path: BOARD_PATH, maxChars: 32_000 };

export function boardTools(store?: BoardStoreService): RegisteredTool[] {
  return [
    {
      name: 'board_read',
      behavior: OBSERVING_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            `Read your team's working notes, ${BOARD_PATH}, which this computer's bots share. ` +
            "They are not the user's task list — that is task_list. " +
            'Entries are owned per bot and backed by durable revision history; ' +
            'pass restore: true if the file was overwritten externally. ' +
            'Read them before you start work and before you change them: a sibling may have ' +
            'edited them since you last looked.',
          inputSchema: NativeToolInputs.board_read,
          execute: async (input?: { restore?: boolean | undefined }) => {
            if (store !== undefined) {
              const outcome = await store.read(context, { restore: input?.restore === true });
              switch (outcome.kind) {
                case 'read':
                  if (outcome.displaced === true) {
                    return (
                      `${outcome.text}\n(Note: ${BOARD_PATH} was restored from durable board ` +
                      'history. It held edits made outside the board tools; those were saved to ' +
                      'board history first. Add entries with board_add so they last.)'
                    );
                  }
                  return outcome.restored === true
                    ? `${outcome.text}\n(Note: ${BOARD_PATH} was restored from durable board history.)`
                    : outcome.text;
                case 'empty':
                  return `The board at ${BOARD_PATH} is empty.`;
                case 'absent':
                  return `The board at ${BOARD_PATH} does not exist yet. board_add starts it.`;
                default:
                  return `board_read failed: ${outcome.detail}`;
              }
            }
            const outcome = await readDocument(context, BOARD);
            switch (outcome.kind) {
              case 'read':
                return outcome.text;
              case 'empty':
                return `The board at ${BOARD_PATH} is empty.`;
              case 'absent':
                // "does not exist" and not "failed": an empty board is the
                // ordinary state of a new machine, and a model told it failed
                // stops instead of starting one.
                return `The board at ${BOARD_PATH} does not exist yet. board_add starts it.`;
              default:
                return `board_read failed: ${'detail' in outcome ? outcome.detail : outcome.kind}`;
            }
          },
        }),
    },
    {
      name: 'board_add',
      behavior: CONTAINED_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            "Add an entry owned by you to your team's working notes, creating them if this is " +
            'the first one. Entries are stored atomically so concurrent updates never overwrite ' +
            'a teammate. Call board_read first if you want to see existing notes.',
          inputSchema: NativeToolInputs.board_add,
          execute: async ({ entry }: { entry: string }) => {
            const text = entry.trim();
            if (text === '') return 'board_add refused: an entry is required';
            if (store !== undefined) {
              const outcome = await store.add(context, text);
              switch (outcome.kind) {
                case 'written':
                  return `Added to ${BOARD_PATH}: ${text}`;
                case 'too-large':
                  return (
                    `board_add refused: the board would be ${counted(outcome.would)} characters, ` +
                    `over the ${counted(outcome.limit)} limit. Remove finished entries with ` +
                    'board_update first.'
                  );
                default:
                  return `board_add failed: ${'detail' in outcome ? outcome.detail : outcome.kind}`;
              }
            }
            const outcome = await appendToDocument(context, BOARD, text);
            switch (outcome.kind) {
              case 'written':
                return `Added to ${BOARD_PATH}: ${text}`;
              case 'too-large':
                return (
                  `board_add refused: the board would be ${counted(outcome.would)} characters, ` +
                  `over the ${counted(outcome.limit)} limit. Remove finished entries with ` +
                  'board_update first.'
                );
              default:
                return `board_add failed: ${'detail' in outcome ? outcome.detail : outcome.kind}`;
            }
          },
        }),
    },
    {
      name: 'board_update',
      behavior: CONTAINED_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            "Replace one exact piece of text in one of YOUR entries on your team's working notes — " +
            'how you tick an entry off, reword it, or remove it (replace with an empty string). ' +
            'You cannot overwrite another bot’s entry. The text must appear once; pass more context if needed.',
          inputSchema: NativeToolInputs.board_update,
          execute: async ({ find, replace }: { find: string; replace: string }) => {
            if (find === '') return 'board_update refused: the text to replace is required';
            if (store !== undefined) {
              const outcome = await store.update(context, find, replace);
              switch (outcome.kind) {
                case 'written':
                  return `Updated ${BOARD_PATH}: ${find} -> ${replace}`;
                case 'removed':
                  return `Removed from ${BOARD_PATH}: ${find}`;
                case 'absent':
                  return `board_update failed: there is no board at ${BOARD_PATH} yet.`;
                case 'not-found':
                  return (
                    'board_update failed: that text is not on the board. It may have been ' +
                    'changed by another bot — call board_read and try again.'
                  );
                case 'ambiguous':
                  return (
                    'board_update failed: that text appears more than once on the board. ' +
                    'Pass more of the surrounding line so it matches exactly one entry.'
                  );
                case 'not-owner':
                  return (
                    `board_update refused: that entry belongs to ${outcome.ownerName}. ` +
                    'You can only edit or remove your own board entries; add your own entry with board_add instead.'
                  );
                case 'too-large':
                  return (
                    `board_update refused: the board would be ${counted(outcome.would)} ` +
                    `characters, over the ${counted(outcome.limit)} limit.`
                  );
                default:
                  return `board_update failed: ${outcome.detail}`;
              }
            }
            const outcome = await replaceInDocument(context, BOARD, find, replace);
            switch (outcome.kind) {
              case 'written':
                return replace === ''
                  ? `Removed from ${BOARD_PATH}: ${find}`
                  : `Updated ${BOARD_PATH}: ${find} -> ${replace}`;
              case 'absent':
                return `board_update failed: there is no board at ${BOARD_PATH} yet.`;
              case 'not-found':
                // The interesting failure on a SHARED board, and worth saying
                // plainly: the likeliest cause is not a typo but a sibling
                // having changed that line since this bot read it.
                return (
                  'board_update failed: that text is not on the board. It may have been ' +
                  'changed by another bot — call board_read and try again.'
                );
              case 'ambiguous':
                return (
                  'board_update failed: that text appears more than once on the board. ' +
                  'Pass more of the surrounding line so it matches exactly one entry.'
                );
              case 'too-large':
                return (
                  `board_update refused: the board would be ${counted(outcome.would)} ` +
                  `characters, over the ${counted(outcome.limit)} limit.`
                );
              default:
                return `board_update failed: ${'detail' in outcome ? outcome.detail : outcome.kind}`;
            }
          },
        }),
    },
  ];
}
