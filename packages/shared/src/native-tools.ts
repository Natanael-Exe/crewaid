import { z } from 'zod';
import { TemplateInstallBodySchema } from './templates.js';
import { JsonSchema, JsonSchemaObjectSchema } from './primitives.js';
import { PresentVisualInputSchema } from './visuals.js';

const id = z.string();
const KIND = z.enum(['preference', 'convention', 'fact', 'decision', 'task_state', 'resource']);
const SCOPE = z.enum(['workspace', 'mine']);
const MAX_CONTENT_CHARS = 8000;
const profileFields = {
  name: z.string().min(1).max(64).describe('The teammate’s display name, e.g. "Quill".'),
  role: z
    .string()
    .min(1)
    .max(128)
    .describe('What this bot is on the team, e.g. "Outbound Writer".'),
  systemPrompt: z
    .string()
    .describe('The character brief: who this bot is, what it is good at, how it should behave.'),
  modelId: z
    .string()
    .optional()
    .describe('Which model to run, e.g. "anthropic:claude-sonnet-4". Omit for the default.'),
  avatarColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .describe('Hex colour for the avatar, e.g. "#7c3aed".'),
} as const;

/** Native model arguments, shared without server execution or policy authority. */
export const NativeToolInputs = {
  search_templates: z.object({ query: z.string().max(200).optional() }),
  read_template: z.object({
    templateId: z.string(),
    goal: z
      .string()
      .max(1000)
      .optional()
      .describe('What the crew should help with, drafted from the conversation.'),
    context: z
      .string()
      .max(4000)
      .optional()
      .describe('Business context worth sharing with the crew. Nothing personal.'),
  }),
  install_template: TemplateInstallBodySchema.omit({ idempotencyKey: true }),
  preview_email: z
    .object({
      to: z
        .string()
        .max(1000)
        .describe('Recipients as displayed in the preview; leave empty if undecided.'),
      subject: z.string().max(1000),
      body: z.string().min(1).max(20_000).describe('The full plain-text email to review in chat.'),
      cc: z.array(z.string().max(320)).max(20).optional(),
      bcc: z.array(z.string().max(320)).max(20).optional(),
    })
    .strict(),
  present_visual: PresentVisualInputSchema,
  task_list: z.object({
    assignee: z.string().optional(),
    status: z.string().optional(),
    projectId: id.optional(),
    goalId: id.optional(),
    seriesId: id.optional(),
    occursFrom: z.string().optional(),
    occursThrough: z.string().optional(),
  }),
  task_read: z.object({ taskId: id }),
  task_create: z.object({
    title: z.string(),
    brief: z.string().optional(),
    projectId: id.optional(),
    goalId: id.optional(),
    parentId: id.optional(),
    assignee: z.string().optional(),
    after: id.optional(),
    repeat: z.string().optional(),
  }),
  task_update: z.object({
    taskId: id,
    status: z.string().optional(),
    note: z.string().optional(),
    assignee: z.string().nullable().optional(),
    title: z.string().optional(),
    brief: z.string().optional(),
    projectId: id.nullable().optional(),
    goalId: id.nullable().optional(),
    repeat: z.string().nullable().optional(),
  }),
  project_create: z.object({ name: z.string(), goal: z.string().optional() }),
  send_message: z.object({
    toBot: z
      .string()
      .describe(
        "The other bot's name, e.g. Quill (its id also works; a teammate the user " +
          'tagged as @Quill is the same bot)',
      ),
    content: z
      .string()
      .max(MAX_CONTENT_CHARS)
      .describe(
        'What to say. Include everything that bot needs — it cannot see your ' +
          'work: the task, what it is for, and what done looks like. Say it once ' +
          'and plainly; your caveats about how it might fail are noise to it.',
      ),
    taskId: z.string().nullable().optional().describe('Omit: keep your task; null: none.'),
  }),
  schedule_routine: z.object({
    name: z.string().min(1).max(80).describe('A short name the user will recognise.'),
    cron: z
      .string()
      .describe(
        'Five fields: minute hour day-of-month month day-of-week, e.g. "0 9 * * 1-5" ' +
          'for 09:00 on weekdays, or "30 8 24 9 *" for 08:30 on 24 September.',
      ),
    timezone: z
      .string()
      .optional()
      .describe(
        'IANA zone the cron is read in, e.g. "America/New_York". Defaults to ' +
          "the user's timezone.",
      ),
    prompt: z
      .string()
      .min(1)
      .max(4000)
      .describe('What to do when it runs, written to your future self.'),
  }),
  cancel_routine: z.object({
    routine: z.string().min(1).describe('The routine id, or its exact name.'),
  }),
  board_read: z.object({}).describe('No arguments.'),
  board_add: z.object({
    entry: z.string().describe('The entry to append, e.g. `- [ ] Draft the pricing page copy`'),
  }),
  board_update: z.object({
    find: z.string().describe('The exact text to replace, copied from board_read'),
    replace: z.string().describe('What to put in its place; empty removes it'),
  }),
  save_skill: z.object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, 'snake_case: lower-case words joined by underscores')
      .describe('The skill’s name, e.g. apply_coupon_code'),
    description: z
      .string()
      .describe('One or two sentences on what the skill does and when to use it.'),
    paramsSchema: JsonSchemaObjectSchema.optional().describe(
      'JSON Schema for the skill’s arguments; omit for a skill that takes none.',
    ),
    script: z.string().describe('The full TypeScript module source.'),
  }),
  use_identity: z.object({
    identity: z
      .string()
      .describe(
        'The identity name, e.g. "company-google". Letters, digits, underscore and ' +
          'hyphen only. Reuse the exact name a person gave you; a new name creates a ' +
          'new, signed-out profile rather than finding an existing session.',
      ),
  }),
  capture_screen: z.object({}).describe('No arguments.'),
  record_screen_start: z.object({}).describe('No arguments.'),
  record_screen_stop: z.object({}).describe('No arguments.'),
  mouse_move: z.object({
    x: z.number().int().describe('Pixels from the left edge of the screen'),
    y: z.number().int().describe('Pixels from the top edge of the screen'),
  }),
  mouse_click: z.object({
    x: z.number().int().describe('Pixels from the left edge of the screen'),
    y: z.number().int().describe('Pixels from the top edge of the screen'),
    button: z
      .enum(['left', 'middle', 'right', 'double'])
      .describe('Which click. Default left.')
      .optional(),
  }),
  mouse_scroll: z.object({
    direction: z.enum(['up', 'down']).describe('Which way to scroll.'),
    amount: z.number().int().min(1).max(10).describe('Wheel clicks to send. Default 3.').optional(),
  }),
  keyboard: z.object({
    text: z.string().describe('Text to type, including newlines as \\n.').optional(),
    keys: z
      .array(z.string())
      .describe(
        'Key combinations to press in order, e.g. ["ctrl+l", "Return"]. ' +
          'Modifiers are spelled out: ctrl, alt, shift, super.',
      )
      .optional(),
  }),
  create_bot: z.object({ ...profileFields }),
  edit_bot: z.object({
    botId: z.string().describe('The id of the bot to edit.'),
    name: z.string().min(1).max(64).optional(),
    role: z.string().min(1).max(128).optional(),
    systemPrompt: z.string().optional(),
    modelId: z.string().optional(),
    avatarColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    pinned: z.boolean().optional(),
    hiddenFromSidebar: z.boolean().optional(),
  }),
  delete_bot: z.object({
    botId: z.string().describe('The id of the bot to delete.'),
  }),
  memory_read: z.object({}).describe('No arguments.'),
  remember: z.object({
    // `fact`, not `text`. The column is `text`; the PARAMETER is part
    // of the model-facing surface and renaming it buys nothing a
    // model can use.
    fact: z
      .string()
      .describe('One self-contained fact, e.g. `The staging site is crewaid-staging.example.com`'),
    kind: KIND.describe(
      'What sort of claim this is. `task_state` is where work stands and is replaced as ' +
        'it moves on; `resource` points at where something was read rather than copying it.',
    ),
    scope: SCOPE.describe(
      '`workspace` — true no matter which of your bots is asked, and your name is ' +
        'recorded beside it so your teammates can tell whose work the fact describes. ' +
        '`mine` — true about your own role and work. Choose deliberately; there is no default.',
    ),
    // Resolve the omitted detail before binding a policy proposal.
    detail: z
      .string()
      .default('')
      .describe('For a `decision`, why it was made and what would reopen it.'),
  }),
  memory_search: z.object({
    query: z.string().describe('What to look for, in words. Plain language, not operators.'),
  }),
  forget: z.object({
    fact: z.string().describe('The exact text to remove, copied from memory_read'),
  }),
  run_skill: z
    .object({
      name: z.string().describe('The skill name, e.g. summarize_inbox'),
      params: z
        .record(z.string(), JsonSchema)
        .describe("Arguments matching the skill's parameter schema")
        .optional(),
    })
    .strict(),
  attach_file: z.object({
    path: z.string().describe('Absolute path on the bot computer, e.g. /home/bot/report.pdf'),
    note: z.string().describe('One line describing the file, shown with it').optional(),
    // File it under the user's task or goal. Without them it is
    // filed under whatever this turn's work came from.
    taskId: z.string().optional(),
    goalId: z.string().optional(),
  }),
  screenshot: z.object({}).describe('No arguments.'),
  shell: z.object({
    command: z
      .string()
      .describe('A single shell command line, e.g. `ls -la ~/shared` or `git status`'),
  }),
  fs_read: z.object({
    path: z.string().describe('An absolute path, or one relative to your own area'),
  }),
  fs_write: z.object({
    path: z.string().describe('An absolute path, or one relative to your own area'),
    content: z.string().describe('The whole file contents; this replaces what was there'),
  }),
  browser_navigate: z.object({
    url: z.string().describe('An absolute http(s) URL, e.g. https://example.com/pricing'),
  }),
  browser_read: z.object({}),
  browser_click: z.object({
    reference: z
      .string()
      .describe('The exact reference from the latest browser_read [ref=...] annotation'),
  }),
  browser_type: z.object({
    reference: z
      .string()
      .describe('The exact editable reference from the latest browser_read snapshot'),
    text: z.string().describe('The text to type'),
  }),
} as const;
export type NativeToolName = keyof typeof NativeToolInputs;
