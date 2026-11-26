import { Alert, Button, Checkbox, Chip, Input, Skeleton, Spinner, Tooltip } from '@heroui/react';
import {
  IconFolder,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconTerminal2,
} from '@tabler/icons-react';
import type { LocalConnectorReportMode, LocalConnectorView } from '@crewaid/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  LocalHarnessProbeItem,
  ManagedConnectorActionResult,
  ManagedConnectorView,
} from '../../preload';
import { failureOf } from '../api/apiError';
import {
  createConnector,
  listConnectors,
  removeConnector,
  rotateConnectorSecret,
} from '../api/connectors';
import { useApiClient } from '../api/useApiClient';
import { credentialsProvider, localConnectorBridge } from '../bridge';
import { Segment } from '../components/ui';
import { currentLocale, t as translate, useT } from '../i18n/i18n';
import { SettingsRow, SettingsSection } from './SettingsLayout';

export interface IssuedConnectorSecret {
  readonly connectorId: string;
  readonly connectorName: string;
  readonly secret: string;
}

export interface PickedFolderDraft {
  readonly directory: string;
  readonly name: string;
}

const DEFAULT_SERVER_PLACEHOLDER = 'https://your-crewaid-host';

/**
 * Builds the copyable terminal command for connecting another machine via CLI,
 * omitting the bearer token so secrets never enter shell history.
 */
