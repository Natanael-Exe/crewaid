import { z } from 'zod';

/**
 * Asking a model for JSON without assuming the provider can constrain it.
 *
 * Why the schema travels in the prompt
 *
 * The obvious way to get a shaped answer is `generateObject`, and it works on
 * the built-in providers. It does NOT work on everything a connection can
 * point at: `generateObject`'s constraint is a `json_schema` response format,
 * which is a provider FEATURE — and nothing in a model's capability record
 * promises it. An OpenAI-compatible custom endpoint silently downgrades the
 * request to bare `json_object` mode, where the schema never reaches the
 * model: it answers valid JSON of whatever shape it guesses, the answer fails
 * validation, and the operation dies with a parse error no retry was ever
 * given — against the exact model chat uses happily one call earlier.
 *
 * So the shape is part of the QUESTION instead: the schema is rendered into
 * the prompt next to the instructions that describe it, the model is asked for
 * plain text, and parsing happens here — leniently, because "answer with only
 * JSON" is a strong request that models still answer wrapped in markdown
 * fences or a leading sentence. The caller's zod schema remains the sole
 * judge of whether what came back is usable, which keeps the transport and
 * the verdict separate.
 */

/** The prompt block that tells the model what shape to answer with. */
export function answerInstructions(schema: z.ZodType): string {
  return [
    'Answer with ONLY a JSON object — no prose before or after it, no markdown',
    'fences around it — matching exactly this JSON Schema:',
    '',
    JSON.stringify(z.toJSONSchema(schema), null, 2),
  ].join('\n');
}

/** Either the JSON object a reply contained, or a sentence saying why not. */
export type ParsedAnswer =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly problem: string };

/**
 * Extract the outermost JSON object from a model's reply.
 *
 * "Answer with ONLY a JSON object" is followed to the letter by some models
 * and loosely by the rest: the reply may be the bare object, a fenced block,
 * or one or two sentences around the object. All three carry the same answer,
 * so all three parse — while a reply with no object in it at all is a defect,
 * not a crash, so the caller can send it back through the corrective retry.
 *
 * The extraction is deliberately span-based (`first {` to `last }`) rather
 * than a second grammar: the object's own string fields — a skill's script,
 * most of all — are full of braces, and only the outermost span can contain
 * them. A reply that buries the object in prose with braces of its own is
 * unreadable by this rule and reports as such; that is one corrective retry,
 * not a wrong skill.
 */
export function parseJsonAnswer(text: string): ParsedAnswer {
  const reply = text.trim();
  const direct = tryParseObject(reply);
  if (direct !== undefined) return { ok: true, value: direct };

  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const extracted = tryParseObject(reply.slice(start, end + 1));
    if (extracted !== undefined) return { ok: true, value: extracted };
  }
  return { ok: false, problem: 'the reply contained no readable JSON object' };
}

/** `JSON.parse` narrowed to "got an object or nothing": `undefined` means the text parsed to a non-object or not at all. */
function tryParseObject(text: string): object | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}
