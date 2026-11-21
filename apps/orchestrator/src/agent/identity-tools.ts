import { tool } from './tool-contract.js';
import { NativeToolInputs } from '@crewaid/shared';

import { AUTHORITY_BUILTIN } from './tool-registry.js';
import type { RegisteredTool, ToolContext } from './tool-registry.js';

/**
 * The one built-in that changes what a bot can reach.
 *
 * Every other tool does something now. This one records a grant that outlives
 * the turn: from here on this bot's seat opens on a shared Chrome profile
 * instead of its own, so a session somebody already signed into is simply
 * there. That is the whole feature — nothing is copied, no cookie is moved,
 * and it keeps working on sites that bind a session to the device.
 *
 * The gate is the ordinary one, on purpose
 *
 * The approval is M5-BE-08/09's, with no carve-out: the bot's own rule list
 * decides, defaulting to `ask`, and an operator whose rules say `* -> allow`
 * gets this tool allowed too. D-055 settled that shape for `shell` — §6/M5's
 * "always requires approval by default" is the MATCHER's default, "with the
 * rules on the bot, which is what lets an operator decide otherwise for their
 * own machine" — and a second, unbypassable class of approval invented here
 * would mean two answers to one question. D-057 records the consequence
 * plainly rather than leaving it to be discovered: a blanket allow is a
 * blanket grant.
 *
 * What the tool owes that decision is a description an operator can judge from
 * the prompt alone. The prompt renders the tool name and its arguments, so the
 * identity's name is the argument and it is the thing to read.
 */

/** What the model is told after a grant, in the terms it can act on. */
function report(result: { name: string; created: boolean; alreadyGranted: boolean }): string {
  const opening = result.created
    ? `Created new identity "${result.name}"; it starts signed out`
    : `Selected identity "${result.name}", which already exists on this computer`;
  return (
    `${opening}. Your previous seat was closed; the next browser tool requests this profile. ` +
    `Only one bot may hold it at a time. If another bot is using it, ask the person to open that ` +
    `bot's screen, hand control back, and choose Release shared login. ` +
    `If it needs a login, ask the person to sign in on the screen.`
  );
}

export function identityTools(): RegisteredTool[] {
  return [
    {
      name: 'use_identity',
      // `isolate` like the browser tools: a refused name is the model's most
      // likely mistake here and its most recoverable one, and a turn that
      // cannot share a login can still do the rest of its work.
      // The one act in the built-in set that reaches OUTSIDE the
      // sandbox as the user — it puts the bot on a browser seat holding the
      // operator's real session. Everything a bot does afterwards is done as
      // them, which is exactly the decision a person should make themselves.
      behavior: AUTHORITY_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Switch this bot to a shared, named browser identity so it can reuse a login a ' +
            'person has already signed into, instead of its own empty profile. Use it when a ' +
            'site needs an account that is not yours to create — "company-google", say. ' +
            'Closes your current browser window; the next browser tool opens one on the shared ' +
            'profile. Nothing is copied between profiles, so this is the only way to reach an ' +
            'existing session.',
          inputSchema: NativeToolInputs.use_identity,
          execute: async ({ identity }: { identity: string }) => {
            try {
              return report(await context.useIdentity(identity));
            } catch (error: unknown) {
              // A sentence, not a stack: the reasons a grant is refused —
              // a name that is a bot's own profile, a machine that is not
              // there yet — are all things the model can respond to.
              const detail = error instanceof Error ? error.message : String(error);
              return `Could not use identity "${identity}": ${detail}`;
            }
          },
        }),
    },
  ];
}
