import { tool } from './tool-contract.js';
import { NativeToolInputs } from '@crewaid/shared';

import { SEAT_BUILTIN, OBSERVING_BUILTIN } from './tool-registry.js';
import type { RegisteredTool, ToolContext } from './tool-registry.js';

/**
 * The four browser built-ins.
 *
 * They take the page from the TURN's context rather than holding one, and
 * they take it inside `execute` rather than when they are built. That is what
 * keeps M5-BE-14's promise: registering these four costs nothing, a turn that
 * only answers never calls `context.browser()`, and no desktop is started for
 * a bot that was asked a question.
 *
 * Why these four and not a browser api
 *
 * The model is choosing actions from a page description, so every tool has to
 * be answerable from what `read()` returned. Navigate, read, click, type is
 * the smallest set that closes that loop. Anything wider — evaluate
 * arbitrary JS, read raw HTML — either hands the sandbox a way to run code
 * the orchestrator never sees (§7.3, and `no-eval` is lint-enforced on this
 * side of the boundary for the same reason) or spends the context window on
 * markup the model cannot act on.
 *
 * Failures are results, not exceptions
 *
 * §6/M5's rule for a denial is that it "returns a tool result the model can
 * react to, not an exception", and MCP plugins is that "one broken plugin must
 * never fail a turn". A selector that matches nothing is the model's most
 * common mistake and its most recoverable one: told plainly, it reads the
 * page again and picks another. So these catch and return text. The AI SDK
 * would also turn a throw into a `tool-error` part and keep looping, but that
 * result is shaped for a developer reading a stack, not for a model choosing
 * its next step.
 */

/** The message a tool gives the model when it could not do the thing. */
function failure(action: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${action} failed: ${detail}`;
}

export function browserTools(): RegisteredTool[] {
  return [
    {
      name: 'browser_navigate',
      behavior: SEAT_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Open a URL in the bot browser and wait for it to load. Returns the URL landed on; ' +
            'call browser_read afterwards to see the page.',
          inputSchema: NativeToolInputs.browser_navigate,
          execute: async ({ url }: { url: string }, options) => {
            // Validated here rather than in the schema so the model is TOLD what
            // was wrong and can fix it, instead of the SDK rejecting the call
            // with a schema error it did not see coming.
            let parsed: URL;
            try {
              parsed = new URL(url);
            } catch {
              return failure(
                'navigate',
                new Error(`${JSON.stringify(url)} is not an absolute URL`),
              );
            }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              return failure('navigate', new Error(`${parsed.protocol} is not a browsable scheme`));
            }
            try {
              const landed = await (
                await context.browser()
              ).navigate(parsed.toString(), options.abortSignal);
              return `navigated to ${landed.url}`;
            } catch (error) {
              return failure('navigate', error);
            }
          },
        }),
    },
    {
      name: 'browser_read',
      behavior: OBSERVING_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Read the current page as its accessibility tree — roles and names, not HTML. ' +
            'Copy a [ref=...] reference from this snapshot for browser_click and browser_type.',
          inputSchema: NativeToolInputs.browser_read,
          execute: async (_input, options) => {
            try {
              const observed = context.seat?.beginObservation();
              const text = await (await context.browser()).read(options.abortSignal);
              observed?.();
              return text === '' ? 'the page is empty' : text;
            } catch (error) {
              return failure('read', error);
            }
          },
        }),
    },
    {
      name: 'browser_click',
      behavior: SEAT_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description: 'Click an observed element reference from the latest browser_read snapshot.',
          inputSchema: NativeToolInputs.browser_click,
          execute: async ({ reference }: { reference: string }, options) => {
            try {
              await (await context.browser()).click(reference, options.abortSignal);
              return `clicked ${reference}`;
            } catch (error) {
              return failure('click', error);
            }
          },
        }),
    },
    {
      name: 'browser_type',
      behavior: SEAT_BUILTIN,
      build: (context: ToolContext) =>
        tool({
          description:
            'Fill an editable element reference from the latest browser_read snapshot. ' +
            'Does not submit; click the submit control afterwards.',
          inputSchema: NativeToolInputs.browser_type,
          execute: async ({ reference, text }: { reference: string; text: string }, options) => {
            try {
              await (await context.browser()).type(reference, text, options.abortSignal);
              // The text is NOT echoed: it can be a password the operator typed
              // into a form the bot is filling, and a tool result is persisted
              // verbatim into the transcript.
              return `typed ${text.length} characters into ${reference}`;
            } catch (error) {
              return failure('type', error);
            }
          },
        }),
    },
  ];
}
