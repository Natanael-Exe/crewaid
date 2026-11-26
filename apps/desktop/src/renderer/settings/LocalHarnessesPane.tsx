import { Alert, Button, Chip, Input, Skeleton } from '@heroui/react';
import type { LocalConnectorView } from '@crewaid/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { failureOf } from '../api/apiError';
import {
  createConnector,
  listConnectors,
  removeConnector,
  rotateConnectorSecret,
} from '../api/connectors';
import { useApiClient } from '../api/useApiClient';
import { credentialsProvider } from '../bridge';
import { currentLocale, useT } from '../i18n/i18n';
import { SettingsRow, SettingsSection } from './SettingsLayout';

export interface IssuedConnectorSecret {
  readonly connectorId: string;
  readonly connectorName: string;
  readonly secret: string;
}

const DEFAULT_SERVER_PLACEHOLDER = 'https://your-crewaid-host';

/**
 * Builds the copyable terminal command with the bearer token deliberately
 * omitted so secrets never enter shell history.
 */
export function buildConnectorLaunchCommand(serverUrl: string | null): string {
  const clean =
    serverUrl !== null && serverUrl.trim() !== ''
      ? serverUrl.trim().replace(/\/+$/, '')
      : DEFAULT_SERVER_PLACEHOLDER;
  return `npx crewaid-connect /path/to/repo --url ${clean}`;
}

