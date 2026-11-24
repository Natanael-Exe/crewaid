import { Alert, Button, Input, Skeleton } from '@heroui/react';
import { IconPlugConnected, IconPlus } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderConnectionWithModels, ProviderModel } from '@crewaid/shared';
import {
  clearCredential,
  createConnection,
  createModel,
  updateModel,
  deleteConnection,
  deleteModel,
  failureOf,
  listConnections,
  setCredential,
  updateConnection,
  useApiClient,
  type ApiClient,
} from '../api';
import { EmptyState } from '../components/ui';
import { ConnectionCard } from './ConnectionCard';
import { IncludedModelsCard } from './IncludedModelsCard';
import {
  actionFailureMessage,
  addableKinds,
  connectionDraftIssue,
  EMPTY_CONNECTION_DRAFT,
  orderConnections,
  providerLabel,
  toCreateConnectionBody,
  toCreateModelBody,
  toUpdateModelBody,
  type ConnectionDraft,
  type ModelDraft,
} from './connectionsState';
import { SettingsRow, SettingsSection } from './SettingsLayout';
import { useT } from '../i18n/i18n';

/**
 * Connections — where a provider key enters this system.
 *
 * This pane is the reason V1 is per-user at all. Before D-083 the orchestrator
 * read one set of keys from its environment and every signed-in person shared
 * them; now a key is a row owned by whoever added it, and this is the only
 * screen that can put one there.
 *
 * Why every mutation refetches
 *
 * Each route answers with the row it changed, or with nothing, and splicing
 * that into a cached list would be constructing a view the server never
 * agreed to: setting a key moves `state` from NEEDS_CREDENTIAL to ACTIVE, and
 * adding a model changes a collection that arrives on a different route.
 * Refetching is one extra call on an action a person takes by hand, and it is
 * the difference between a screen that reports the server and one that reports
 * its own optimism.
 *
 * Why failures are per-connection
 *
 * A 409 here names a bot ("still in use by Quill"), so it belongs next to the
 * connection it was about. One banner at the top of a pane with four
 * connections makes the reader work out which one refused.
 */
export type ConnectionsPaneProps = {
  /** Seams for tests; production uses the live client. */
  readonly load?: () => Promise<readonly ProviderConnectionWithModels[]>;
  readonly act?: ConnectionActions;
  /** Called after a change that can alter which models exist, so the shell can refresh. */
  readonly onChanged?: () => void;
};

/**
 * Every write this pane can make, as one port.
 *
 * Grouped rather than passed as eight props so a test supplies one object, and
 * so the set of things this screen is allowed to do stays readable in one
 * place — which for a screen that handles credentials is worth more than the
 * brevity of individual props.
 */
export type ConnectionActions = {
  readonly create: (draft: ConnectionDraft) => Promise<void>;
  readonly update: (
    id: string,
    body: { name?: string; endpoint?: string; state?: 'ACTIVE' | 'DISABLED' },
  ) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
  readonly setKey: (id: string, apiKey: string) => Promise<void>;
  readonly clearKey: (id: string) => Promise<void>;
  readonly addModel: (id: string, draft: ModelDraft) => Promise<void>;
  readonly updateModel: (modelId: string, draft: ModelDraft) => Promise<void>;
  readonly removeModel: (modelId: string) => Promise<void>;
};

/**
 * The live wiring, exported so it can be tested.
 *
 * `act` lets a test drive the pane without a network, which is right for the
 * pane's own behaviour and wrong for this: injecting it replaces exactly the
 * mapping below. A test that only ever sees a fake cannot notice a draft being
 * sent as the wrong body, which is the mistake this function can actually
 * make.
 */
export function liveActions(client: ApiClient): ConnectionActions {
  return {
    create: async (draft) => {
      await createConnection(client, toCreateConnectionBody(draft));
    },
    update: async (id, body) => {
      await updateConnection(client, id, body);
    },
    remove: async (id) => {
      await deleteConnection(client, id);
    },
    setKey: async (id, apiKey) => {
      await setCredential(client, id, { apiKey });
    },
    clearKey: async (id) => {
      await clearCredential(client, id);
    },
    addModel: async (id, draft) => {
      await createModel(client, id, toCreateModelBody(draft));
    },
    updateModel: async (modelId, draft) => {
      await updateModel(client, modelId, toUpdateModelBody(draft));
    },
    removeModel: async (modelId) => {
      await deleteModel(client, modelId);
    },
  };
}

type ListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly connections: readonly ProviderConnectionWithModels[] }
  | { readonly status: 'failed'; readonly message: string };

/** The shape of an endpoint, shown in the empty field; not a word, so not in the catalog. */
const ENDPOINT_EXAMPLE = 'https://api.example.com/v1';

