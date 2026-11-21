import { toolReach } from '../src/agent/tool-registry.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_AUTO_REVIEW_RULES } from '@crewaid/shared';

import { decideAutoReview } from '../src/agent/auto-review.js';
import type { RegisteredTool, ToolContext } from '../src/agent/tool-registry.js';
import { sendMessageTool } from '../src/interbot/send-message.tool.js';
import { workTools } from '../src/work/work-tools.js';

/**
 * M10-BE-06 — what the task tools cost every bot, and that they never ask.
 *
 * The definitions ride along on every step of every turn whether or not the
 * bot ever touches a task, so PRD-WORK §8 caps everything Work adds to them
 * at 500 estimated tokens: the five new tools, plus the `taskId` that
 * `send_message` gains. Estimated as the plugin budget estimates (four
 * characters a token), over name, description and JSON schema.
 */
const CHARS_PER_TOKEN = 4;
const BUDGET_TOKENS = 500;

const context = {
  userId: 'u',
  botId: 'b',
  messageId: 'm',
  trigger: { id: 't', chainId: null, hopCount: 0 },
} as unknown as ToolContext;

const port = {
  actor: () => Promise.reject(new Error('unused')),
  list: () => Promise.resolve(''),
  read: () => Promise.resolve(''),
  create: () => Promise.resolve(''),
  update: () => Promise.resolve(''),
  createProject: () => Promise.resolve(''),
};

function definitionChars(registered: RegisteredTool): number {
  const built = registered.build(context);
  const schema = z.toJSONSchema(built.inputSchema as z.ZodType);
  return registered.name.length + (built.description ?? '').length + JSON.stringify(schema).length;
}

function sendMessage(): RegisteredTool {
  return sendMessageTool({
    queue: { enqueue: () => Promise.resolve() },
    directory: { peers: () => Promise.resolve([]) },
    notice: { post: () => Promise.resolve() },
    budget: {
      spentTokens: () => Promise.resolve(0),
      sendsBetween: () => Promise.resolve(0),
      participatedInChain: () => Promise.resolve(false),
    },
    limits: { maxHops: 0, maxTokens: 0, maxRepeatSends: 0 },
  });
}

describe('M10-BE-06 — the task tools', () => {
  const tools = workTools(port);

  it('are the five PRD-WORK §6 names', () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      'task_list',
      'task_read',
      'task_create',
      'task_update',
      'project_create',
    ]);
  });

  it('together with send_message’s taskId and attach_file’s filing, stay within 500 estimated tokens', () => {
    const own = tools.reduce((sum, tool) => sum + definitionChars(tool), 0);
    const built = sendMessage().build(context);
    const schema = z.toJSONSchema(built.inputSchema as z.ZodType) as {
      properties: Record<string, unknown>;
    };
    const taskId = `"taskId":${JSON.stringify(schema.properties['taskId'])},`.length;
    // attach_file's filing ids (D-136), as its schema spells them.
    const filing = z.toJSONSchema(
      z.object({ taskId: z.string().optional(), goalId: z.string().optional() }),
    ) as { properties: Record<string, unknown> };
    const attach = Object.entries(filing.properties)
      .map(([key, value]) => `"${key}":${JSON.stringify(value)},`)
      .join('').length;
    const tokens = Math.ceil((own + taskId + attach) / CHARS_PER_TOKEN);
    expect(schema.properties['taskId']).toBeDefined();
    expect(tokens, `${tokens} estimated tokens`).toBeLessThanOrEqual(BUDGET_TOKENS);
  });

  it('run without asking under the shipped rules, as send_message does (D-092, D-138)', () => {
    for (const registered of [...tools, sendMessage()]) {
      expect(toolReach(registered.behavior)).toBe('contained');
      const outcome = decideAutoReview({
        rules: DEFAULT_AUTO_REVIEW_RULES,
        toolName: registered.name,
        args: {},
        behavior: registered.behavior,
      });
      expect(outcome.decision, registered.name).toBe('allow');
    }
  });

  it('name no vendor, and call the list the user’s', () => {
    for (const registered of tools) {
      const description = registered.build(context).description ?? '';
      expect(description).not.toMatch(/openai|anthropic|claude|gpt|gemini/i);
    }
    expect(tools[0]?.build(context).description).toContain("user's tasks");
  });
});
