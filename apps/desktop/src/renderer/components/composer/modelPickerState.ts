import { MODEL_REF_DEFAULT, type ModelOption, type ProviderKind } from '@crewaid/shared';
import { t } from '../../i18n/i18n';

/**
 * Models group by CONNECTION, not by provider.
 *
 * A user may hold two custom connections, and both may serve a model called
 * `llama-3`. Grouping by provider kind would put them in one bucket labelled
 * "Custom" with no way to tell which endpoint — and which key — each belongs
 * to. The group is keyed on `connectionId` and LABELLED with the name, which
 * is the whole of D-082 in one type: the row is the identity, the name is for
 * reading.
 */
export type ModelsByConnection = {
  connectionId: string;
  connectionName: string;
  kind: ProviderKind;
  models: readonly ModelOption[];
};

/**
 * What `Bot.modelId` points at, once the `default` alias is resolved.
 *
 * Why this is a union and not a string
 *
 * Three of these states look identical from the outside — the picker shows no
 * model — and each needs a different sentence:
 *
 * `model` the bot points at a row that exists. `viaDefault` says whether
 * it got there through the alias, which matters because changing
 * the default moves it and choosing here pins it.
 * `unset` the bot is on `default` and this user has chosen no default.
 * Nothing resolves. A turn fails at resolution, so the picker has
 * to say so BEFORE anyone presses send.
 * `missing` the bot points at a row id that is not in the list — the model
 * was deleted, or belongs to a connection this user no longer has.
 *
 * Collapsing them into `string | null` is what makes "no model selected" the
 * only thing the UI can say, and it is the least useful of the three.
 */
export type ResolvedSelection =
  | { readonly kind: 'model'; readonly modelId: string; readonly viaDefault: boolean }
  | { readonly kind: 'unset' }
  | { readonly kind: 'missing'; readonly modelId: string };

/**
 * Resolve what this bot will actually run on.
 *
 * What went away here, and why
 *
 * This used to take a THIRD candidate: a model id remembered in localStorage
 * per bot, preferred over the bot's own row. That made sense while selecting a
 * model changed nothing on the server — the choice had nowhere else to live.
 * Selecting a model is a `PATCH /bots/:id`, so the row is the answer, and a
 * remembered copy on this machine would be a second source of truth that WINS
 * over the first. The failure is quiet and specific: change a bot's model in
 * one window, and the other window keeps sending to the old one forever.
 *
 * Nothing is silently re-pointed. A model whose connection lost its key stays
 * selected and disabled — moving the selection elsewhere would mean
 * the operator sees a working picker and never learns which model stopped
 * working, or why.
 */
export function resolveBotSelection(
  models: readonly ModelOption[],
  botModelId: string | null | undefined,
  defaultModelId: string | null | undefined,
): ResolvedSelection {
  const known = new Set(models.map((model) => model.id));

  if (botModelId === null || botModelId === undefined || botModelId === MODEL_REF_DEFAULT) {
    // The alias, resolved per user at call time. `defaultModelId`
    // arrives with the list precisely so this needs no second round trip.
    if (defaultModelId !== null && defaultModelId !== undefined && known.has(defaultModelId)) {
      return { kind: 'model', modelId: defaultModelId, viaDefault: true };
    }
    return { kind: 'unset' };
  }

  return known.has(botModelId)
    ? { kind: 'model', modelId: botModelId, viaDefault: false }
    : { kind: 'missing', modelId: botModelId };
}

/**
 * The id to show as selected, or null when nothing resolves.
 *
 * `missing` deliberately answers null: the row id is not in the list, so the
 * ListBox has no item to select, and handing it one would be selecting a key
 * that does not exist. What the operator is told about it is the trigger's
 * job, not the list's.
 */
export function selectedOptionId(selection: ResolvedSelection): string | null {
  return selection.kind === 'model' ? selection.modelId : null;
}

/**
 * What the picker's trigger says, and what it warns about.
 *
 * `notice` is non-null exactly when a turn would fail at resolution, so it is
 * also what the screen reader announces. Saying it here rather than at send
 * time is the point: "no model" discovered after pressing send costs the
 * message, and the operator then has to work out which of three causes it was.
 */
export type SelectionSummary = {
  readonly label: string;
  readonly notice: string | null;
};

