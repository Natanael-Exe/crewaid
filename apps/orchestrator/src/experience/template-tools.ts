import { NativeToolInputs } from '@crewaid/shared';
import { tool } from '../agent/tool-contract.js';
import {
  AUTHORITY_BUILTIN,
  OBSERVING_BUILTIN,
  type RegisteredTool,
} from '../agent/tool-registry.js';
import type { TemplateService } from './template.service.js';

/** The chat half of Templates, over the same service the library uses. */
export function templateTools(templates: TemplateService): RegisteredTool[] {
  return [
    {
      name: 'search_templates',
      behavior: OBSERVING_BUILTIN,
      build: (context) =>
        tool({
          description:
            'Search the curated crew and specialist templates by goal, role, outcome or tool. An empty query lists them all. read_template has the full setup.',
          inputSchema: NativeToolInputs.search_templates,
          execute: ({ query }) =>
            templates.list(query ?? '', context.language ?? null).map((entry) => ({
              id: entry.id,
              revision: entry.revision,
              kind: entry.kind,
              title: entry.title,
              summary: entry.summary,
              members: entry.bots.map((bot) => `${bot.name} (${bot.role})`),
            })),
        }),
    },
    {
      name: 'read_template',
      behavior: OBSERVING_BUILTIN,
      build: (context) =>
        tool({
          description:
            "Read one template: its specialists, outcomes, inputs and supported tools, the user's actual connections, and earlier installs with their current member ids. The user sees it as a card they can open or set up. Installs nothing.",
          inputSchema: NativeToolInputs.read_template,
          execute: ({ templateId }) =>
            templates.readForUser(context.userId, templateId, context.language ?? null),
        }),
    },
    {
      name: 'install_template',
      behavior: AUTHORITY_BUILTIN,
      build: (context) =>
        tool({
          description:
            "Add a template with the goal, shared context and connection ids the user reviewed. A crew's members are created together, once; nothing starts and no routine is scheduled. Connecting a new account is the user's step, not this one.",
          inputSchema: NativeToolInputs.install_template,
          execute: async (input, options) => {
            try {
              const installed = await templates.install(
                context.userId,
                {
                  ...input,
                  // One tool call is one request: a replayed call returns its first result.
                  idempotencyKey: `${context.trigger.id}:${options.toolCallId}`,
                },
                context.language ?? null,
              );
              return {
                id: installed.id,
                templateId: installed.templateId,
                groupId: installed.groupId,
                botIds: installed.botIds,
                message:
                  'Added. Nothing has started. Hand off the first task only if the user asked for one.',
              };
            } catch (error) {
              return { error: error instanceof Error ? error.message : 'Setup failed. Try again.' };
            }
          },
        }),
    },
  ];
}
