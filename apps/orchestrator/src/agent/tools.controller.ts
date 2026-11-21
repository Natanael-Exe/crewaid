import { Controller, Get, Inject } from '@nestjs/common';
import { ListToolsResponseSchema, type Principal, type ToolInfo } from '@crewaid/shared';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { ToolContext } from './tool-registry.js';
import { ToolRegistry, toolReach } from './tool-registry.js';
import { vocabularyFor } from './tool-vocabulary.js';

/**
 * `GET /tools` — the tool directory, for the composer's `/` palette.
 *
 * The registry is the single source of truth, and this route reads it rather
 * than maintaining a second list: a tool registered anywhere (built-ins here,
 * `run_skill`/`attach_file` from the skills module, `send_message` from
 * interbot) appears, with the description the MODEL itself is given and the
 * reach classification the approval matcher acts on. An operator picking a
 * tool from the palette is reading the same contract the turn will run —
 * which is also why `reach` is surfaced: "asks approval" is the one fact a
 * description is not obliged to state and the operator most wants to know.
 *
 * An MCP tool is NOT here, and that is not an omission. It is
 * never registered: it belongs to one user's server, changes when that server
 * is re-listed, and is resolved per turn from the bot's enabled plugins. This
 * route takes no bot and no server, so there is nothing it could resolve —
 * a per-bot plugin surface is `GET /bots/:id/plugins`, and listing a
 * bot's MCP tools here would mean answering a bot-scoped question on a route
 * that was not asked one.
 *
 * Building a definition is free (M5-BE-14: schemas and a closure — nothing
 * turns a desktop on until a tool EXECUTES), so the description is read off a
 * throwaway build against a stub context. The context's accessors are thunks
 * that only run when a tool is called; a build that reached into one at
 * CONSTRUCTION time would already be a bug the runner's lazy-wiring rule
 * forbids.
 */
@Controller('tools')
export class ToolsController {
  constructor(@Inject(ToolRegistry) private readonly tools: ToolRegistry) {}

  @Get()
  list(@CurrentUser() _principal: Principal): ToolInfo[] {
    const infos: ToolInfo[] = [];
    for (const name of this.tools.names()) {
      const behavior = this.tools.behaviorOf(name);
      const description = descriptionOf(this.tools, name);
      const vocabulary = vocabularyFor(name, description);
      infos.push({
        name,
        alias: vocabulary.alias,
        label: vocabulary.label,
        summary: vocabulary.summary,
        description,
        reach: toolReach(behavior),
        origin: behavior.origin.kind,
      });
    }
    return ListToolsResponseSchema.parse(infos);
  }
}

/** The model-facing description of one registered tool, or a honest blank. */
function descriptionOf(tools: ToolRegistry, name: string): string {
  try {
    // A real ToolContext whose accessors refuse to run: the build must never
    // call one (M5-BE-14 — building is schemas and a closure), and if a tool
    // ever does, the rejection says so loudly rather than starting a desktop
    // behind a directory read.
    const context: ToolContext = {
      userId: '',
      botId: '',
      attachmentHost: () => Promise.reject(new Error('tool directory builds, it does not execute')),
      trigger: { id: '', chainId: null, hopCount: 0 },
      browser: () => Promise.reject(new Error('tool directory builds, it does not execute')),
      session: () => Promise.reject(new Error('tool directory builds, it does not execute')),
      useIdentity: () => Promise.reject(new Error('tool directory builds, it does not execute')),
    };
    const built = tools.toolSetFor(context)[name] as { description?: unknown } | undefined;
    return typeof built?.description === 'string' ? built.description : '';
  } catch {
    // A build that throws is a wiring bug this directory must not amplify —
    // the tool still lists, with whatever the registry can say without it.
    return '';
  }
}
