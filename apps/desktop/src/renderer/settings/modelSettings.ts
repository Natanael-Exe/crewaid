import { t } from '../i18n/i18n';
/**
 * What the Models pane can honestly say about a model (CC-14, revised V1-06).
 *
 * `PROVIDER_ENV_KEYS` AND `providerEnvKey` ARE GONE. They named the
 * environment variable configuring each provider, which was true while
 * credentials lived in the orchestrator's environment. D-083 moved them into
 * per-user rows and removed the environment fallback, so those names now
 * configure nothing — a pane pointing an operator at `OPENAI_API_KEY` would be
 * sending them to edit a file that no longer has any effect.
 *
 * The "no connected badge" reasoning is also obsolete, in the good direction:
 * `ModelOption.connectionState` reports it now, so the pane says whether a
 * model can be used rather than guessing.
 */

/** "200,000" reads as noise in a chip; "200K" is the number people compare. */
export function contextWindowLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return t('settings.model.contextMillions', {
      value: Number.isInteger(millions) ? millions : Number(millions.toFixed(1)),
    });
  }
  if (tokens >= 1_000)
    return t('settings.model.contextThousands', { value: Math.round(tokens / 1_000) });
  return t('settings.model.context', { value: tokens });
}

export function capabilityLabels(capabilities: {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
}): readonly string[] {
  const labels: string[] = [];
  if (capabilities.tools) labels.push(t('settings.model.tools'));
  if (capabilities.vision) labels.push(t('settings.model.vision'));
  if (capabilities.reasoning) labels.push(t('settings.model.reasoning'));
  return labels;
}
