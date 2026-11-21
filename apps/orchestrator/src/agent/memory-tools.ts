import { tool } from './tool-contract.js';
import { NativeToolInputs } from '@crewaid/shared';
import type { z } from 'zod';

import { CONTAINED_BUILTIN, OBSERVING_BUILTIN } from './tool-registry.js';
import type { RegisteredTool, ToolContext } from './tool-registry.js';
import {
  MEMORY_FACT_MAX_CHARS,
  MEMORY_TOTAL_MAX_CHARS,
  type MemoryService,
} from '../memory/memory.service.js';

/**
 * What one search may spend.
 *
 * The registry's 100 KiB MODEL_RESULT_MAX_BYTES still applies as a backstop;
 * this is the tighter bound a search needs for its own reasons. A result that
 * fills the context is one the model then has to work around, and the point
 * of searching rather than reading everything is to spend less.
 */
const SEARCH_MAX_FACTS = 8;
const SEARCH_MAX_EXCERPTS = 5;
const SEARCH_MAX_CHARS = 4_000;
import { renderEntry } from '../memory/memory-select.js';

/**
 * M5-BE-21, moved to Postgres by CC-31 / D-073.
 *
 * What changed, and what did not
 *
 * D-069 put these three tools over `/home/bot/shared/MEMORY.md`. The problem
 * they solve is unchanged and is still trimming: an invariant held only in the
 * history being summarised away becomes a correctness bug the moment it goes.
 * What changed is that a file on one machine cannot BE the memory the product
 * asked for — it is per-machine, so it expresses neither the user-global
 * memory a new bot starts with nor a bot's own — and it sat on a volume the
 * retention reaper exists to delete.
 *
 * The bound (16,000 characters) and the duplicate handling survive
 * unchanged, because the reasoning behind them never depended on storage.
 *
 * These tools can no longer start a machine
 *
 * Every one of them used to reach `shared-document.ts` -> `context.session`
 * -> `computerHandle.ensure`, so reading the memory could wake a 2 GiB
 * desktop. That cost is what D-069 cited for NOT injecting memory at turn
 * start, and it is now gone rather than re-balanced: a Postgres read wakes
 * nothing. D-069 named that exit itself — "if trimming still loses invariants
 * in real use, injection is the next move" — and CC-32 takes it.
 */

type RememberInput = z.output<typeof NativeToolInputs.remember>;

function kindOf(value: RememberInput['kind']) {
  return value.toUpperCase() as
    'PREFERENCE' | 'CONVENTION' | 'FACT' | 'DECISION' | 'TASK_STATE' | 'RESOURCE';
}

/** Sections, because "what everyone knows" and "what I know" are different claims.
 * A shared row carries its author's name when one is known — the label that
 * stops a bot reading a teammate's work as its own. */
function renderMemory(
  rows: readonly { botId: string | null; text: string; authorBotId?: string | null }[],
  authorNames?: ReadonlyMap<string, string>,
): string {
  const global = rows.filter((r) => r.botId === null);
  const own = rows.filter((r) => r.botId !== null);
  const parts: string[] = [];
  if (global.length > 0)
    parts.push(
      `Shared with your other bots:\n${global.map((r) => renderEntry(r, authorNames)).join('')}`,
    );
  if (own.length > 0) parts.push(`Yours alone:\n${own.map((r) => renderEntry(r)).join('')}`);
  return parts.join('\n');
}

