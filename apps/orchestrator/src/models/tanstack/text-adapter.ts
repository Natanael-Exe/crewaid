import type { AnyTextAdapter } from '@tanstack/ai';
import { AnthropicTextAdapter } from '@tanstack/ai-anthropic';
import {
  OpenAIChatCompletionsTextAdapter,
  OpenAITextAdapter,
  type OpenAIChatModel,
} from '@tanstack/ai-openai';
import { OpenRouterTextAdapter } from '@tanstack/ai-openrouter';
import { z } from 'zod';
import { createGuardedFetch, type AddressResolver } from '../../providers/endpoint-guard.js';
import { ProviderConfigError, type ProviderBinding } from '../provider-factory.js';

/**
 * One connection, one TanStack text adapter: the TanStack half of
 * `buildLanguageModel`, with the same rules.
 *
 * - The key comes from the binding, which the owner-scoped vault decrypted
 * for this call. It is never read from the environment, and it lives in
 * the adapter's client only.
 * - A `custom` endpoint gets the guarded fetch: every request
 * re-resolves the host and refuses a private address or a redirect. The
 * built-ins keep the platform fetch, because their endpoints are the SDKs'
 * own constants, not user input.
 * - One adapter per resolved model per turn. Nothing here caches or chooses.
 */

/**
 * What a model id may look like. The adapters type a model as the ids their
 * release knew, but Crewaid's id is the user's catalog row, read at runtime:
 * a new model the provider serves must work before this package learns its
 * name. So the id is checked by shape here, and whether it exists is the
 * provider's to answer, as a D-006 error.
 */
export const UpstreamModelIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:/~@+-]+$/, 'not a model id');

export type TextAdapterDeps = {
  /** The resolver; tests pass one that answers without DNS. */
  readonly resolve?: AddressResolver | undefined;
  /**
   * Where a built-in provider's API is. Tests point it at a loopback stub;
   * production leaves it unset and gets each SDK's own constant.
   */
  readonly baseURL?: string | undefined;
  /** The fetch under the guard for `custom`; tests route it to a stub. */
  readonly fetch?: typeof fetch | undefined;
};

export type BuiltTextAdapter = {
  readonly adapter: AnyTextAdapter;
  /** The provider family, which decides how its usage is read (`usage.ts`). */
  readonly kind: Exclude<ProviderBinding['kind'], 'crewaid' | 'elevenlabs'>;
};

export function buildTextAdapter(
  binding: ProviderBinding,
  deps: TextAdapterDeps = {},
): BuiltTextAdapter {
  const parsed = UpstreamModelIdSchema.safeParse(binding.upstreamModelId);
  if (!parsed.success) {
    throw new ProviderConfigError(`"${binding.upstreamModelId}" is not a model id`);
  }
  const model = parsed.data;
  const baseURL = deps.baseURL === undefined ? {} : { baseURL: deps.baseURL };

  switch (binding.kind) {
    case 'openai':
      // Uses the Responses API so o-series reasoning tokens are returned.
      return {
        kind: 'openai',
        adapter: new OpenAITextAdapter({ apiKey: binding.apiKey, ...baseURL }, catalogModel(model)),
      };
    case 'anthropic':
      return {
        kind: 'anthropic',
        adapter: new AnthropicTextAdapter(
          { apiKey: binding.apiKey, ...baseURL },
          catalogModel(model),
        ),
      };
    case 'openrouter':
      return {
        kind: 'openrouter',
        adapter: new OpenRouterTextAdapter(
          {
            apiKey: binding.apiKey,
            ...(deps.baseURL === undefined ? {} : { serverURL: deps.baseURL }),
          },
          catalogModel(model),
        ),
      };
    case 'custom': {
      if (binding.endpoint === null || binding.endpoint === '') {
        // An undefined baseURL would silently become api.openai.com, and the
        // user's key with it.
        throw new ProviderConfigError(
          'a custom connection needs an endpoint before it can serve a model',
        );
      }
      // OpenAI-compatible servers implement Chat Completions; few implement
      // Responses.
      return {
        kind: 'custom',
        adapter: new CompatibleChatAdapter(
          {
            apiKey: binding.apiKey,
            baseURL: binding.endpoint,
            fetch: createGuardedFetch(deps.resolve, deps.fetch),
          },
          catalogModel(model),
        ),
      };
    }
    case 'crewaid':
      // An included model is built by the billing module, with
      // Crewaid's key and the allowance meter around it.
      throw new ProviderConfigError('an included model is resolved through IncludedModels');
    case 'elevenlabs':
      // A speech key holds no models, so no turn can be bound to one.
      throw new ProviderConfigError(
        'an ElevenLabs connection is a voice key, not a model provider',
      );
  }
}

/**
 * OpenAI Chat Completions adapter that also extracts reasoning tokens from
 * OpenAI-compatible servers (DeepSeek, vLLM, and llama.cpp emit `reasoning_content`
 * or `reasoning`).
 */
class CompatibleChatAdapter extends OpenAIChatCompletionsTextAdapter<OpenAIChatModel> {
  protected override extractReasoning(chunk: unknown): { text: string } | undefined {
    const delta = ReasoningChunkSchema.safeParse(chunk);
    if (!delta.success) return undefined;
    const text = delta.data.choices
      .map((choice) => choice.delta.reasoning_content ?? choice.delta.reasoning ?? '')
      .join('');
    return text === '' ? undefined : { text };
  }
}

const ReasoningChunkSchema = z.object({
  choices: z.array(
    z.object({
      delta: z.object({
        reasoning_content: z.string().nullish(),
        reasoning: z.string().nullish(),
      }),
    }),
  ),
});

/**
 * A catalog model id as the adapter's model type.
 *
 * The one assertion in this file, and the reason it is safe: the adapters'
 * model types are the lists their release shipped with, used to type
 * provider options. At runtime every adapter passes the id through to the
 * provider untouched. The id was checked by shape above and came from the
 * user's own catalog row (`ModelResolutionService`), so an unknown model is a
 * provider error the turn reports, never a type the compiler can know.
 */
function catalogModel<TModel extends string>(id: string): TModel {
  return id as TModel;
}
