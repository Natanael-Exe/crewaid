import { tool } from './tool-contract.js';
import { NativeToolInputs } from '@crewaid/shared';

import type { CreateBotBody, UpdateBotBody } from '@crewaid/shared';

import { AUTHORITY_BUILTIN } from './tool-registry.js';
import type { RegisteredTool, ToolContext } from './tool-registry.js';

/**
 * The team-management built-ins: `create_bot`, `edit_bot`, `delete_bot`.
 *
 * §6/M5 registered no tools that act OUTSIDE the calling bot's own row —
 * every built-in so far touches the bot's own computer, memory or reply.
 * These three touch the TEAM: they create, reshape and remove the user's
 * other bots. That is exactly the power the operator has in the UI, handed to
 * the model so "set up a writer bot and brief it" is one sentence instead of
 * a form the operator fills in themselves.
 *
 * WHY ALL THREE ARE `sensitive`
 *
 * Not because the operations are dangerous to the machine — they are plain
 * row writes through `BotsService` — but because of what they DECIDE on the
 * user's behalf. A teammate created by a confused model is a persona the
 * operator never asked for; a deleted one is work and history gone with no
 * undo. Every call is therefore put in front of the operator (M5-BE-08's
 * matcher asks about every `sensitive` call unless a bot's own rules say
 * otherwise), which is the approval the feature was asked for. A model that
 * says what it is about to do in the same turn reads the prompt the operator
 * actually answers.
 *
 * `delete_bot` refuses the ONE target no approval can make safe: the calling
 * bot itself. Its own turn is running on the row a deletion would tear out —
 * and a bot that talks its operator into deleting it mid-turn leaves a
 * transcript nobody can answer again.
 *
 * Failures are results
 *
 * Same polarity as every built-in: an unknown bot id, a model this user does
 * not own, a deletion refused because a lifecycle is mid-flight — all come
 * back as sentences the model can read and act on, not exceptions.
 */

/** Where a created bot's colour comes from when the model does not pick one. */
const AVATAR_PALETTE = [
  '#e11d48',
  '#db2777',
  '#9333ea',
  '#7c3aed',
  '#2563eb',
  '#0891b2',
  '#059669',
  '#ca8a04',
] as const;

/**
 * A stable colour for a created bot, derived from its name — the same bot is
 * not a different colour every time a model proposes it, and a model that
 * omits the field gets a hue the palette owns rather than a random one.
 */
function colorFor(name: string): string {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + character.charCodeAt(0)) % 997;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length] ?? '#7c3aed';
}

/** The profile fields both creation and editing share. */

function failure(action: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${action} failed: ${detail}`;
}

export function botTools(deps: {
  bots: {
    create(userId: string, input: CreateBotBody): Promise<{ id: string; name: string }>;
    update(
      userId: string,
      botId: string,
      input: UpdateBotBody,
    ): Promise<{
      id: string;
      name: string;
    }>;
    remove(userId: string, botId: string): Promise<void>;
  };
}): RegisteredTool[] {
  return [
    {
      name: 'create_bot',
      behavior: AUTHORITY_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Create a new teammate bot on the user’s team — a name, a role and a character ' +
            'brief. This always needs the user’s approval, so say in your reply who you are ' +
            'creating and why. You cannot message the new bot yourself until it exists and has ' +
            'its own conversation.',
          inputSchema: NativeToolInputs.create_bot,
          execute: async (input: {
            name: string;
            role: string;
            systemPrompt: string;
            modelId?: string | undefined;
            avatarColor?: string | undefined;
          }) => {
            try {
              const created = await deps.bots.create(context.userId, {
                name: input.name,
                role: input.role,
                systemPrompt: input.systemPrompt,
                ...(input.modelId !== undefined && { modelId: input.modelId }),
                avatarColor: input.avatarColor ?? colorFor(input.name),
              });
              return `Created bot "${created.name}" (id ${created.id}). It belongs to the user now; they can open it and start talking to it.`;
            } catch (error) {
              return failure(`create_bot ${JSON.stringify(input.name)}`, error);
            }
          },
        }),
    },
    {
      name: 'edit_bot',
      behavior: AUTHORITY_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            "Edit one of the user's existing bots: rename it, change its role, rewrite its " +
            'character brief, point it at another model, or hide or pin it in their sidebar. ' +
            'This always needs the user’s approval, so say in your reply what you are changing ' +
            'and why.',
          inputSchema: NativeToolInputs.edit_bot,
          execute: async (input: {
            botId: string;
            name?: string | undefined;
            role?: string | undefined;
            systemPrompt?: string | undefined;
            modelId?: string | undefined;
            avatarColor?: string | undefined;
            pinned?: boolean | undefined;
            hiddenFromSidebar?: boolean | undefined;
          }) => {
            const { botId, ...changes } = input;
            if (Object.keys(changes).length === 0) {
              return 'edit_bot refused: give at least one field to change.';
            }
            try {
              const updated = await deps.bots.update(context.userId, botId, changes);
              return `Updated bot "${updated.name}" (${Object.keys(changes).join(', ')}).`;
            } catch (error) {
              return failure(`edit_bot ${JSON.stringify(botId)}`, error);
            }
          },
        }),
    },
    {
      name: 'delete_bot',
      behavior: AUTHORITY_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            "Permanently delete one of the user's bots — its profile, its conversations and " +
            'its history. There is no undo. This always needs the user’s approval, so say in ' +
            'your reply which bot you are deleting and why. You can never delete yourself.',
          inputSchema: NativeToolInputs.delete_bot,
          execute: async ({ botId }: { botId: string }) => {
            if (botId === context.botId) {
              return (
                'delete_bot refused: that is your own id. You cannot delete yourself — ' +
                'ask the user to remove you from the app if that is really what they want.'
              );
            }
            try {
              await deps.bots.remove(context.userId, botId);
              return `Deleted bot ${botId}. Its conversations and history are gone.`;
            } catch (error) {
              return failure(`delete_bot ${JSON.stringify(botId)}`, error);
            }
          },
        }),
    },
  ];
}
