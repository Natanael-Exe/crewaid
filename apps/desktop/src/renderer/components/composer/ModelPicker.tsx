import {
  Autocomplete,
  Button,
  Chip,
  Header,
  ListBox,
  SearchField,
  Spinner,
  useFilter,
} from '@heroui/react';
import { useEffect, useMemo, useState } from 'react';
import type { ModelOption as ModelOptionData } from '@crewaid/shared';
import { ApiRequestError, failureOf, fetchModelCatalog, updateBot, useApiClient } from '../../api';
import {
  groupModelsByConnection,
  isDefaultOption,
  planSelection,
  providerDisplayName,
  resolveBotSelection,
  selectedOptionId,
  selectionSummary,
  unavailableReason,
} from './modelPickerState';
import { t, useT } from '../../i18n/i18n';

export type ModelPickerProps = {
  botId: string;
  botModelId?: string | null;
  onModelChange?: (modelId: string) => void;
  /** Dependency injection for focused tests; production uses M1-BE-10. */
  models?: readonly ModelOptionData[];
  /** What the `default` alias resolves to for this user. */
  defaultModelId?: string | null;
  loadCatalog?: () => Promise<Catalog>;
  /**
   * Bumped by the shell when settings closes — the catalog is edited behind
   * that modal, and this picker reads it once per mount. A version that
   * changed since the last read is a refetch.
   */
  catalogVersion?: number | undefined;
  /**
   * Selecting a model is a `PATCH /bots/:id`, not a local preference.
   *
   * Injected rather than called inline so the failure path is testable — and
   * the failure path is the one that matters, because a selection that looks
   * saved and was not means the next turn runs on the previous model.
   */
  saveSelection?: (botId: string, modelId: string) => Promise<void>;
};

/** `GET /models` answers with the list AND what `default` resolves to. */
export type Catalog = {
  readonly models: readonly ModelOptionData[];
  readonly defaultModelId: string | null;
};

type CatalogState =
  | { status: 'loading'; models: readonly ModelOptionData[]; defaultModelId: string | null }
  | { status: 'ready'; models: readonly ModelOptionData[]; defaultModelId: string | null }
  | { status: 'empty'; models: readonly ModelOptionData[]; defaultModelId: string | null }
  | {
      status: 'error';
      models: readonly ModelOptionData[];
      defaultModelId: string | null;
      error: ApiRequestError;
    };

function makeCatalogState(catalog: Catalog): CatalogState {
  return catalog.models.length === 0
    ? { status: 'empty', models: catalog.models, defaultModelId: catalog.defaultModelId }
    : { status: 'ready', models: catalog.models, defaultModelId: catalog.defaultModelId };
}

function statusLabel(state: CatalogState): string {
  switch (state.status) {
    case 'loading':
      return t('composer.model.loading');
    case 'empty':
      return t('composer.model.none');
    case 'error':
      return t('composer.model.catalogDown');
    case 'ready':
      return t('composer.model.choose');
  }
}

function capabilityLabel(capability: keyof ModelOptionData['capabilities']): string {
  switch (capability) {
    case 'tools':
      return t('settings.model.tools');
    case 'vision':
      return t('settings.model.vision');
    case 'reasoning':
      return t('settings.model.reasoning');
  }
}

/** The capabilities this model actually has — read by the row and the catalog attribute alike. */
function enabledCapabilities(model: ModelOptionData): (keyof ModelOptionData['capabilities'])[] {
  return (Object.keys(model.capabilities) as (keyof ModelOptionData['capabilities'])[]).filter(
    (capability) => model.capabilities[capability],
  );
}

function ModelCapabilities({ model }: { model: ModelOptionData }) {
  const t = useT();
  const capabilities = enabledCapabilities(model);

  return capabilities.length > 0 ? (
    <span className="flex shrink-0 gap-1" aria-label={t('composer.model.capabilities')}>
      {capabilities.map((capability) => (
        <Chip key={capability} size="sm" variant="soft" color="accent">
          <Chip.Label>{capabilityLabel(capability)}</Chip.Label>
        </Chip>
      ))}
    </span>
  ) : (
    <span className="text-[11px] text-muted">{t('composer.model.noCapabilities')}</span>
  );
}

function ModelOption({ model, isDefault }: { model: ModelOptionData; isDefault: boolean }) {
  const t = useT();
  const unavailable = unavailableReason(model);
  return (
    <ListBox.Item
      id={model.id}
      // The row id is the identity and a cuid is not searchable, so
      // the secondary line and the search text both carry the UPSTREAM id —
      // the name the provider knows the model by, and the one an operator
      // typed into settings. The connection name rides along because the
      // search box filters on this text alone.
      textValue={`${model.upstreamModelId} ${model.label} ${model.connectionName}`}
      isDisabled={!model.available}
      // The selection is marked in the list as well as on the trigger, and it
      // is the same grey the row already takes on hover.
      className="flex min-w-0 items-center gap-2 px-3 py-2 rounded-lg data-[selected=true]:bg-default"
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-foreground">{model.label}</span>
          {/*
            V1-13: which option the `default` alias resolves to, marked in the
            list rather than only on the trigger. A bot left on `default`
            follows this row, so seeing WHICH one is how an operator
            understands that changing their default moves that bot too.
          */}
          {isDefault ? (
            <Chip size="sm" variant="soft" color="default">
              <Chip.Label>{t('composer.model.default')}</Chip.Label>
            </Chip>
          ) : null}
        </span>
        {model.kind === 'crewaid' ? null : (
          <span className="block truncate font-mono text-[10px] text-muted">
            {model.upstreamModelId}
          </span>
        )}
        {unavailable === null ? null : (
          <span className="block truncate text-[10px] text-foreground-faint">{unavailable}</span>
        )}
      </span>
      <ModelCapabilities model={model} />
    </ListBox.Item>
  );
}

