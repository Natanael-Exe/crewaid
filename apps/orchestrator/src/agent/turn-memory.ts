import type { MemoryService, MemorySearchHit } from '../memory/memory.service.js';
import { renderBlock, selectForInjection } from '../memory/memory-select.js';

/**
 * How well a memory must match the user's message before it is volunteered.
 *
 * `ts_rank_cd` on a short factual sentence scores a genuine hit well above
 * this; an incidental shared stopword scores below it. The floor is what keeps
 * "are you there?" from dragging in whatever happens to contain "there" — a
 * memory that answers questions nobody asked reads as a non-sequitur and spends
 * budget that the standing half needed.
 */
export const MEMORY_TRIGGER_RANK_FLOOR = 0.02;

/** What building the block reads. A narrow port, so this tests without Nest. */
export type MemoryReader = Pick<MemoryService, 'candidatesForInjection' | 'search' | 'namesFor'>;

/**
 * What this bot already knows, as one block of text.
 *
 * Sits beside `conversationSeed` and is called from the same place for the
 * same reason: it is a bounded, container-free Prisma read that must happen
 * before the draft reply exists. D-069 refused this on cost — reading the
 * memory meant waking a 2 GiB desktop — and CC-31 removed that cost
 * entirely, which is what makes a per-turn read affordable.
 *
 * TWO PARTS, and the second is the one that matters most.
 *
 * 1. STANDING. The highest-authority live memories, ordered by D-074 and
 * bounded by characters.
 * 2. TRIGGERED. A full-text search on the user's OWN message. This is the
 * answer to the admitted cost — "a bot whose memory of a convention
 * was trimmed is exactly the one that does not know there is anything
 * to look for" — because the case that matters most is the one where
 * the user just mentioned the thing. Behind a rank floor, so "are you
 * there?" retrieves nothing.
 *
 * Returns `undefined` rather than an empty string when there is nothing, so
 * `agentInstructions` appends no heading for a section with no content.
 */
export async function buildMemoryBlock(
  memories: MemoryReader,
  budgetChars: number,
  input: { readonly userId: string; readonly botId: string; readonly triggerContent: string },
): Promise<string | undefined> {
  const { userId, botId, triggerContent } = input;
  if (budgetChars === 0) return undefined;

  const candidates = await memories.candidatesForInjection(userId, botId);

  // Teammate names BEFORE selection: the `[from NAME]` prefix a shared row
  // renders with is part of that row's cost, so the selector must price it
  // with the same map the renderer uses — a budget that ignored the prefix
  // would be spent twice by the time the block is rendered.
  const authorNames = new Map<string, string>();
  await mergeAuthorNames(memories, userId, authorNames, candidates);

  const { selected, droppedCount } = selectForInjection(candidates, {
    botId,
    budgetChars,
    now: new Date(),
    authorNames,
  });

  const chosen = new Set(selected.map((m) => m.id));
  const used = renderBlock(selected, authorNames).length;

  // The triggered half gets whatever the standing half did not spend, up to
  // its own share. It is additive rather than competing: a fact the user
  // just referred to should not evict a standing convention.
  const triggered: MemorySearchHit[] = [];
  let spare = Math.max(0, budgetChars - used);
  if (spare > 0 && triggerContent.trim() !== '') {
    const hits = await memories.search(userId, botId, triggerContent, 3);
    await mergeAuthorNames(memories, userId, authorNames, hits);
    for (const hit of hits) {
      if (chosen.has(hit.id)) continue;
      if (hit.rank < MEMORY_TRIGGER_RANK_FLOOR) continue;
      const cost = renderBlock([hit], authorNames).length;
      if (cost > spare) continue;
      triggered.push(hit);
      spare -= cost;
    }
  }

  if (selected.length === 0 && triggered.length === 0) return undefined;

  // Delimited, because a memory is a RECORD and the model
  // has to be able to tell where the record stops. The instructions say what
  // the delimiter means; repeating that here would pay for the sentence on
  // every step instead of once in the cacheable prefix.
  const lines: string[] = ['What you already know:', '<memory>'];
  if (selected.length > 0) lines.push(renderBlock(selected, authorNames).trimEnd());
  if (triggered.length > 0) {
    lines.push(
      `Possibly relevant to what was just said:\n${renderBlock(triggered, authorNames).trimEnd()}`,
    );
  }
  lines.push('</memory>');
  if (droppedCount > 0) {
    // Say that this is a SUBSET. A model shown part of a memory with no
    // sign that there is more will answer as though it has seen all of it.
    //
    // OUTSIDE the delimiter: this sentence is the orchestrator speaking, and
    // putting it inside would make one line of the record something no user
    // and no bot ever wrote.
    lines.push(
      `(${droppedCount} more not shown — use memory_read for all of it, or memory_search to look something up.)`,
    );
  }
  return lines.join('\n\n');
}

/**
 * Resolve teammate names for shared rows into `names`, in place.
 *
 * Only the ids not already resolved are queried, because a triggered hit
 * usually names an author the standing candidates already covered — and a
 * second query for a name already held would be the same bytes paid twice.
 * A name that comes back empty (a bot deleted after it wrote a fact) stays
 * missing, and the renderer's "a teammate" fallback is what that renders.
 */
async function mergeAuthorNames(
  memories: MemoryReader,
  userId: string,
  names: Map<string, string>,
  rows: readonly { readonly botId: string | null; readonly authorBotId?: string | null }[],
): Promise<void> {
  const missing = rows
    .filter((row) => row.botId === null && row.authorBotId != null && !names.has(row.authorBotId))
    .map((row) => row.authorBotId!);
  if (missing.length === 0) return;
  for (const [id, name] of await memories.namesFor(userId, missing)) {
    names.set(id, name);
  }
}
