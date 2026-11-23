/**
 * The models a hosted plan includes, served through Crewaid's own
 * OpenRouter key and charged to the plan's allowance.
 *
 * Chosen for what a small allowance buys: strong tool use at a low price per
 * token, with one model that reads images as the default. Context windows and
 * capabilities are OpenRouter's, from its model list on 2026-10-02. Each needs
 * a row in `ai-telemetry.ts`'s price table — `included-models.test.ts` fails
 * without one — because that is the charge when a call reports no cost.
 *
 * Adding a model here adds it to every account on its next model list.
 * Removing one stops offering it to new accounts and leaves existing rows,
 * which keep working while OpenRouter serves the model.
 */
export type IncludedModel = {
  readonly upstreamModelId: string;
  readonly label: string;
  readonly contextWindow: number;
  readonly tools: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
};

export const INCLUDED_MODEL_LIST: readonly IncludedModel[] = [
  {
    upstreamModelId: 'google/gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    contextWindow: 1_048_576,
    tools: true,
    vision: true,
    reasoning: true,
  },
  {
    upstreamModelId: 'anthropic/claude-haiku-4.5',
    label: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    tools: true,
    vision: true,
    reasoning: true,
  },
  {
    upstreamModelId: 'openai/gpt-5-mini',
    label: 'GPT-5 Mini',
    contextWindow: 400_000,
    tools: true,
    vision: true,
    reasoning: true,
  },
  {
    upstreamModelId: 'deepseek/deepseek-v4-pro-0813',
    label: 'DeepSeek V4 Pro',
    contextWindow: 1_048_576,
    tools: true,
    vision: false,
    reasoning: true,
  },
  {
    upstreamModelId: 'z-ai/glm-5.3-flash',
    label: 'GLM 5.3 Flash',
    contextWindow: 1_048_576,
    tools: true,
    vision: true,
    reasoning: true,
  },
];

/** What a new account's bots run until its owner chooses otherwise. */
export const DEFAULT_INCLUDED_MODEL = 'google/gemini-3.8-flash';

/** The connection's name in Settings → Models and the picker. */
export const INCLUDED_CONNECTION_NAME = 'Crewaid';
