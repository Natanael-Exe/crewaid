import { describe, expect, it } from 'vitest';
import { tool } from '../src/agent/tool-contract.js';
import { executionTurn } from './execution-turn-fake.js';
import { MockLanguageModelV4, simulateReadableStream } from './model-resolution-fake.js';
import type { ScriptPart as LanguageModelV4StreamPart } from './model-resolution-fake.js';
import { z } from 'zod';

import {
  MODEL_RESULT_MAX_BYTES,
  capToolOutput,
  withCappedOutput,
} from '../src/agent/tool-result-projection.js';
import { ToolRegistry, type RegisteredTool } from '../src/agent/tool-registry.js';

/**
 * M5-BE-12 — §6/M5's "tool results over 100 KB are truncated with an explicit
 * marker before reaching the model".
 *
 * Two properties are under test and they pull in opposite directions, which is
 * why both are here. The model must not receive more than the ceiling — that
 * is the acceptance criterion. And the ORCHESTRATOR must still receive
 * everything the tool returned, because the same value is persisted into
 * `Message.parts`, replayed by R9 and shown in the transcript: a test that
 * only asserted the first would pass against the mangling implementation this
 * task exists to replace, which is a cut inside `execute`.
 *
 * The second property is asserted the only way it can be — by checking that
 * `execute` still answers with the whole thing after the cap is in place.
 */

/** A string of `bytes` ASCII characters, so length and byte length agree. */
function ascii(bytes: number): string {
  return 'x'.repeat(bytes);
}

const OVER = MODEL_RESULT_MAX_BYTES + 5_000;