export function ConnectionsPane({ load, act, onChanged }: ConnectionsPaneProps) {
  const t = useT();
  const client = useApiClient();
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  /** Keyed by connection id, plus `''` for the add form. */
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>({});
  const [draft, setDraft] = useState<ConnectionDraft>(EMPTY_CONNECTION_DRAFT);
  const [addOpen, setAddOpen] = useState(false);

  const loadRef = useRef(load);
  const actRef = useRef(act);
  const changedRef = useRef(onChanged);
  useEffect(() => {
    loadRef.current = load;
    actRef.current = act;
    changedRef.current = onChanged;
  }, [load, act, onChanged]);

  const reload = useCallback(async (): Promise<void> => {
    const fetchList = loadRef.current ?? (async () => (await listConnections(client)).connections);
    try {
      setState({ status: 'ready', connections: await fetchList() });
    } catch (error: unknown) {
      setState({ status: 'failed', message: failureOf(error).message });
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Run one write, then re-read.
   *
   * The refetch happens whether the write succeeded or not. A 409 means
   * nothing changed, but a failure this pane cannot classify might not — and
   * a screen that keeps rendering its pre-failure list after an unknown error
   * is asserting something it has no basis for.
   */
  const run = useCallback(
    async (scope: string, action: string, write: (actions: ConnectionActions) => Promise<void>) => {
      setBusy(true);
      setProblems((current) => ({ ...current, [scope]: '' }));
      try {
        await write(actRef.current ?? liveActions(client));
        setProblems((current) => {
          const next = { ...current };
          delete next[scope];
          return next;
        });
        changedRef.current?.();
      } catch (error: unknown) {
        const message = actionFailureMessage(failureOf(error), action);
        setProblems((current) => ({ ...current, [scope]: message }));
      } finally {
        await reload();
        setBusy(false);
      }
    },
    [client, reload],
  );

  const kinds = state.status === 'ready' ? addableKinds(state.connections) : [];
  const addProblem = problems[''];
  const draftProblem = addOpen ? connectionDraftIssue(draft) : null;

  return (
    <>
      {state.status === 'loading' ? (
        <div
          role="status"
          aria-label={t('settings.connections.loading')}
          className="mb-6 flex flex-col gap-3"
        >
          {[0, 1].map((index) => (
            <div key={index} className="crewaid-settings-surface flex items-center gap-3 p-4">
              <Skeleton className="size-9 shrink-0 rounded-xl" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3.5 w-2/5 rounded-full" />
                <Skeleton className="h-3 w-3/5 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {state.status === 'failed' ? (
        <Alert status="danger" role="alert" className="mb-6">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              {t('settings.connections.loadFailed', { reason: state.message })}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      {state.status === 'ready' && state.connections.length === 0 ? (
        <SettingsSection title={t('settings.connections.empty.title')}>
          <EmptyState size="sm" className="py-6">
            <EmptyState.Header>
              <EmptyState.Media variant="icon">
                <IconPlugConnected className="size-4 text-muted" aria-hidden />
              </EmptyState.Media>
              <EmptyState.Description>
                {t('settings.connections.empty.body')}
              </EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        </SettingsSection>
      ) : null}

      {state.status === 'ready'
        ? orderConnections(state.connections).map((connection) =>
            connection.kind === 'crewaid' ? (
              <IncludedModelsCard key={connection.id} connection={connection} />
            ) : (
              <ConnectionCard
                key={connection.id}
                connection={connection}
                busy={busy}
                problem={problems[connection.id] ?? null}
                onRename={(name) =>
                  void run(connection.id, t('settings.action.rename'), (a) =>
                    a.update(connection.id, { name }),
                  )
                }
                onSetEndpoint={(endpoint) =>
                  void run(connection.id, t('settings.action.saveUrl'), (a) =>
                    a.update(connection.id, { endpoint }),
                  )
                }
                onToggleEnabled={(enabled) =>
                  void run(
                    connection.id,
                    enabled ? t('settings.action.enable') : t('settings.action.disable'),
                    (a) => a.update(connection.id, { state: enabled ? 'ACTIVE' : 'DISABLED' }),
                  )
                }
                onSetKey={(apiKey) =>
                  void run(connection.id, t('settings.action.saveKey'), (a) =>
                    a.setKey(connection.id, apiKey),
                  )
                }
                onClearKey={() =>
                  void run(connection.id, t('settings.action.removeKey'), (a) =>
                    a.clearKey(connection.id),
                  )
                }
                onRemove={() =>
                  void run(connection.id, t('settings.action.removeConnection'), (a) =>
                    a.remove(connection.id),
                  )
                }
                onAddModel={(model) =>
                  void run(connection.id, t('settings.action.addModel'), (a) =>
                    a.addModel(connection.id, model),
                  )
                }
                onUpdateModel={(model: ProviderModel, draft) =>
                  void run(
                    connection.id,
                    t('settings.action.saveModel', { model: model.label }),
                    (a) => a.updateModel(model.id, draft),
                  )
                }
                onRemoveModel={(model: ProviderModel) =>
                  void run(
                    connection.id,
                    t('settings.action.removeModel', { model: model.label }),
                    (a) => a.removeModel(model.id),
                  )
                }
              />
            ),
          )
        : null}

      {/* Closed, adding is one button; a heading, a card and a button that all
          said "Add a connection" was the same words three times. */}
      {state.status === 'ready' && addOpen ? (
        <SettingsSection title={t('settings.connections.add.title')}>
          <>
            <SettingsRow
              label={t('settings.connections.provider.label')}
              description={t('settings.connections.provider.description')}
              stacked
              control={
                <div className="flex flex-wrap gap-2">
                  {kinds.map((option) => (
                    <Button
                      key={option.kind}
                      variant={draft.kind === option.kind ? 'primary' : 'tertiary'}
                      size="sm"
                      isDisabled={busy || option.blocked !== null}
                      onPress={() => setDraft({ ...draft, kind: option.kind })}
                      className="h-8 rounded-[10px] px-3.5 text-caption font-medium"
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
              }
            />
            {kinds
              .filter((option) => option.blocked !== null && option.kind === draft.kind)
              .map((option) => (
                <p key={option.kind} className="px-4 pb-1 text-caption text-muted">
                  {t('settings.connections.blocked', {
                    provider: providerLabel(option.kind),
                    reason: option.blocked ?? '',
                  })}
                </p>
              ))}

            <SettingsRow
              label={t('settings.connections.name.label')}
              htmlFor="new-connection-name"
              stacked
              control={
                <Input
                  id="new-connection-name"
                  variant="secondary"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t('settings.connections.name.placeholder')}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  className="w-full"
                />
              }
            />

            {draft.kind === 'custom' ? (
              <SettingsRow
                label={t('settings.connections.baseUrl.label')}
                htmlFor="new-connection-endpoint"
                description={t('settings.connections.baseUrl.description')}
                stacked
                control={
                  <Input
                    id="new-connection-endpoint"
                    variant="secondary"
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={ENDPOINT_EXAMPLE}
                    value={draft.endpoint}
                    onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
                    className="w-full"
                  />
                }
              />
            ) : null}

            <SettingsRow
              label={t('settings.connections.apiKey.label')}
              htmlFor="new-connection-key"
              // Optional, and saying so matters: the alternative reading is
              // that a connection cannot exist without one, which would make
              // "define it now, key it later" look unsupported when it is
              // the normal shape on a shared install.
              description={t('settings.connections.apiKey.description')}
              stacked
              control={
                <Input
                  id="new-connection-key"
                  variant="secondary"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t('settings.connections.apiKey.placeholder')}
                  value={draft.apiKey}
                  onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                  className="w-full"
                />
              }
            />

            {draftProblem === null ? null : (
              <p className="px-4 pb-1 text-caption text-danger">{draftProblem}</p>
            )}

            <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
              <Button
                variant="primary"
                size="sm"
                isDisabled={busy || draftProblem !== null}
                onPress={() => {
                  const submitted = draft;
                  setDraft(EMPTY_CONNECTION_DRAFT);
                  setAddOpen(false);
                  void run('', t('settings.action.addConnection'), (a) => a.create(submitted));
                }}
                className="h-8 rounded-[10px] px-3.5 text-caption font-medium"
              >
                {t('settings.connections.add')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onPress={() => {
                  setDraft(EMPTY_CONNECTION_DRAFT);
                  setAddOpen(false);
                }}
                className="h-8 rounded-[10px] px-3.5 text-caption font-medium text-muted"
              >
                {t('settings.cancel')}
              </Button>
            </div>
          </>
          {addProblem === undefined || addProblem === '' ? null : (
            <div className="px-4 py-3">
              <Alert status="danger" role="alert">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{addProblem}</Alert.Description>
                </Alert.Content>
              </Alert>
            </div>
          )}
        </SettingsSection>
      ) : null}
      {state.status === 'ready' && !addOpen ? (
        <div className="mb-6 flex flex-col items-start gap-3 px-1">
          <Button
            variant="secondary"
            size="sm"
            isDisabled={busy}
            onPress={() => setAddOpen(true)}
            className="rounded-full"
          >
            <IconPlus className="size-4" stroke={1.8} aria-hidden />
            {t('settings.connections.add.title')}
          </Button>
          {addProblem === undefined || addProblem === '' ? null : (
            <div className="w-full">
              <Alert status="danger" role="alert">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{addProblem}</Alert.Description>
                </Alert.Content>
              </Alert>
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
