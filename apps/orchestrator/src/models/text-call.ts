import { chat, type ContentPart } from '@tanstack/ai';
import type { ResolvedTextModel } from './model-resolution.service.js';

/** One image a background call shows the model, as bytes. */
export type TextCallImage = { readonly data: Uint8Array; readonly mimeType: string };

/**
 * One background model call that answers in text: a skill compile or
 * revision, a memory distillation. No tools, no history, no stream to a
 * client: a system prompt, one user message, and the reply.
 *
 * The adapter is the run engine's own (`resolveText`), so included models are
 * metered exactly as a chat run is. A provider failure is thrown as
 * the engine's run error, `code` included, which `normalizeModelError` reads.
 */
export async function askModelText(
  model: Pick<ResolvedTextModel, 'adapter'>,
  input: {
    readonly system: string;
    readonly prompt: string;
    readonly images?: readonly TextCallImage[];
    readonly signal?: AbortSignal;
  },
): Promise<string> {
  const images = input.images ?? [];
  const content: string | ContentPart[] =
    images.length === 0
      ? input.prompt
      : [
          { type: 'text', content: input.prompt },
          ...images.map((image): ContentPart => ({
            type: 'image',
            source: {
              type: 'data',
              mimeType: image.mimeType,
              value: Buffer.from(image.data).toString('base64'),
            },
          })),
        ];
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted === true) abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    return await chat({
      adapter: model.adapter,
      // The default library error logger prints unredacted provider transport objects.
      debug: false,
      systemPrompts: [input.system],
      messages: [{ role: 'user', content }],
      stream: false,
      abortController: controller,
    });
  } finally {
    input.signal?.removeEventListener('abort', abort);
  }
}