function bytesOf(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Run a definition's composed projection the way the SDK's step loop does. */
async function project(definition: ReturnType<typeof tool>, output: unknown): Promise<unknown> {
  const toModelOutput = (definition as { toModelOutput?: (o: unknown) => unknown }).toModelOutput;
  if (typeof toModelOutput !== 'function') throw new Error('no projection on this definition');
  return toModelOutput({ toolCallId: 'call-1', input: {}, output });
}

describe('M5-BE-12 the ceiling on what one tool result may spend', () => {
  it('leaves a result under the ceiling exactly as it was', () => {
    const output = { type: 'text', value: ascii(1_000) } as const;
    // Identity, not deep equality: an under-size result must not be rebuilt,
    // because the cheap path here runs on every tool call of every turn.
    expect(capToolOutput(output)).toBe(output);
  });

  it('cuts an oversize text result and says so in bytes', () => {
    const capped = capToolOutput({ type: 'text', value: ascii(OVER) });

    expect(capped.type).toBe('text');
    const value = (capped as { value: string }).value;
    expect(value.startsWith(ascii(1_000))).toBe(true);
    // The marker is additive, so the result is a little over the budget by
    // design — the ceiling bounds the OUTPUT, and a marker nobody can read
    // because it was itself truncated would defeat the point of having one.
    expect(value).toContain('truncated');
    expect(value).toContain(OVER.toLocaleString('en-US'));
    expect(value).toContain('do not treat this as the end of the output');
    expect(bytesOf(value)).toBeLessThan(MODEL_RESULT_MAX_BYTES + 500);
  });

  // A naive `Buffer.subarray().toString('utf8')` decodes a severed multi-byte
  // sequence to U+FFFD, putting a character in the model's input that was never
  // in the source. Whether that happens depends entirely on where the budget
  // falls relative to the character width, which is why this is a table: the
  // first version of this test used only 😀 and passed against an
  // implementation with the guard deleted, because MODEL_RESULT_MAX_BYTES is
  // 102,400 and 102,400 % 4 === 0 — the cut landed cleanly between emoji every
  // time and the case under test was never reached. Each row below is a width
  // and a budget that genuinely lands mid-sequence.
  const boundaries = [
    { name: 'three-byte at the real ceiling', character: '€', width: 3, budget: undefined },
    { name: 'four-byte at an odd budget', character: '😀', width: 4, budget: 10_001 },
    { name: 'two-byte at an odd budget', character: 'é', width: 2, budget: 4_097 },
  ] as const;

  for (const { name, character, width, budget } of boundaries) {
    it(`never splits a character in half — ${name}`, () => {
      const span = budget ?? MODEL_RESULT_MAX_BYTES;
      expect(span % width).not.toBe(0); // the row is only meaningful if it splits
      const value = character.repeat(Math.ceil((span + 5_000) / width));

      const capped = capToolOutput({ type: 'text', value }, budget);

      const text = (capped as { value: string }).value;
      const body = text.slice(0, text.indexOf('\n\n[truncated'));
      expect(body).not.toContain('�');
      expect([...body].every((one) => one === character)).toBe(true);
      // And the cut still respected the budget rather than rounding up past it.
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(span);
    });
  }

  it('keeps a U+FFFD that was genuinely in the source', () => {
    // The guard drops a replacement character the cut CREATED. One the tool
    // actually returned is data, and eating it would be the same class of
    // mistake in the other direction.
    const capped = capToolOutput({ type: 'text', value: `�${ascii(100)}` }, 50);

    const text = (capped as { value: string }).value;
    expect(text.startsWith('�')).toBe(true);
  });

  it('re-types an oversize JSON result to text rather than emitting broken JSON', () => {
    const capped = capToolOutput({ type: 'json', value: { log: ascii(OVER) } });

    // A JSON document cut in half is not a JSON document. Claiming `json` for
    // a broken fragment would be a lie about the shape to the one consumer
    // that might try to parse it.
    expect(capped.type).toBe('text');
    expect((capped as { value: string }).value).toContain('truncated');
    expect(() => JSON.parse((capped as { value: string }).value)).toThrow();
  });

  it('leaves a JSON result under the ceiling as JSON', () => {
    const output = { type: 'json', value: { ok: true, lines: 3 } } as const;
    expect(capToolOutput(output)).toBe(output);
  });

  it('keeps an error result an error when it has to re-type it', () => {
    // `text` and `error-text` are one string each to a provider that only
    // reads `value`, so the polarity looks cosmetic — but Anthropic sets
    // `is_error: true` on the two error variants and nothing on `text`. An
    // oversize error re-typed to `text` would report a tool call that FAILED
    // to the model as one that succeeded.
    const capped = capToolOutput({ type: 'error-json', value: { log: ascii(OVER) } });

    expect(capped.type).toBe('error-text');
    expect((capped as { value: string }).value).toContain('truncated');
  });

  it('leaves both error variants untouched while they fit', () => {
    const text = { type: 'error-text', value: ascii(1_000) } as const;
    const json = { type: 'error-json', value: { reason: 'no' } } as const;

    expect(capToolOutput(text)).toBe(text);
    expect(capToolOutput(json)).toBe(json);
  });

  it('passes through a variant it has no way to bound', () => {
    // `execution-denied` carries a reason the approval layer wrote, and an
    // unknown future variant is not this function's to reshape.
    const denied = { type: 'execution-denied', reason: 'auto-review rule 1 denies shell' } as const;

    expect(capToolOutput(denied)).toBe(denied);
  });

  it('caps the text of a content result and leaves a file part whole', () => {
    // `screenshot` is the live case: a PNG cut to 100 KB is not a smaller
    // picture, it is a corrupt one, so the image must survive untouched while
    // any prose beside it is bounded.
    const file = {
      type: 'file' as const,
      data: { type: 'data', data: 'AAAA' },
      mediaType: 'image/png',
    };
    const capped = capToolOutput({
      type: 'content',
      value: [{ type: 'text', text: ascii(OVER) }, file],
    });

    const items = (capped as { value: Array<Record<string, unknown>> }).value;
    expect(items).toHaveLength(2);
    expect(items[0]?.['text']).toContain('truncated');
    expect(items[1]).toBe(file);
  });

  it('spends one budget across every text item, not one budget each', () => {
    // Fifty items of 90 KB is 4.5 MB of context, and capping each one against
    // the full ceiling would wave all of it through.
    const capped = capToolOutput({
      type: 'content',
      value: Array.from({ length: 3 }, () => ({
        type: 'text' as const,
        text: ascii(MODEL_RESULT_MAX_BYTES - 1_000),
      })),
    });

    const items = (capped as { value: Array<{ text: string }> }).value;
    const total = items.reduce((sum, item) => sum + bytesOf(item.text), 0);
    expect(total).toBeLessThan(MODEL_RESULT_MAX_BYTES * 1.1);
    expect(items[2]?.text).toContain('truncated');
  });
});

describe('M5-BE-12 the seam: the model is capped, the orchestrator is not', () => {
  it('caps a tool that declares no projection of its own', async () => {
    const definition = tool({
      description: 'returns a great deal',
      inputSchema: z.object({}),
      execute: async () => ascii(OVER),
    });

    const capped = withCappedOutput(definition);
    const projected = (await project(capped, ascii(OVER))) as { type: string; value: string };

    expect(projected.type).toBe('text');
    expect(bytesOf(projected.value)).toBeLessThan(MODEL_RESULT_MAX_BYTES + 500);
  });

  it('still hands the orchestrator every byte the tool returned', async () => {
    // The property the mangling implementation cannot have. `execute` is what
    // the SDK persists into `Message.parts`; the cap must not reach it.
    const whole = ascii(OVER);
    const definition = tool({
      description: 'returns a great deal',
      inputSchema: z.object({}),
      execute: async () => whole,
    });

    const capped = withCappedOutput(definition);
    const executed = await (
      capped as { execute: (input: unknown, options: unknown) => Promise<string> }
    ).execute({}, {});

    expect(executed).toBe(whole);
    expect(bytesOf(executed)).toBe(OVER);
  });

  it('composes onto a tool that has its own projection instead of replacing it', async () => {
    // `screenshot` returns `{bytes, base64}` and projects an image part. If the
    // cap replaced the projection rather than wrapping it, the model would get
    // JSON with base64 in a string field — the defect M5-BE-05 fixed.
    const definition = tool({
      description: 'a picture',
      inputSchema: z.object({}),
      execute: async () => ({ bytes: 4, base64: 'AAAA' }),
      toModelOutput: ({ output }: { output: { base64: string } }) => ({
        type: 'content' as const,
        value: [
          {
            type: 'file' as const,
            data: { type: 'data' as const, data: output.base64 },
            mediaType: 'image/png',
          },
        ],
      }),
    });

    const projected = (await project(withCappedOutput(definition), {
      bytes: 4,
      base64: 'AAAA',
    })) as { type: string; value: Array<Record<string, unknown>> };

    expect(projected.type).toBe('content');
    expect(projected.value[0]?.['type']).toBe('file');
    expect(projected.value[0]?.['mediaType']).toBe('image/png');
  });

  it('maps a non-string result to JSON the way the SDK would', async () => {
    const definition = tool({
      description: 'structured',
      inputSchema: z.object({}),
      execute: async () => ({ exitCode: 0 }),
    });

    const projected = await project(withCappedOutput(definition), { exitCode: 0 });

    expect(projected).toEqual({ type: 'json', value: { exitCode: 0 } });
  });

  it('hands a result it cannot measure on rather than failing the projection', async () => {
    // `JSON.stringify` is how an oversize JSON result is measured, and it
    // refuses a BigInt (as it does a cycle, or a getter that throws) — the
    // one thing in the cap that can fail. A tool result is not a reason to
    // fail the turn that produced it, so an unmeasurable value reaches the
    // model exactly as the SDK would have sent it, and the failure, if there
    // is one, stays where it was before this cap existed.
    const definition = tool({
      description: 'a value JSON cannot carry',
      inputSchema: z.object({}),
      execute: async () => ({ id: BigInt(1) }),
    });

    await expect(project(withCappedOutput(definition), { id: BigInt(1) })).resolves.toEqual({
      type: 'json',
      value: { id: BigInt(1) },
    });
  });

  it('is the projection the SDK feeds the model, and only the model', async () => {
    // Every other case here calls `toModelOutput` directly, and that would
    // keep passing if the SDK stopped invoking it — the one way this seam can
    // rot quietly, and the reason D-059 names it as the trigger to revisit.
    // So this drives the real step loop with a mock provider and reads both
    // copies of one result: the one the second call's prompt carries, which
    // is the model's, and the one the run's transcript keeps.
    const whole = ascii(OVER);
    const usage = { inputTokens: { total: 3 }, outputTokens: { total: 2 } };
    const prompts: unknown[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({
      provider: 'mock-provider',
      modelId: 'mock-model',
      doStream: async (options: { prompt: unknown }) => {
        calls += 1;
        prompts.push(options.prompt);
        return {
          stream: simulateReadableStream({
            initialDelayInMs: 0,
            chunkDelayInMs: 0,
            chunks: (calls === 1
              ? [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'tool-call',
                    toolCallId: 'call-1',
                    toolName: 'huge',
                    input: JSON.stringify({}),
                  },
                  {
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                    usage,
                  },
                ]
              : [
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id: 't1' },
                  { type: 'text-delta', id: 't1', delta: 'done' },
                  { type: 'text-end', id: 't1' },
                  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
                ]) as LanguageModelV4StreamPart[],
          }),
        };
      },
    });

    // Through the registry, not around it: the wrapping `toolSetFor` does is
    // half of what is under test here.
    const registry = new ToolRegistry();
    registry.register({
      name: 'huge',
      behavior: {
        origin: { kind: 'builtin' },
        failure: { kind: 'isolate' },

        effect: 'draft',
        authority: false,
      },
      build: () =>
        tool({
          description: 'returns a great deal',
          inputSchema: z.object({}),
          execute: async () => whole,
        }),
    });

    const turn = executionTurn({ model, tools: registry.toolSetFor({} as never) });
    expect((await turn.execute()).status).toBe('completed');

    const sent = JSON.stringify(prompts[1]);
    expect(sent).not.toContain(whole);
    expect(sent).toContain('truncated');
    const thread = await turn.persistence.stores.messages.loadThread(turn.threadId);
    const kept = thread.find((message) => message.role === 'tool');
    expect(JSON.stringify(kept?.content)).toContain(whole);
  });

  it('applies to every tool the registry hands the turn, not only the ones that asked', async () => {
    // The reason the cap lives in the registry: M6 registers MCP tools whose
    // output shape is a third party's, and `run_skill` returns whatever a
    // compiled skill printed. Neither author has read this file.
    const registry = new ToolRegistry();
    const entry = (name: string): RegisteredTool => ({
      name,
      behavior: {
        origin: { kind: 'builtin' },
        failure: { kind: 'isolate' },

        effect: 'draft',
        authority: false,
      },
      build: () =>
        tool({
          description: name,
          inputSchema: z.object({}),
          execute: async () => ascii(OVER),
        }),
    });
    registry.register(entry('one'));
    registry.register(entry('two'));

    const set = registry.toolSetFor({} as never);

    for (const name of ['one', 'two']) {
      const projected = (await project(set[name] as ReturnType<typeof tool>, ascii(OVER))) as {
        value: string;
      };
      expect(bytesOf(projected.value)).toBeLessThan(MODEL_RESULT_MAX_BYTES + 500);
    }
  });
});
