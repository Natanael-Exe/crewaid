import type { ModelOption } from '@crewaid/shared';
import type { SearchSelectItem } from './SearchSelect';

/** Sentinel key meaning "inherit — no account-wide coding model override". */
export const INHERIT_CODING_MODEL = '__inherit_coding_model__';

/**
 * Tool-capable models eligible for delegated `code_task` runs.
 *
 * Keeps the currently saved model in the list even if its connection is
 * temporarily missing a key so the picker never hides what is stored.
 */
export function toolCapableCodingModels(
  models: readonly ModelOption[],
  currentId: string | null,
): ModelOption[] {
  return models.filter(
    (model) => model.capabilities.tools && (model.available || model.id === currentId),
  );
}

/** Build `SearchSelect` rows for the account-wide coding model setting. */
export function codingModelItems(
  models: readonly ModelOption[],
  options: {
    readonly inheritLabel: string;
    readonly currentId: string | null;
    readonly currentFallbackLabel: string;
    readonly unavailableLabel: string;
  },
): SearchSelectItem[] {
  const eligible = toolCapableCodingModels(models, options.currentId);
  const items: SearchSelectItem[] = [
    {
      id: INHERIT_CODING_MODEL,
      label: options.inheritLabel,
    },
  ];
  for (const model of eligible) {
    items.push({
      id: model.id,
      label: model.label,
      detail: model.available
        ? model.connectionName
        : `${model.connectionName} · ${options.unavailableLabel}`,
      keywords: `${model.upstreamModelId} ${model.connectionName}`,
    });
  }
  if (
    options.currentId !== null &&
    !items.some((item) => item.id === options.currentId)
  ) {
    items.push({
      id: options.currentId,
      label: options.currentFallbackLabel,
    });
  }
  return items;
}