function formatLastSeen(date: Date): string {
  return new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function maskSecret(secret: string): string {
  const prefix = secret.slice(0, 14);
  return `${prefix}${'•'.repeat(Math.max(8, secret.length - prefix.length))}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function LocalHarnessesPane({
  connectorsVersion = 0,
}: {
  readonly connectorsVersion?: number | undefined;
}) {
  const client = useApiClient();
  const [connectors, setConnectors] = useState<readonly LocalConnectorView[] | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedConnectorSecret | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await listConnectors(client, signal);
        if (signal?.aborted) return;
        setConnectors(response.connectors);
        setProblem(null);
      } catch (error: unknown) {
        if (!signal?.aborted) setProblem(failureOf(error).message);
      }
    },
    [client],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, connectorsVersion]);

  useEffect(() => {
    let active = true;
    void credentialsProvider()
      .then((creds) => {
        if (
          active &&
          typeof creds.orchestratorBaseUrl === 'string' &&
          creds.orchestratorBaseUrl.trim() !== ''
        ) {
          setServerUrl(creds.orchestratorBaseUrl.trim());
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const handleCreate = useCallback(
    async (name: string) => {
      setCreating(true);
      setProblem(null);
      try {
        const created = await createConnector(client, { name });
        setIssued({
          connectorId: created.connector.id,
          connectorName: created.connector.name,
          secret: created.secret,
        });
        await load();
        return true;
      } catch (error: unknown) {
        setProblem(failureOf(error).message);
        return false;
      } finally {
        setCreating(false);
      }
    },
    [client, load],
  );

  const handleRotate = useCallback(
    async (connector: LocalConnectorView) => {
      setBusyId(connector.id);
      setProblem(null);
      try {
        const rotated = await rotateConnectorSecret(client, connector.id);
        setIssued({
          connectorId: rotated.connector.id,
          connectorName: rotated.connector.name,
          secret: rotated.secret,
        });
        await load();
      } catch (error: unknown) {
        setProblem(failureOf(error).message);
      } finally {
        setBusyId(null);
      }
    },
    [client, load],
  );

  const handleRemove = useCallback(
    async (connector: LocalConnectorView) => {
      setBusyId(connector.id);
      setProblem(null);
      try {
        await removeConnector(client, connector.id);
        setIssued((current) => (current?.connectorId === connector.id ? null : current));
        await load();
      } catch (error: unknown) {
        setProblem(failureOf(error).message);
      } finally {
        setBusyId(null);
      }
    },
    [client, load],
  );

  return (
    <LocalHarnessesView
      connectors={connectors}
      serverUrl={serverUrl}
      problem={problem}
      issued={issued}
      busyId={busyId}
      creating={creating}
      onCreate={handleCreate}
      onRotate={(connector) => void handleRotate(connector)}
      onRemove={(connector) => void handleRemove(connector)}
      onDismissIssued={() => setIssued(null)}
    />
  );
}

export interface LocalHarnessesViewProps {
  readonly connectors: readonly LocalConnectorView[] | null;
  readonly serverUrl: string | null;
  readonly problem: string | null;
  readonly issued: IssuedConnectorSecret | null;
  readonly busyId: string | null;
  readonly creating: boolean;
  readonly onCreate: (name: string) => Promise<boolean>;
  readonly onRotate: (connector: LocalConnectorView) => void;
  readonly onRemove: (connector: LocalConnectorView) => void;
  readonly onDismissIssued: () => void;
}

/** Presentational view so every connector state can be unit-tested statically. */
export function LocalHarnessesView({
  connectors,
  serverUrl,
  problem,
  issued,
  busyId,
  creating,
  onCreate,
  onRotate,
  onRemove,
  onDismissIssued,
}: LocalHarnessesViewProps) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [revealSecret, setRevealSecret] = useState(false);
  const [copiedField, setCopiedField] = useState<'token' | 'command' | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const launchCommand = buildConnectorLaunchCommand(serverUrl);

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = draftName.trim();
    if (trimmed === '') {
      setNameError(t('settings.localHarnesses.nameRequired'));
      return;
    }
    setNameError(null);
    void onCreate(trimmed).then((ok) => {
      if (ok) {
        setDraftName('');
        setAdding(false);
        setRevealSecret(false);
      }
    });
  };

  const handleCopy = (field: 'token' | 'command', value: string) => {
    void copyText(value).then((ok) => {
      if (!ok) return;
      setCopiedField(field);
      setTimeout(() => {
        setCopiedField((cur) => (cur === field ? null : cur));
      }, 2_000);
    });
  };

  if (connectors === null) {
    if (problem !== null) {
      return (
        <SettingsSection title={t('settings.localHarnesses.listTitle')}>
          <SettingsRow label={problem} />
        </SettingsSection>
      );
    }
    return (
      <div aria-busy="true" aria-label={t('settings.localHarnesses.loading')}>
        <SettingsSection title={t('settings.localHarnesses.listTitle')}>
          <div className="space-y-2.5 px-4 py-4" aria-hidden="true">
            <Skeleton
              animationType="pulse"
              className="h-3.5 w-44 rounded-full motion-reduce:animate-none"
            />
            <Skeleton
              animationType="pulse"
              className="h-3 w-3/5 rounded-full motion-reduce:animate-none"
            />
          </div>
        </SettingsSection>
      </div>
    );
  }

  return (
    <>
      {problem === null ? null : (
        <Alert status="danger" role="alert" className="mb-6">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{problem}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {issued === null ? null : (
        <SettingsSection title={t('settings.localHarnesses.secretSection')}>
          <div className="space-y-4 px-4 py-4" data-connector-issued={issued.connectorId}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-footnote font-medium text-foreground">
                  {t('settings.localHarnesses.secretTitle', { name: issued.connectorName })}
                </div>
                <p className="mt-1 text-caption leading-[17px] text-muted">
                  {t('settings.localHarnesses.secretWarning')}
                </p>
              </div>
              <Button size="sm" variant="ghost" onPress={onDismissIssued}>
                {t('settings.localHarnesses.dismissSecret')}
              </Button>
            </div>

            <div
              data-connector-secret-box
              className="flex flex-wrap items-center gap-2 rounded-lg border border-separator bg-field px-3 py-2"
            >
              <code dir="ltr" className="min-w-0 flex-1 break-all font-mono text-caption text-foreground">
                {revealSecret ? issued.secret : maskSecret(issued.secret)}
              </code>
              <Button
                size="sm"
                variant="secondary"
                onPress={() => setRevealSecret((prev) => !prev)}
              >
                {revealSecret
                  ? t('settings.localHarnesses.hideToken')
                  : t('settings.localHarnesses.showToken')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onPress={() => handleCopy('token', issued.secret)}
              >
                {copiedField === 'token'
                  ? t('settings.localHarnesses.copied')
                  : t('settings.localHarnesses.copyToken')}
              </Button>
            </div>

            <div className="space-y-1.5">
              <div className="text-caption font-medium text-foreground">
                {t('settings.localHarnesses.commandLabel')}
              </div>
              <div
                data-connector-launch-command
                className="flex flex-wrap items-center gap-2 rounded-lg border border-separator bg-field px-3 py-2"
              >
                <code dir="ltr" className="min-w-0 flex-1 break-all font-mono text-caption text-foreground">
                  {launchCommand}
                </code>
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => handleCopy('command', launchCommand)}
                >
                  {copiedField === 'command'
                    ? t('settings.localHarnesses.copied')
                    : t('settings.localHarnesses.copyCommand')}
                </Button>
              </div>
              <p className="text-caption leading-[17px] text-muted">
                {t('settings.localHarnesses.commandHint')}
              </p>
            </div>
          </div>
        </SettingsSection>
      )}

      <SettingsSection title={t('settings.localHarnesses.listTitle')}>
        {connectors.length === 0 ? (
          <SettingsRow
            label={t('settings.localHarnesses.emptyTitle')}
            description={t('settings.localHarnesses.emptyBody')}
            control={
              adding ? undefined : (
                <Button size="sm" variant="primary" onPress={() => setAdding(true)}>
                  {t('settings.localHarnesses.connectAction')}
                </Button>
              )
            }
          />
        ) : (
          <div className="divide-y divide-separator">
            {connectors.map((connector) => {
              const isBusy = busyId === connector.id;
              const isConfirming = confirmRemoveId === connector.id;
              const statusColor =
                connector.status === 'ONLINE'
                  ? connector.busy
                    ? 'warning'
                    : 'success'
                  : 'default';
              const statusLabel =
                connector.status === 'ONLINE'
                  ? connector.busy
                    ? t('settings.localHarnesses.status.busy')
                    : t('settings.localHarnesses.status.online')
                  : t('settings.localHarnesses.status.offline');
              const reportLabel =
                connector.reportMode === 'full'
                  ? t('settings.localHarnesses.reportMode.full')
                  : t('settings.localHarnesses.reportMode.summary');
              const harnessesLabel =
                connector.harnesses.length > 0
                  ? t('settings.localHarnesses.harnessesLine', {
                      harnesses: connector.harnesses.join(', '),
                    })
                  : t('settings.localHarnesses.noHarnesses');
              return (
                <div
                  key={connector.id}
                  data-local-connector={connector.id}
                  className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-footnote font-medium text-foreground">
                        {connector.name}
                      </span>
                      <Chip size="sm" color={statusColor} variant="soft">
                        {statusLabel}
                      </Chip>
                      <Chip size="sm" color="default" variant="secondary">
                        {reportLabel}
                      </Chip>
                    </div>
                    <div className="text-caption text-muted">
                      {connector.workspaceName ?? t('settings.localHarnesses.workspaceWaiting')}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-muted">
                      <span>{harnessesLabel}</span>
                      <span className="font-mono">
                        {t('settings.localHarnesses.tokenPrefix', {
                          prefix: connector.tokenPrefix,
                        })}
                      </span>
                      {connector.lastSeenAt === null ? null : (
                        <span className="tabular-nums">
                          {t('settings.localHarnesses.lastSeen', {
                            when: formatLastSeen(connector.lastSeenAt),
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      isDisabled={isBusy}
                      onPress={() => onRotate(connector)}
                    >
                      {isBusy
                        ? t('settings.localHarnesses.rotating')
                        : t('settings.localHarnesses.rotate')}
                    </Button>
                    {isConfirming ? (
                      <>
                        <Button
                          size="sm"
                          variant="danger"
                          isDisabled={isBusy}
                          onPress={() => {
                            setConfirmRemoveId(null);
                            onRemove(connector);
                          }}
                        >
                          {isBusy
                            ? t('settings.localHarnesses.removing')
                            : t('settings.localHarnesses.confirmRemove')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          isDisabled={isBusy}
                          onPress={() => setConfirmRemoveId(null)}
                        >
                          {t('settings.localHarnesses.cancel')}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        isDisabled={isBusy}
                        onPress={() => setConfirmRemoveId(connector.id)}
                      >
                        {t('settings.localHarnesses.remove')}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            {adding ? null : (
              <div className="px-4 py-3">
                <Button size="sm" variant="primary" onPress={() => setAdding(true)}>
                  {t('settings.localHarnesses.connectAction')}
                </Button>
              </div>
            )}
          </div>
        )}

        {adding ? (
          <form onSubmit={submitCreate} className="border-t border-separator">
            <SettingsRow
              htmlFor="new-local-connector-name"
              label={t('settings.localHarnesses.nameLabel')}
              stacked
              control={
                <div className="space-y-2">
                  <Input
                    id="new-local-connector-name"
                    variant="secondary"
                    value={draftName}
                    placeholder={t('settings.localHarnesses.namePlaceholder')}
                    onChange={(event) => setDraftName(event.target.value)}
                  />
                  {nameError === null ? null : (
                    <p role="alert" className="text-caption text-danger">
                      {nameError}
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <Button type="submit" size="sm" variant="primary" isDisabled={creating}>
                      {creating
                        ? t('settings.localHarnesses.creating')
                        : t('settings.localHarnesses.create')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={creating}
                      onPress={() => {
                        setAdding(false);
                        setNameError(null);
                      }}
                    >
                      {t('settings.localHarnesses.cancel')}
                    </Button>
                  </div>
                </div>
              }
            />
          </form>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t('settings.localHarnesses.boundaryTitle')}>
        <div className="space-y-2.5 px-4 py-3.5 text-caption leading-[18px] text-muted" data-local-harnesses-boundary>
          <p>{t('settings.localHarnesses.boundaryLocation')}</p>
          <p>{t('settings.localHarnesses.boundaryPermissions')}</p>
          <p>{t('settings.localHarnesses.boundarySummary')}</p>
        </div>
      </SettingsSection>
    </>
  );
}