export function ModelPicker({
  botId,
  botModelId,
  onModelChange,
  models,
  defaultModelId,
  loadCatalog,
  catalogVersion,
  saveSelection,
}: ModelPickerProps) {
  const t = useT();
  const { contains } = useFilter({ sensitivity: 'base' });
  const client = useApiClient();
  // Memoized so the loader identity is stable — it is an effect dependency,
  // and a fresh closure per render would refetch the catalog on every render.
  const load = useMemo(
    // `GET /models` answers `{ models, defaultModelId }` since D-086, and
    // V1-13 needs both halves: the alias is resolved per user at call time, so
    // marking which option it lands on takes no second round trip.
    () => loadCatalog ?? (() => fetchModelCatalog(client)),
    [loadCatalog, client],
  );
  const save = useMemo(
    () =>
      saveSelection ??
      (async (id: string, modelId: string) => {
        await updateBot(client, id, { modelId });
      }),
    [saveSelection, client],
  );

  // Memoized so it can be an effect dependency without rebuilding — and
  // therefore refetching — on every render.
  const seeded: Catalog | undefined = useMemo(
    () => (models === undefined ? undefined : { models, defaultModelId: defaultModelId ?? null }),
    [models, defaultModelId],
  );

  const [catalog, setCatalog] = useState<CatalogState>(() =>
    seeded === undefined
      ? { status: 'loading', models: [], defaultModelId: null }
      : makeCatalogState(seeded),
  );
  /**
   * What is selected right now, which is NOT always what the bot row says.
   *
   * A choice is applied optimistically and reverted if the PATCH is refused,
   * so between those two moments this differs from `botModelId` on purpose.
   * Deriving it from the prop instead would make every selection wait for a
   * round trip before the label changed.
   */
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPendingId(null);
    setSaveError(null);

    if (seeded !== undefined) {
      setCatalog(makeCatalogState(seeded));
      return () => {
        cancelled = true;
      };
    }

    setCatalog({ status: 'loading', models: [], defaultModelId: null });
    void load()
      .then((next) => {
        if (cancelled) return;
        setCatalog(makeCatalogState(next));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Anything that is not already normalized reaches the UI as neutral
        // copy — a raw Error message here could be a server or vendor string.
        setCatalog({
          status: 'error',
          models: [],
          defaultModelId: null,
          error:
            error instanceof ApiRequestError
              ? error
              : new ApiRequestError({
                  code: 'UNKNOWN',
                  message: t('composer.model.catalogError'),
                }),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [botId, load, seeded, reloadKey, catalogVersion]);

  const groups = useMemo(() => groupModelsByConnection(catalog.models), [catalog.models]);

  /**
   * The row is the source of truth; `pendingId` only overrides it while a
   * PATCH is in flight or has just landed.
   */
  const selection = useMemo(
    () => resolveBotSelection(catalog.models, pendingId ?? botModelId, catalog.defaultModelId),
    [catalog.models, catalog.defaultModelId, pendingId, botModelId],
  );
  const selectedId = selectedOptionId(selection);
  const summary = selectionSummary(selection, catalog.models);

  /**
   * Choosing a model writes `Bot.modelId`.
   *
   * The id stored is the ProviderModel ROW id, never a composed
   * `provider:model` key — that key stopped being unique the moment a user
   * could hold two custom connections, and nothing in the string says which
   * endpoint or which credential it meant.
   *
   * Optimistic, then reverted on refusal. The revert is the part that matters:
   * a selection that looks saved and was not means every subsequent turn runs
   * on the previous model, and nothing on screen would ever say so.
   */
  const chooseModel = (key: string | number | null) => {
    const plan = planSelection(key, catalog.models, selectedId);
    if (plan === null) return;

    setPendingId(plan.nextId);
    setSaveError(null);

    // Announced only once the PATCH lands. The label moves immediately —
    // `pendingId` is the optimistic half — but telling the shell to re-read
    // the bot before the row has changed would have it read the old value and
    // render it back over the new one.
    void save(botId, plan.nextId)
      .then(() => onModelChange?.(plan.nextId))
      .catch((error: unknown) => {
        // Back to what the row said. Leaving the optimistic label up would mean
        // every later turn runs on a model the composer is not showing.
        setPendingId(plan.previousId);
        setSaveError(failureOf(error).message);
      });
  };

  const triggerText = catalog.status === 'ready' ? summary.label : statusLabel(catalog);

  const catalogSummary = catalog.models
    .map((model) => {
      const enabled = enabledCapabilities(model).map(capabilityLabel).join(',');
      // The options themselves live in a popover, so this attribute is the
      // only rendered surface a static-markup test can assert against — which
      // makes WHICH fields it carries a contract of its own. The row id is
      // deliberately not among them: a cuid identifies nothing to a reader,
      // and the fields here are the ones a person recognises.
      const availability = unavailableReason(model) ?? 'available';
      // Whether the `default` alias lands here. A test can see which
      // option is marked without opening the popover.
      const alias = isDefaultOption(model, catalog.defaultModelId) ? 'default' : '';
      return [
        model.connectionName,
        model.upstreamModelId,
        model.label,
        enabled,
        availability,
        alias,
      ].join('|');
    })
    .join(';;');

  return (
    <div
      className="flex min-w-0 items-center"
      data-model-picker
      data-model-picker-state={catalog.status}
      data-model-picker-selected={selectedId ?? undefined}
      // Three states the operator has to be able to tell apart, so the
      // one attribute carries which rather than a bare boolean.
      data-model-picker-selection={selection.kind}
      data-model-picker-via-default={
        selection.kind === 'model' && selection.viaDefault ? 'true' : 'false'
      }
      data-model-picker-catalog={catalogSummary || undefined}
    >
      <Autocomplete
        aria-label={t('composer.model.label')}
        selectedKey={selectedId}
        onSelectionChange={(key) => chooseModel(typeof key === 'string' ? key : null)}
        isDisabled={catalog.status !== 'ready'}
        className="min-w-0"
        placeholder={triggerText}
      >
        <Autocomplete.Trigger className="group flex min-w-0 items-center rounded-2xl border border-transparent px-1.5 py-1 text-start outline-none transition-colors bg-transparent shadow-none">
          <Autocomplete.Value className="pe-4 truncate max-w-40">
            {({ defaultChildren, isPlaceholder }) =>
              isPlaceholder ? defaultChildren : triggerText
            }
          </Autocomplete.Value>
          <Autocomplete.Indicator aria-hidden="true" className="ms-1 size-3 shrink-0 text-muted" />
        </Autocomplete.Trigger>
        <Autocomplete.Popover className="crewaid-bot-context min-w-[min(420px,calc(100vw-32px))] rounded-xl">
          {/*
            The filter OWNS the search box: `Autocomplete.Filter` keeps the
            input's value and filters the ListBox under it, so filtering is the
            library's job rather than this component's — including dropping a
            connection section left with no matching model.
          */}
          <Autocomplete.Filter filter={contains}>
            <SearchField
              autoFocus
              aria-label={t('composer.model.search')}
              name="search"
              variant="secondary"
            >
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input
                  aria-label={t('composer.model.label')}
                  disabled={catalog.status !== 'ready'}
                  placeholder={t('composer.model.searchPlaceholder')}
                />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
            <ListBox
              aria-label={t('composer.model.available')}
              renderEmptyState={() => (
                <div className="px-3 py-4 text-center text-[12px] text-muted">
                  {t('composer.model.noMatch')}
                </div>
              )}
            >
              {groups.map((group) => (
                <ListBox.Section key={group.connectionId} aria-label={group.connectionName}>
                  <Header className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
                    {group.connectionName}{' '}
                    <span className="text-foreground-faint">
                      · {providerDisplayName(group.kind)}
                    </span>
                  </Header>
                  {group.models.map((model) => (
                    <ModelOption
                      key={model.id}
                      model={model}
                      isDefault={isDefaultOption(model, catalog.defaultModelId)}
                    />
                  ))}
                </ListBox.Section>
              ))}
            </ListBox>
          </Autocomplete.Filter>
        </Autocomplete.Popover>
      </Autocomplete>
      {catalog.status === 'loading' ? (
        <Spinner size="sm" aria-label={t('composer.model.loadingLabel')} className="ms-1" />
      ) : null}
      {catalog.status === 'error' ? (
        <>
          <span role="status" className="sr-only">
            {catalog.error.message}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('composer.model.retryLabel')}
            onPress={() => setReloadKey((key) => key + 1)}
            className="ms-1 h-7 rounded-md px-1.5 text-[11px] text-muted"
          >
            {t('composer.model.retry')}
          </Button>
        </>
      ) : null}
      {/*
        Announced before send rather than discovered after it. All three
        reasons a turn cannot resolve — no default chosen, a deleted model, a
        connection without a key — read the same way from the trigger, so the
        sentence has to say which.
      */}
      {catalog.status === 'ready' && summary.notice !== null ? (
        <span className="sr-only" role="status">
          {summary.notice}
        </span>
      ) : null}
      {/*
        A refused PATCH is louder than the usual normalized copy, because the
        picker has already snapped back to the previous model: without this the
        only evidence is a label that quietly changed twice.
      */}
      {saveError === null ? null : (
        <span className="sr-only" role="alert">
          {t('composer.model.saveFailed', { reason: saveError })}
        </span>
      )}
    </div>
  );
}
