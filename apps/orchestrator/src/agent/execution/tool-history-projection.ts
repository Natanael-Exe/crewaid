import type { ContentPart, ModelMessage } from '@tanstack/ai';
import { z } from 'zod';
import { JsonSchema } from '@crewaid/shared';
import type { ModelToolOutput, ToolSet } from '../tool-contract.js';

const FileSchema = z.object({
  type: z.literal('file'),
  data: z.object({ type: z.literal('data'), data: z.string() }),
  mediaType: z.string(),
});

function modelContent(projected: ModelToolOutput): string | ContentPart[] {
  switch (projected.type) {
    case 'text':
    case 'error-text':
      return projected.value;
    case 'json':
    case 'error-json':
      return JSON.stringify(projected.value);
    case 'execution-denied':
      return projected.reason ?? 'POLICY_DENIED: no action was dispatched.';
    case 'content':
      return projected.value.map((part) => {
        if (part.type === 'text') return { type: 'text', content: part.text };
        const file = FileSchema.parse(part);
        if (!file.mediaType.startsWith('image/')) throw new Error('Unsupported model tool media.');
        return {
          type: 'image',
          source: { type: 'data', mimeType: file.mediaType, value: file.data.data },
        };
      });
  }
}

/** Copy at provider input only. The engine/persistence still hold full tool results. */
export async function projectToolHistory(
  messages: readonly ModelMessage[],
  tools: ToolSet,
): Promise<ModelMessage[]> {
  const calls = new Map<string, { name: string; input: unknown }>();
  const projected = await Promise.all(
    messages.map(async (message) => {
      for (const call of message.toolCalls ?? []) {
        try {
          calls.set(call.id, {
            name: call.function.name,
            input: JSON.parse(call.function.arguments),
          });
        } catch {
          /* A malformed historical call cannot supply a valid projection input. */
        }
      }
      if (message.role !== 'tool' || message.toolCallId === undefined) return { ...message };
      const call = calls.get(message.toolCallId);
      const project = call === undefined ? undefined : tools[call.name]?.toModelOutput;
      if (call === undefined || project === undefined || typeof message.content !== 'string')
        return { ...message };
      let output: unknown = message.content;
      try {
        output = JsonSchema.parse(JSON.parse(message.content));
      } catch {
        /* Text tool outputs remain text, including stable dispatch refusals. */
      }
      try {
        return {
          ...message,
          content: modelContent(
            await project({ toolCallId: message.toolCallId, input: call.input, output }),
          ),
        };
      } catch {
        // A projection error must not replay an action or send unbounded/raw media to a provider.
        return {
          ...message,
          content: 'TOOL_OUTPUT_UNAVAILABLE: the result cannot be projected for the model.',
        };
      }
    }),
  );
  return stubOlderScreenshots(
    projected,
    new Set(
      [...calls]
        .filter(([, call]) => call.name === 'capture_screen' || call.name === 'screenshot')
        .map(([id]) => id),
    ),
  );
}

/**
 * One screenshot is context; six are most of a computer-use call's cost.
 *
 * A turn that works a screen takes a picture every step, and each later call
 * re-sends every recent one — a run that scrolled through a landing page
 * carried tens of thousands of tokens per step and died to provider timeouts
 * no faster model could have avoided. The NEWEST screenshot stays verbatim (it
 * is what the next action targets); older ones become a note telling the model
 * how to see the screen again. The canonical rows keep every image; this is
 * the provider's copy only, the same boundary `clearToolResults` works behind.
 */
const SCREENSHOT_STUB =
  '[an earlier screenshot was removed to save context — take a new screenshot if you need to see the screen now]';

export function stubOlderScreenshots(
  messages: readonly ModelMessage[],
  screenshotCalls?: ReadonlySet<string>,
): ModelMessage[] {
  const isScreenshot = (message: ModelMessage) =>
    screenshotCalls === undefined ||
    (message.toolCallId !== undefined && screenshotCalls.has(message.toolCallId));
  let newestImage = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message === undefined || message.role !== 'tool' || !isScreenshot(message)) continue;
    if (Array.isArray(message.content) && message.content.some((part) => part.type === 'image'))
      newestImage = index;
  }
  if (newestImage < 0) return [...messages];
  return messages.map((message, index) => {
    if (
      index === newestImage ||
      message.role !== 'tool' ||
      !isScreenshot(message) ||
      !Array.isArray(message.content)
    )
      return message;
    if (!message.content.some((part) => part.type === 'image')) return message;
    return {
      ...message,
      content: message.content.map((part): ContentPart =>
        part.type === 'image' ? { type: 'text', content: SCREENSHOT_STUB } : part,
      ),
    };
  });
}
