import { tool } from '../agent/tool-contract.js';
import { NativeToolInputs } from '@crewaid/shared';

import { CONTAINED_BUILTIN, OBSERVING_BUILTIN } from '../agent/tool-registry.js';
import type { RegisteredTool, ToolContext } from '../agent/tool-registry.js';
import {
  refusalText,
  type TaskCreateInput,
  type TaskListInput,
  type TaskUpdateInput,
  type WorkToolsService,
} from './work-tools.service.js';

/**
 * The Work tools: list, read, create and update the user's tasks, and
 * create a project. All `contained`, so the shipped rules run them without
 * asking — they read and write records, and none of them starts anything.
 *
 * Why the definitions are this short
 *
 * They are sent with every step of every turn of every bot, whether or not
 * that bot ever touches a task, so PRD-WORK §8 caps all of them together at
 * 500 estimated tokens and `work-tools.test.ts` measures it. What guidance
 * there is follows §6.1: these are the user's tasks, use them when asked or
 * when your work came from one, suggest a split before making one, and a
 * note on a status change helps whoever reads the task later.
 */

type Port = Pick<
  WorkToolsService,
  'actor' | 'list' | 'read' | 'create' | 'update' | 'createProject'
>;

function contained(name: string, build: RegisteredTool['build']): RegisteredTool {
  return { name, behavior: CONTAINED_BUILTIN, build };
}

/** A Work tool that only reads the record: "Ask for approval" never asks about it. */
function observing(name: string, build: RegisteredTool['build']): RegisteredTool {
  return { name, behavior: OBSERVING_BUILTIN, build };
}

async function answer(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (error) {
    return refusalText(error);
  }
}

export function workTools(port: Port): RegisteredTool[] {
  // The message a change is logged against is this call's own host —
  // the reply being composed, or the call's tool result row.
  const actor = async (context: ToolContext, toolCallId: string) =>
    port.actor(context.userId, context.botId, await context.attachmentHost(toolCallId));
  return [
    observing('task_list', (context) =>
      tool({
        description:
          "The user's tasks, default your open ones. assignee: me/any/none/a bot. " +
          'status: one/open/any. Dates YYYY-MM-DD.',
        inputSchema: NativeToolInputs.task_list,
        execute: (input: TaskListInput) =>
          answer(() => port.list(context.userId, context.botId, input)),
      }),
    ),
    observing('task_read', (context) =>
      tool({
        description: 'A task in full.',
        inputSchema: NativeToolInputs.task_read,
        execute: ({ taskId }: { taskId: string }) =>
          answer(() => port.read(context.userId, taskId)),
      }),
    ),
    contained('task_create', (context) =>
      tool({
        description:
          "Add a task to the user's To do; starts nothing. Only when asked; suggest big " +
          "splits first. repeat: 'cron zone'.",
        inputSchema: NativeToolInputs.task_create,
        execute: (input: TaskCreateInput, options) =>
          answer(async () =>
            port.create(context.userId, await actor(context, options.toolCallId), input),
          ),
      }),
    ),
    contained('task_update', (context) =>
      tool({
        description: 'Change a task; add a note when you change status. repeat: null stops it.',
        inputSchema: NativeToolInputs.task_update,
        execute: (input: TaskUpdateInput, options) =>
          answer(async () =>
            port.update(context.userId, await actor(context, options.toolCallId), input),
          ),
      }),
    ),
    contained('project_create', (context) =>
      tool({
        description: 'New project, optionally with a goal.',
        inputSchema: NativeToolInputs.project_create,
        execute: (input: { name: string; goal?: string | undefined }) =>
          answer(() => port.createProject(context.userId, input)),
      }),
    ),
  ];
}