export function selectionSummary(
  selection: ResolvedSelection,
  models: readonly ModelOption[],
): SelectionSummary {
  switch (selection.kind) {
    case 'model': {
      const model = models.find((candidate) => candidate.id === selection.modelId);
      if (model === undefined) {
        // `resolveBotSelection` only answers `model` for an id it found in
        // this same list, so this is unreachable — and cheap to keep correct
        // if the two ever stop being computed together.
        return { label: t('composer.model.choose'), notice: null };
      }
      return {
        label: selection.viaDefault
          ? t('composer.model.viaDefault', { model: model.label })
          : model.label,
        notice: unavailableReason(model),
      };
    }
    case 'unset':
      return {
        label: t('composer.model.noDefault'),
        // D-083 removed the environment fallback, so there is genuinely
        // nothing behind the alias until this user picks something.
        notice: t('composer.model.noDefault.notice'),
      };
    case 'missing':
      return {
        label: t('composer.model.missing'),
        // The id is NOT shown. It is a cuid, it identifies nothing to a
        // reader, and printing it invites someone to search a provider
        // dashboard for a string that was never on the wire.
        notice: t('composer.model.missing.notice'),
      };
  }
}

/** Whether this option is the one the `default` alias resolves to. */
export function isDefaultOption(
  model: ModelOption,
  defaultModelId: string | null | undefined,
): boolean {
  return defaultModelId !== null && defaultModelId !== undefined && model.id === defaultModelId;
}

/** What a selection will write, and what to put back if the write is refused. */
export type SelectionAttempt = {
  /** The `ProviderModel` row id — what `Bot.modelId` stores. */
  readonly nextId: string;
  readonly previousId: string | null;
};

/**
 * Decide what a click on an option means, before anything is written.
 *
 * Extracted from the component because this is the half of model selection with a rule
 * in it, and a component that only renders through `renderToStaticMarkup` has
 * no way to be clicked. What it settles:
 *
 * - the value written is the ROW ID and only ever a row id. `Bot.modelId` was
 * a `provider:model` key once; that key stopped being unique the moment a
 * user could hold two custom connections, and nothing in the string said
 * which endpoint or whose credential it meant;
 * - a key that is not in this catalog writes nothing. The list is owner-scoped,
 * so an id from anywhere else is an id this user cannot resolve;
 * - an UNAVAILABLE model cannot be newly chosen. The ListBox already disables
 * it, and this is the same rule where a test can see it. Note the asymmetry:
 * a model that BECOMES unavailable stays selected, because un-selecting it
 * would hide which model stopped working.
 */
export function planSelection(
  key: unknown,
  models: readonly ModelOption[],
  currentId: string | null,
): SelectionAttempt | null {
  if (typeof key !== 'string' || key === '') return null;
  const next = models.find((model) => model.id === key);
  if (next === undefined || !next.available) return null;
  if (next.id === currentId) return null;
  return { nextId: next.id, previousId: currentId };
}

export function groupModelsByConnection(models: readonly ModelOption[]): ModelsByConnection[] {
  const grouped = new Map<string, ModelsByConnection & { models: ModelOption[] }>();
  for (const model of models) {
    const current = grouped.get(model.connectionId);
    if (current === undefined) {
      grouped.set(model.connectionId, {
        connectionId: model.connectionId,
        connectionName: model.connectionName,
        kind: model.kind,
        models: [model],
      });
    } else {
      current.models.push(model);
    }
  }
  // Sorted by NAME because that is what a person scans, and ties broken by id
  // so two connections called the same thing still have a stable order —
  // otherwise the list reshuffles between renders.
  return [...grouped.values()].sort(
    (left, right) =>
      left.connectionName.localeCompare(right.connectionName) ||
      left.connectionId.localeCompare(right.connectionId),
  );
}

export function providerDisplayName(kind: ProviderKind): string {
  switch (kind) {
    case 'anthropic':
      return 'Anthropic';
    case 'openai':
      return 'OpenAI';
    case 'openrouter':
      return 'OpenRouter';
    case 'custom':
      return t('composer.model.custom');
    case 'crewaid':
      return 'Crewaid';
    case 'elevenlabs':
      return 'ElevenLabs';
  }
}

/**
 * Why a model cannot be chosen, or null when it can.
 *
 * D-086 keeps an unavailable model in the list rather than hiding it, which
 * is only useful if the list says why — "my model disappeared" and "my model
 * is greyed out because the key was removed" are a support ticket apart.
 */
export function unavailableReason(model: ModelOption): string | null {
  if (model.available) return null;
  switch (model.connectionState) {
    case 'NEEDS_CREDENTIAL':
      return t('composer.model.noKey', { connection: model.connectionName });
    case 'DISABLED':
      return t('composer.model.off', { connection: model.connectionName });
    case 'ACTIVE':
      // Unreachable while `available` is derived from the state, and kept so
      // that decoupling the two later cannot silently produce a blank reason.
      return t('composer.model.unavailable', { connection: model.connectionName });
  }
}