export function buildConnectorLaunchCommand(serverUrl: string | null): string {
  const clean =
    serverUrl !== null && serverUrl.trim() !== ''
      ? serverUrl.trim().replace(/\/+$/, '')
      : DEFAULT_SERVER_PLACEHOLDER;
  return `npx crewaid-connect --url ${clean}`;
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

function describeManagedError(error: string | undefined): string | null {
  if (error === undefined || error.trim() === '') return null;
  if (error === 'NO_HARNESSES_FOUND') {
    return translate('settings.localHarnesses.error.noHarnesses');
  }
  return error;
}

function describeActionFailure(result: Extract<ManagedConnectorActionResult, { status: 'error' }>): string {
  switch (result.code) {
    case 'ENCRYPTION_UNAVAILABLE':
      return translate('settings.localHarnesses.error.encryptionUnavailable');
    case 'INVALID_DIRECTORY':
      return translate('settings.localHarnesses.error.invalidDirectory');
    default:
      return result.message ?? translate('settings.localHarnesses.error.generic');
  }
}

export function LocalHarnessesPane({
  connectorsVersion = 0,
}: {
  readonly connectorsVersion?: number | undefined;
}) {
  const client = useApiClient();
  const desktopSupported = localConnectorBridge.isSupported();
  const [connectors, setConnectors] = useState<readonly LocalConnectorView[] | null>(null);
  const [managed, setManaged] = useState<readonly ManagedConnectorView[]>([]);
  const [detectedHarnesses, setDetectedHarnesses] = useState<
    readonly LocalHarnessProbeItem[] | null
  >(null);
  const [refreshingHarnesses, setRefreshingHarnesses] = useState(false);
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

  const refreshDetected = useCallback(
    async (forceRefresh = false) => {
      if (!desktopSupported) return;
      setRefreshingHarnesses(true);
      try {
        const res = await localConnectorBridge.detectHarnesses(forceRefresh);
        if (res.status === 'ok') setDetectedHarnesses(res.harnesses);
      } finally {
        setRefreshingHarnesses(false);
      }
    },
    [desktopSupported],
  );

  useEffect(() => {
    if (!desktopSupported) return;
    let active = true;
    void refreshDetected(false);
    void localConnectorBridge.list().then((res) => {
      if (active && res.status === 'ok') setManaged(res.connectors);
    });
    const unsubscribe = localConnectorBridge.onStateChanged((next) => {
      if (active) setManaged(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [desktopSupported, refreshDetected]);

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

  const handlePickFolder = useCallback(async (): Promise<PickedFolderDraft | null> => {
    if (!desktopSupported) return null;
    const picked = await localConnectorBridge.pickFolder();
    if (picked.status !== 'selected') return null;
    return { directory: picked.directory, name: picked.name };
  }, [desktopSupported]);

  const handlePairFolder = useCallback(
    async (draft: {
      readonly directory: string;
      readonly name: string;
      readonly reportMode: LocalConnectorReportMode;
      readonly confirmInApp: boolean;
    }): Promise<boolean> => {
      if (serverUrl === null || serverUrl.trim() === '') {
        setProblem(translate('settings.localHarnesses.error.generic'));
        return false;
      }
      setCreating(true);
      setProblem(null);
      try {
        const created = await createConnector(client, { name: draft.name });
        const paired = await localConnectorBridge.pair({
          connectorId: created.connector.id,
          name: created.connector.name,
          directory: draft.directory,
          serverUrl,
          token: created.secret,
          reportMode: draft.reportMode,
          confirmInApp: draft.confirmInApp,
        });
        if (paired.status !== 'ok') {
          // Clean up the server connector if local pairing failed so no orphan stays behind.
          await removeConnector(client, created.connector.id).catch(() => undefined);
          setProblem(describeActionFailure(paired));
          return false;
        }
        await load();
        return true;
      } catch (error: unknown) {
        setProblem(failureOf(error).message);
        return false;
      } finally {
        setCreating(false);
      }
    },
    [client, load, serverUrl],
  );

  const handleCreateCli = useCallback(
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

  const handleToggleManaged = useCallback(
    async (entry: ManagedConnectorView) => {
      setBusyId(entry.connectorId);
      setProblem(null);
      try {
        const running =
          entry.state === 'online' ||
          entry.state === 'busy' ||
          entry.state === 'starting' ||
          entry.state === 'reconnecting';
        const res = running
          ? await localConnectorBridge.pause(entry.connectorId)
          : await localConnectorBridge.start(entry.connectorId);
        if (res.status !== 'ok') {
          setProblem(describeActionFailure(res));
        }
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const handleRotate = useCallback(
    async (connector: LocalConnectorView) => {
      setBusyId(connector.id);
      setProblem(null);
      try {
        const rotated = await rotateConnectorSecret(client, connector.id);
        const isManaged = managed.some((m) => m.connectorId === connector.id);
        if (isManaged) {
          const updated = await localConnectorBridge.update({
            connectorId: connector.id,
            token: rotated.secret,
          });
          if (updated.status !== 'ok') {
            setProblem(describeActionFailure(updated));
          }
        } else {
          setIssued({
            connectorId: rotated.connector.id,
            connectorName: rotated.connector.name,
            secret: rotated.secret,
          });
        }
        await load();
      } catch (error: unknown) {
        setProblem(failureOf(error).message);
      } finally {
        setBusyId(null);
      }
    },
    [client, load, managed],
  );

  const handleRemove = useCallback(
    async (connector: LocalConnectorView) => {
      setBusyId(connector.id);
      setProblem(null);
      try {
        if (desktopSupported && managed.some((m) => m.connectorId === connector.id)) {
          await localConnectorBridge.unpair(connector.id);
        }
        await removeConnector(client, connector.id);
        setIssued((current) => (current?.connectorId === connector.id ? null : current));
        await load();
      } catch (error: unknown) {
        setProblem(failureOf(error).message);
      } finally {
        setBusyId(null);
      }
    },
    [client, desktopSupported, load, managed],
  );

  return (
    <LocalHarnessesView
      connectors={connectors}
      managed={managed}
      detectedHarnesses={detectedHarnesses}
      refreshingHarnesses={refreshingHarnesses}
      desktopSupported={desktopSupported}
      serverUrl={serverUrl}
      problem={problem}
      issued={issued}
      busyId={busyId}
      creating={creating}
      onRefreshHarnesses={() => void refreshDetected(true)}
      onPickFolder={handlePickFolder}
      onPairFolder={handlePairFolder}
      onToggleManaged={(entry) => void handleToggleManaged(entry)}
      onCreate={handleCreateCli}
      onRotate={(connector) => void handleRotate(connector)}
      onRemove={(connector) => void handleRemove(connector)}
      onDismissIssued={() => setIssued(null)}
    />
  );
}

export interface LocalHarnessesViewProps {
  readonly connectors: readonly LocalConnectorView[] | null;
  readonly managed?: readonly ManagedConnectorView[];
  readonly detectedHarnesses?: readonly LocalHarnessProbeItem[] | null;
  readonly refreshingHarnesses?: boolean;
  readonly desktopSupported?: boolean;
  readonly serverUrl: string | null;
  readonly problem: string | null;
  readonly issued: IssuedConnectorSecret | null;
  readonly busyId: string | null;
  readonly creating: boolean;
  readonly onRefreshHarnesses?: () => void;
  readonly onPickFolder?: () => Promise<PickedFolderDraft | null>;
  readonly onPairFolder?: (draft: {
    readonly directory: string;
    readonly name: string;
    readonly reportMode: LocalConnectorReportMode;
    readonly confirmInApp: boolean;
  }) => Promise<boolean>;
  readonly onToggleManaged?: (entry: ManagedConnectorView) => void;
  readonly onCreate: (name: string) => Promise<boolean>;
  readonly onRotate: (connector: LocalConnectorView) => void;
  readonly onRemove: (connector: LocalConnectorView) => void;
  readonly onDismissIssued: () => void;
}

/** Presentational view so every connector state can be unit-tested statically. */
export function LocalHarnessesView({
  connectors,
  managed = [],
  detectedHarnesses = null,
  refreshingHarnesses = false,
  desktopSupported = false,
  serverUrl,
  problem,
  issued,
  busyId,
  creating,
  onRefreshHarnesses,
  onPickFolder,
  onPairFolder,
  onToggleManaged,
  onCreate,
  onRotate,
  onRemove,
  onDismissIssued,
}: LocalHarnessesViewProps) {
  const t = useT();
  const [pickedFolder, setPickedFolder] = useState<PickedFolderDraft | null>(null);
  const [pairName, setPairName] = useState('');
  const [pairReportMode, setPairReportMode] = useState<LocalConnectorReportMode>('summary');
  const [pairConfirmInApp, setPairConfirmInApp] = useState(true);
  const [pairNameError, setPairNameError] = useState<string | null>(null);

  const [addingCli, setAddingCli] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [revealSecret, setRevealSecret] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const launchCommand = buildConnectorLaunchCommand(serverUrl);
  const managedById = new Map(managed.map((entry) => [entry.connectorId, entry]));
  const availableHarnessesCount =
    detectedHarnesses === null
      ? null
      : detectedHarnesses.filter((item) => item.available).length;

  const handleCopy = (field: string, value: string) => {
    void copyText(value).then((ok) => {
      if (!ok) return;
      setCopiedField(field);
      setTimeout(() => {
        setCopiedField((cur) => (cur === field ? null : cur));
      }, 2_000);
    });
  };

  const startPickFolder = () => {
    if (!desktopSupported || onPickFolder === undefined) {
      setAddingCli(true);
      return;
    }
    void onPickFolder().then((picked) => {
      if (picked === null) return;
      setPickedFolder(picked);
      setPairName(picked.name);
      setPairNameError(null);
      setAddingCli(false);
    });
  };

  const submitPairFolder = (event: FormEvent) => {
    event.preventDefault();
    if (pickedFolder === null || onPairFolder === undefined) return;
    const trimmed = pairName.trim();
    if (trimmed === '') {
      setPairNameError(t('settings.localHarnesses.nameRequired'));
      return;
    }
    setPairNameError(null);
    void onPairFolder({
      directory: pickedFolder.directory,
      name: trimmed,
      reportMode: pairReportMode,
      confirmInApp: pairConfirmInApp,
    }).then((ok) => {
      if (ok) {
        setPickedFolder(null);
        setPairName('');
      }
    });
  };

  const submitCreateCli = (event: FormEvent) => {
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
        setAddingCli(false);
        setRevealSecret(false);
      }
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

      {detectedHarnesses === null ? null : (
        <section className="crewaid-settings-section mb-6" data-local-harnesses-detected>
          <div className="mb-2 flex items-center justify-between px-1">
            <h3 className="text-caption font-medium text-muted">
              {t('settings.localHarnesses.detectedTitle')}
            </h3>
            {onRefreshHarnesses === undefined ? null : (
              <Button
                size="sm"
                variant="ghost"
                isDisabled={refreshingHarnesses}
                onPress={onRefreshHarnesses}
                className="h-7 gap-1 px-2 text-caption text-muted"
              >
                <IconRefresh className="size-3.5" stroke={1.8} aria-hidden />
                {t('settings.localHarnesses.refreshHarnesses')}
              </Button>
            )}
          </div>
          <div className="crewaid-settings-surface divide-y divide-separator overflow-hidden rounded-card bg-surface-secondary">
            {detectedHarnesses.map((harness) => (
              <div
                key={harness.id}
                data-detected-harness={harness.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-footnote font-medium text-foreground">
                      {harness.label}
                    </span>
                    <Chip
                      size="sm"
                      variant="soft"
                      color={harness.available ? 'success' : 'default'}
                    >
                      {harness.available
                        ? t('settings.localHarnesses.harnessReady')
                        : t('settings.localHarnesses.harnessMissing')}
                    </Chip>
                  </div>
                  {harness.available ? null : harness.installCommand !== null ? (
                    <code
                      dir="ltr"
                      className="mt-1 block truncate font-mono text-caption text-muted"
                    >
                      {harness.installCommand}
                    </code>
                  ) : (
                    <p className="mt-1 text-caption leading-[17px] text-muted">
                      {harness.installHint}
                    </p>
                  )}
                </div>
                {harness.available ? null : harness.installCommand !== null ? (
                  <Tooltip delay={200}>
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() =>
                        handleCopy(
                          `install:${harness.id}`,
                          harness.installCommand ?? harness.installHint,
                        )
                      }
                    >
                      {copiedField === `install:${harness.id}`
                        ? t('settings.localHarnesses.copied')
                        : t('settings.localHarnesses.copyInstall')}
                    </Button>
                    <Tooltip.Content placement="top" className="max-w-xs">
                      {t('settings.localHarnesses.copyInstallTooltip', {
                        harness: harness.label,
                      })}
                    </Tooltip.Content>
                  </Tooltip>
                ) : (
                  <Tooltip delay={200}>
                    <Tooltip.Trigger>
                      <span
                        tabIndex={0}
                        aria-label={harness.installHint}
                        data-disabled-install-tooltip={harness.id}
                        className="inline-flex cursor-not-allowed"
                      >
                        <Button
                          size="sm"
                          variant="secondary"
                          isDisabled
                          className="pointer-events-none"
                        >
                          {t('settings.localHarnesses.installAction')}
                        </Button>
                      </span>
                    </Tooltip.Trigger>
                    <Tooltip.Content placement="top" className="max-w-xs">
                      {harness.installHint}
                    </Tooltip.Content>
                  </Tooltip>
                )}
              </div>
            ))}
          </div>
          {availableHarnessesCount === 0 ? (
            <Alert status="warning" className="mt-3">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>
                  {t('settings.localHarnesses.noHarnessesInstalled')}
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}
        </section>
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
              <code
                dir="ltr"
                className="min-w-0 flex-1 break-all font-mono text-caption text-foreground"
              >
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
                <code
                  dir="ltr"
                  className="min-w-0 flex-1 break-all font-mono text-caption text-foreground"
                >
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
              pickedFolder !== null || addingCli ? undefined : (
                <Button
                  size="sm"
                  variant="primary"
                  isDisabled={availableHarnessesCount === 0}
                  onPress={startPickFolder}
                >
                  <IconFolder className="size-4" stroke={1.8} aria-hidden />
                  {t('settings.localHarnesses.connectAction')}
                </Button>
              )
            }
          />
        ) : (
          <div className="divide-y divide-separator">
            {connectors.map((connector) => {
              const local = managedById.get(connector.id);
              const isBusy = busyId === connector.id;
              const isConfirming = confirmRemoveId === connector.id;

              const isStarting = local?.state === 'starting' || local?.state === 'reconnecting';
              const isPaused = local?.state === 'paused';
              const isError = local?.state === 'error';
              const isOnline =
                connector.status === 'ONLINE' || local?.state === 'online' || local?.state === 'busy';
              const isRunningTask = connector.busy || local?.state === 'busy';

              const statusColor = isOnline
                ? isRunningTask
                  ? 'warning'
                  : 'success'
                : isError
                  ? 'danger'
                  : 'default';
              const statusLabel = isOnline
                ? isRunningTask
                  ? t('settings.localHarnesses.status.busy')
                  : t('settings.localHarnesses.status.online')
                : isStarting
                  ? t('settings.localHarnesses.status.connecting')
                  : isPaused
                    ? t('settings.localHarnesses.status.paused')
                    : isError
                      ? t('settings.localHarnesses.status.error')
                      : t('settings.localHarnesses.status.offline');

              const effectiveReportMode = local?.reportMode ?? connector.reportMode;
              const reportLabel =
                effectiveReportMode === 'full'
                  ? t('settings.localHarnesses.reportMode.full')
                  : t('settings.localHarnesses.reportMode.summary');
              const effectiveHarnesses =
                connector.harnesses.length > 0 ? connector.harnesses : (local?.harnesses ?? []);
              const harnessesLabel =
                effectiveHarnesses.length > 0
                  ? t('settings.localHarnesses.harnessesLine', {
                      harnesses: effectiveHarnesses.join(', '),
                    })
                  : t('settings.localHarnesses.noHarnesses');
              const managedErrorText = describeManagedError(local?.error);
              const isManagedActive =
                local !== undefined &&
                (local.state === 'online' ||
                  local.state === 'busy' ||
                  local.state === 'starting' ||
                  local.state === 'reconnecting');

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
                        {isStarting ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Spinner size="sm" />
                            {statusLabel}
                          </span>
                        ) : (
                          statusLabel
                        )}
                      </Chip>
                      {local === undefined ? null : (
                        <Chip size="sm" color="default" variant="soft">
                          {t('settings.localHarnesses.thisComputer')}
                        </Chip>
                      )}
                      <Chip size="sm" color="default" variant="secondary">
                        {reportLabel}
                      </Chip>
                    </div>

                    <div className="truncate text-caption text-muted" dir={local ? 'ltr' : undefined}>
                      {local?.directory ??
                        connector.workspaceName ??
                        t('settings.localHarnesses.workspaceWaiting')}
                    </div>

                    {managedErrorText === null ? null : (
                      <p role="alert" className="text-caption leading-[17px] text-danger">
                        {managedErrorText}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-muted">
                      <span>{harnessesLabel}</span>
                      {local === undefined ? (
                        <span className="font-mono">
                          {t('settings.localHarnesses.tokenPrefix', {
                            prefix: connector.tokenPrefix,
                          })}
                        </span>
                      ) : null}
                      {local === undefined && connector.lastSeenAt !== null ? (
                        <span className="tabular-nums">
                          {t('settings.localHarnesses.lastSeen', {
                            when: formatLastSeen(connector.lastSeenAt),
                          })}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {local !== undefined && onToggleManaged !== undefined ? (
                      <Button
                        size="sm"
                        variant={isManagedActive ? 'secondary' : 'primary'}
                        isDisabled={isBusy}
                        onPress={() => onToggleManaged(local)}
                      >
                        {isManagedActive ? (
                          <>
                            <IconPlayerPause className="size-3.5" stroke={1.8} aria-hidden />
                            {t('settings.localHarnesses.pause')}
                          </>
                        ) : (
                          <>
                            <IconPlayerPlay className="size-3.5" stroke={1.8} aria-hidden />
                            {t('settings.localHarnesses.resume')}
                          </>
                        )}
                      </Button>
                    ) : null}
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
            {pickedFolder !== null || addingCli ? null : (
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <Button
                  size="sm"
                  variant="primary"
                  isDisabled={availableHarnessesCount === 0}
                  onPress={startPickFolder}
                >
                  <IconFolder className="size-4" stroke={1.8} aria-hidden />
                  {t('settings.localHarnesses.connectAction')}
                </Button>
                {desktopSupported ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => setAddingCli(true)}
                    className="gap-1.5 text-muted"
                  >
                    <IconTerminal2 className="size-3.5" stroke={1.8} aria-hidden />
                    {t('settings.localHarnesses.connectAnotherMachine')}
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        )}

        {connectors.length === 0 && desktopSupported && pickedFolder === null && !addingCli ? (
          <div className="border-t border-separator px-4 py-2.5">
            <Button
              size="sm"
              variant="ghost"
              onPress={() => setAddingCli(true)}
              className="gap-1.5 text-muted"
            >
              <IconTerminal2 className="size-3.5" stroke={1.8} aria-hidden />
              {t('settings.localHarnesses.connectAnotherMachine')}
            </Button>
          </div>
        ) : null}

        {pickedFolder === null ? null : (
          <form
            onSubmit={submitPairFolder}
            data-local-folder-pair-form
            className="space-y-4 border-t border-separator px-4 py-4"
          >
            <div className="flex items-center justify-between gap-3 rounded-lg bg-field px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <IconFolder className="size-4 shrink-0 text-muted" stroke={1.8} aria-hidden />
                <span className="truncate font-mono text-caption text-foreground" dir="ltr">
                  {pickedFolder.directory}
                </span>
              </div>
              <Button size="sm" variant="secondary" onPress={startPickFolder}>
                {t('settings.localHarnesses.changeFolder')}
              </Button>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="pair-local-folder-name"
                className="block text-caption font-medium text-foreground"
              >
                {t('settings.localHarnesses.nameLabel')}
              </label>
              <Input
                id="pair-local-folder-name"
                variant="secondary"
                value={pairName}
                placeholder={t('settings.localHarnesses.namePlaceholder')}
                onChange={(event) => setPairName(event.target.value)}
              />
              {pairNameError === null ? null : (
                <p role="alert" className="text-caption text-danger">
                  {pairNameError}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="text-caption font-medium text-foreground">
                {t('settings.localHarnesses.reportLabel')}
              </div>
              <Segment
                size="sm"
                aria-label={t('settings.localHarnesses.reportLabel')}
                selectedKey={pairReportMode}
                onSelectionChange={(key) => {
                  if (key === 'summary' || key === 'full') setPairReportMode(key);
                }}
              >
                <Segment.Item id="summary">
                  {t('settings.localHarnesses.reportMode.summary')}
                </Segment.Item>
                <Segment.Item id="full">
                  {t('settings.localHarnesses.reportMode.full')}
                </Segment.Item>
              </Segment>
              <p className="text-caption leading-[17px] text-muted">
                {pairReportMode === 'full'
                  ? t('settings.localHarnesses.reportFullHint')
                  : t('settings.localHarnesses.reportSummaryHint')}
              </p>
            </div>

            <Checkbox
              isSelected={pairConfirmInApp}
              onChange={setPairConfirmInApp}
              className="items-start"
            >
              <Checkbox.Content className="flex items-start gap-2.5">
                <Checkbox.Control className="mt-0.5 shrink-0">
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <span className="flex flex-col gap-0.5">
                  <span className="text-footnote font-medium text-foreground">
                    {t('settings.localHarnesses.confirmInAppLabel')}
                  </span>
                  <span className="text-caption leading-[17px] text-muted">
                    {t('settings.localHarnesses.confirmInAppHint')}
                  </span>
                </span>
              </Checkbox.Content>
            </Checkbox>

            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" variant="primary" isDisabled={creating}>
                {creating
                  ? t('settings.localHarnesses.connectingFolder')
                  : t('settings.localHarnesses.connectFolder')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                isDisabled={creating}
                onPress={() => {
                  setPickedFolder(null);
                  setPairNameError(null);
                }}
              >
                {t('settings.localHarnesses.cancel')}
              </Button>
            </div>
          </form>
        )}

        {addingCli ? (
          <form onSubmit={submitCreateCli} className="border-t border-separator">
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
                        setAddingCli(false);
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
        <div
          className="space-y-2.5 px-4 py-3.5 text-caption leading-[18px] text-muted"
          data-local-harnesses-boundary
        >
          <p>{t('settings.localHarnesses.boundaryLocation')}</p>
          <p>{t('settings.localHarnesses.boundaryPermissions')}</p>
          <p>{t('settings.localHarnesses.boundarySummary')}</p>
        </div>
      </SettingsSection>
    </>
  );
}