export function memoryTools(memories: MemoryService): RegisteredTool[] {
  return [
    {
      name: 'memory_read',
      behavior: OBSERVING_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Read your durable memory — facts that outlive this conversation. Includes what is ' +
            'shared with the other bots on your account and what is yours alone. Read it when ' +
            'you need something established before this conversation started, or that you may ' +
            'have been told long enough ago to have been trimmed from your context.',
          inputSchema: NativeToolInputs.memory_read,
          execute: async () => {
            const rows = await memories.liveFor(context.userId, context.botId);
            if (rows.length === 0) {
              // One answer for absent and empty, because they mean the same
              // thing to a model: nothing has been remembered yet. A "failed"
              // here would make a bot stop rather than start.
              return 'Nothing has been remembered yet. remember() starts it.';
            }
            const authorNames = await memories.namesFor(
              context.userId,
              rows
                .filter((row) => row.botId === null && row.authorBotId != null)
                .map((row) => row.authorBotId!),
            );
            const text = renderMemory(rows, authorNames);
            if (text.length <= MEMORY_TOTAL_MAX_CHARS) return text;
            return (
              `${text.slice(0, MEMORY_TOTAL_MAX_CHARS)}\n\n` +
              '[truncated — the memory is larger than one read. Use memory_search to find ' +
              'something specific.]'
            );
          },
        }),
    },
    {
      name: 'remember',
      behavior: CONTAINED_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Write one durable fact to your memory. Use it for what stays true — a convention, ' +
            'a preference, where something lives, what a name refers to. Not for what merely ' +
            'happened in this conversation: the transcript has that. One fact per call, stated ' +
            'so a bot with no other context could act on it.',
          inputSchema: NativeToolInputs.remember,
          execute: async (
            {
              fact,
              kind,
              scope,
              detail,
            }: {
              fact: string;
              kind: RememberInput['kind'];
              scope: RememberInput['scope'];
              detail: string;
            },
            options,
          ) => {
            const claim = fact.trim();
            if (claim === '') return 'remember refused: a fact is required';
            if (claim.length > MEMORY_FACT_MAX_CHARS) {
              return (
                `remember refused: ${claim.length} characters, over the ` +
                `${MEMORY_FACT_MAX_CHARS} limit. That is a paragraph rather than a fact — split ` +
                'it into separate claims and remember each one.'
              );
            }

            const botId = scope === 'mine' ? context.botId : null;

            // An unconfirmed guess the user then states out loud
            // becomes a fact, rather than a second row beside it.
            //
            // Before this, `remember` looked at ACTIVE rows only, so saying
            // "remember X" when X existed as a CANDIDATE created a DUPLICATE:
            // the guess stayed unconfirmed and invisible to injection, and the
            // new row carried none of its provenance. The user's confirmation
            // is exactly the evidence the candidate was waiting for.
            const candidate = await memories.findEquivalent(context.userId, botId, claim, [
              'CANDIDATE',
            ]);
            if (candidate !== null) {
              await memories.promote(candidate.id);
              return `Remembered: ${candidate.text}`;
            }

            const existing = await memories.findEquivalent(context.userId, botId, claim);
            if (existing !== null) {
              // Answered as a success, because it IS one — the fact is
              // remembered — and a refusal would make the model try to write
              // it another way. The confirmation count is the ranking signal
              // this produces, where it is a TIEBREAK and never the
              // first thing compared.
              await memories.confirm(existing.id);
              return `Already remembered: ${existing.text}`;
            }

            const used = await memories.totalCharsFor(context.userId, context.botId);
            if (used + claim.length + 3 > MEMORY_TOTAL_MAX_CHARS) {
              // Consolidate rather than refuse or silently drop. A memory at
              // capacity usually holds several near-duplicates that one
              // sentence would replace, and the model is the thing that can
              // tell which.
              return (
                `remember refused: the memory is full (${used} of ${MEMORY_TOTAL_MAX_CHARS} ` +
                'characters). Read it with memory_read, forget the entries that have stopped ' +
                'being true or that several newer facts already cover, and try again.'
              );
            }

            // A tombstone deliberately does NOT block this. The user erasing
            // a fact stops it being re-derived automatically; it does not
            // forbid them from establishing it again on purpose.
            await memories.write({
              userId: context.userId,
              botId,
              // The establishing bot, for both scopes: a private row's author
              // is already its `botId`, but writing it unconditionally keeps
              // the author a property of the WRITE rather than of the scope.
              authorBotId: context.botId,
              kind: kindOf(kind),
              text: claim,
              detail: detail.trim() === '' ? undefined : detail.trim(),
              // What established this fact: the reply being composed,
              // or the result row of this remember call.
              messageId: await context.attachmentHost(options.toolCallId),
            });
            return `Remembered: ${claim}`;
          },
        }),
    },
    {
      name: 'memory_search',
      behavior: OBSERVING_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Search what you know and what you have discussed. Covers your durable memory and ' +
            'your own past conversations with this user, including things nobody wrote down as a ' +
            'fact. Use it when you need something specific from earlier — a decision and why it ' +
            'was made, a name, where something lives — rather than reading the whole memory.',
          inputSchema: NativeToolInputs.memory_search,
          execute: async ({ query }: { query: string }) => {
            const text = query.trim();
            if (text === '') return 'memory_search refused: a query is required';

            const [facts, transcript] = await Promise.all([
              memories.search(context.userId, context.botId, text, SEARCH_MAX_FACTS),
              memories.searchTranscript(context.userId, context.botId, text, SEARCH_MAX_EXCERPTS),
            ]);

            if (facts.length === 0 && transcript.length === 0) {
              // A sentence, not an empty string. A bare empty result reads to
              // a model as a failure and it retries with a reworded query,
              // which costs another round trip to learn the same thing.
              return `Nothing in your memory or past conversations matches “${text}”.`;
            }

            const sections: string[] = [];
            if (facts.length > 0) {
              // Names first, so a shared fact is met WITH its author rather
              // than as an unattributed claim — the same gap the injected
              // block closes. Search is where a model fishes for what a
              // teammate did; an unattributed hit there is the same résumé
              // theft the injection block's prefix exists to stop.
              const authorNames = await memories.namesFor(
                context.userId,
                facts
                  .filter((f) => f.botId === null && f.authorBotId != null)
                  .map((f) => f.authorBotId!),
              );
              sections.push(
                `Remembered:\n${facts
                  .map((f) => {
                    // Two different warnings, for two different weaknesses.
                    // CANDIDATE: searchable and never injected, so a model
                    // meeting one here has to be told it is unconfirmed —
                    // otherwise the asymmetry that makes automatic extraction
                    // safe is invisible at the one moment it matters.
                    // OBSERVED: read off a page or a tool result, so
                    // it is REPORTABLE and never adoptable. Search is where a
                    // model meets one, and an unattributed line read off a web
                    // page is indistinguishable from something the user said.
                    // The origin travels with the claim or the claim does not
                    // travel.
                    const marks: string[] = [];
                    if (f.status === 'CANDIDATE') marks.push('unconfirmed');
                    if (f.source === 'OBSERVED') {
                      marks.push(
                        f.sourceRef === null || f.sourceRef === ''
                          ? 'read from an external source, not established'
                          : `read from ${f.sourceRef}, not established`,
                      );
                    }
                    const mark = marks.length === 0 ? '' : ` (${marks.join('; ')})`;
                    const from =
                      f.botId === null && f.authorBotId != null
                        ? `[from ${authorNames.get(f.authorBotId) ?? 'a teammate'}] `
                        : '';
                    return `- ${from}${f.text}${mark}`;
                  })
                  .join('\n')}`,
              );
            }
            if (transcript.length > 0) {
              sections.push(
                `From earlier conversations:\n${transcript
                  .map((t) => {
                    const who = t.author === 'USER' ? 'the user' : 'you';
                    const when = t.createdAt.toISOString().slice(0, 10);
                    return `- ${when}, ${who}: ${t.excerpt.replace(/\s+/g, ' ').trim()}`;
                  })
                  .join('\n')}`,
              );
            }

            const rendered = sections.join('\n\n');
            if (rendered.length <= SEARCH_MAX_CHARS) return rendered;
            return `${rendered.slice(0, SEARCH_MAX_CHARS)}\n\n[truncated — narrow the query.]`;
          },
        }),
    },
    {
      name: 'forget',
      behavior: CONTAINED_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Remove one fact from your memory, for when it has stopped being true. Pass the ' +
            'text exactly as memory_read returned it. To correct a fact, forget the old one and ' +
            'remember the new one.',
          inputSchema: NativeToolInputs.forget,
          execute: async ({ fact }: { fact: string }) => {
            const claim = fact.trim();
            if (claim === '') return 'forget refused: the fact to remove is required';

            // CANDIDATE included: this guard runs BEFORE the match, so an
            // ACTIVE-only read makes `forget` claim the memory is empty while
            // memory_search is returning the very row being dismissed.
            const rows = await memories.liveFor(context.userId, context.botId, [
              'ACTIVE',
              'CANDIDATE',
            ]);
            if (rows.length === 0) return 'Nothing has been remembered yet.';

            const matches = await memories.matching(context.userId, context.botId, claim);
            if (matches.length === 0) {
              return (
                'forget failed: that is not in the memory. It may have been changed or already ' +
                'removed — call memory_read and try again.'
              );
            }
            if (matches.length > 1) {
              return (
                'forget failed: that matches more than one fact. Pass more of it so it matches ' +
                'exactly one.'
              );
            }

            const target = matches[0];
            if (target === undefined)
              return 'forget failed: the memory moved; try memory_read again.';
            await memories.forget(context.userId, target);
            return `Forgotten: ${target.text}`;
          },
        }),
    },
  ];
}
