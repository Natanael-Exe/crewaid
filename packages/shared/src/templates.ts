import { z } from 'zod';
import { AvatarShapeSchema, BotSchema } from './models.js';
import { LocaleSchema } from './locale.js';
import { CuidSchema, DateTimeSchema, HexColorSchema } from './primitives.js';

/**
 * One specialist as the catalog describes it. The same definition is
 * listed on its own and inside every crew that includes it, so the two can
 * never disagree about who the bot is.
 */
export const TemplateBotSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1).max(64),
  role: z.string().min(1).max(128),
  /** One line a person reads in a list. */
  summary: z.string(),
  /** What the bot is told: its character, then the catalog's shared working rules. */
  systemPrompt: z.string(),
  avatarColor: HexColorSchema,
  avatarShape: AvatarShapeSchema,
  toolSlugs: z.array(z.string()),
});
export type TemplateBot = z.infer<typeof TemplateBotSchema>;

/** One catalog contract serves chat, the Templates library and installation. */
export const TemplateSchema = z.object({
  id: z.string().min(1),
  revision: z.string().min(1),
  kind: z.enum(['crew', 'bot']),
  title: z.string(),
  category: z.string(),
  summary: z.string(),
  outcomes: z.array(z.string()),
  inputs: z.array(z.string()),
  /** Labelled as illustrative wherever shown: nobody has done this work yet. */
  examples: z.array(z.object({ title: z.string(), content: z.string() })),
  tools: z.array(z.object({ slug: z.string(), label: z.string(), required: z.boolean() })),
  bots: z.array(TemplateBotSchema).min(1),
  /** The order work usually moves through a crew. Empty for a single bot. */
  handoff: z.array(z.string()),
  starterTask: z.string(),
  routineSuggestion: z.string(),
  /** For a bot template: the crews that include the same specialist. */
  memberOf: z.array(z.string()).default([]),
  /** Only on `GET /templates/:id` and `read_template`: the caller's own connections. */
  connections: z
    .array(
      z.object({
        id: CuidSchema,
        slug: z.string(),
        name: z.string(),
        status: z.string(),
        accessMode: z.string(),
      }),
    )
    .default([]),
  /** Only on the detail read: earlier installs, with members that still exist. */
  installations: z
    .array(
      z.object({
        id: CuidSchema,
        groupId: CuidSchema.nullable(),
        botIds: z.array(CuidSchema),
        createdAt: DateTimeSchema,
        members: z.array(z.object({ id: CuidSchema, name: z.string(), role: z.string() })),
      }),
    )
    .default([]),
});
export type Template = z.infer<typeof TemplateSchema>;
export const TemplateListSchema = z.array(TemplateSchema);

/**
 * The one search both the library and `search_templates` run, so a person and
 * Crewaid find the same things. It reads only what a person reads — never a
 * system prompt, whose shared working rules would match every entry.
 */
export function templateMatches(template: Template, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [
    template.title,
    template.summary,
    template.category,
    ...template.outcomes,
    ...template.bots.flatMap((bot) => [bot.name, bot.role, bot.summary]),
    ...template.tools.map((tool) => tool.label),
  ]
    .join(' ')
    .toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * `POST /template-installations`. A crew adds its designed members; what a
 * person changes before adding is the brief and the tools. Each bot is edited
 * afterwards like any other.
 */
export const TemplateInstallBodySchema = z
  .object({
    templateId: z.string().min(1),
    revision: z.string().min(1),
    /** Retries of one request reuse it; a second, intended copy sends a new one. */
    idempotencyKey: z.string().min(8).max(160),
    goal: z.string().max(1000).default(''),
    context: z.string().max(4000).default(''),
    serverIds: z.array(CuidSchema).max(100).default([]),
  })
  .strict();
export type TemplateInstallBody = z.infer<typeof TemplateInstallBodySchema>;
export const TemplateInstallResponseSchema = z.object({
  id: CuidSchema,
  templateId: z.string(),
  revision: z.string(),
  groupId: CuidSchema.nullable(),
  botIds: z.array(CuidSchema).min(1),
  createdAt: DateTimeSchema,
});
export type TemplateInstallation = z.infer<typeof TemplateInstallResponseSchema>;

export const OnboardingDiscoverySchema = z.enum(['NEW', 'LEARNING', 'SKIPPED', 'COMPLETE']);
export const OnboardingStateSchema = z.object({
  userId: CuidSchema,
  welcomeSeen: z.boolean(),
  discovery: OnboardingDiscoverySchema,
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;
/**
 * What the person can answer Crewaid's welcome with, besides typing.
 * Each is stored as the person's own message, in these words, and answered
 * with Crewaid's fixed reply below; no model writes any of it.
 */
export const WelcomeReplySchema = z.enum(['TASK', 'TOUR']);
export type WelcomeReply = z.infer<typeof WelcomeReplySchema>;
export const UpdateOnboardingBodySchema = z
  .object({
    welcomeSeen: z.boolean().optional(),
    discovery: OnboardingDiscoverySchema.optional(),
    reply: WelcomeReplySchema.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.reply === undefined || (body.welcomeSeen === undefined && body.discovery === undefined),
    { message: 'A reply is an update of its own.', path: ['reply'] },
  );
export type UpdateOnboardingBody = z.infer<typeof UpdateOnboardingBodySchema>;
/**
 * `POST /onboarding/bootstrap`. `language` is what the opening window
 * shows, for a greeting written before that window's device report lands.
 * The account's own choice still wins over it, and it stores nothing.
 */
export const OnboardingBootstrapBodySchema = z
  .object({ language: LocaleSchema.optional() })
  .strict();
export type OnboardingBootstrapBody = z.infer<typeof OnboardingBootstrapBodySchema>;
export const OnboardingBootstrapSchema = z.object({
  bot: BotSchema,
  onboarding: OnboardingStateSchema,
  isNewAccount: z.boolean(),
});
export type OnboardingBootstrap = z.infer<typeof OnboardingBootstrapSchema>;

/** `PATCH /memory/:id` — a person's correction, recorded as told by them. */
export const UpdateMemoryBodySchema = z
  .object({ text: z.string().trim().min(1).max(300) })
  .strict();
export type UpdateMemoryBody = z.infer<typeof UpdateMemoryBodySchema>;
