import { Alert, Button, Modal, Skeleton, Spinner, useOverlayState } from '@heroui/react';
import {
  COMPUTER_BUSY_CODE,
  SNAPSHOT_UNAVAILABLE_CODE,
  type ComputerSnapshotStatusResponse,
} from '@crewaid/shared';
import { useCallback, useEffect, useState } from 'react';
import { bodyCode, failureOf } from '../api/apiError';
import {
  getComputerSnapshot,
  restoreComputerSnapshot,
  saveComputerSnapshot,
} from '../api/computer';
import { useApiClient } from '../api/useApiClient';
import { currentLocale, t as translate, useT } from '../i18n/i18n';
import { SettingsRow, SettingsSection } from './SettingsLayout';

/** How often the pane reads the status again while a save or restore runs. */
const POLL_MS = 2_000;

/**
 * Computer — the one saved copy of the person's computer.
 *
 * Saving and restoring run on the server after it answers, so the pane reads
 * the status again every couple of seconds while either is under way rather
 * than holding a request open for minutes.
 */
export function ComputerPane() {
  const client = useApiClient();
  const [status, setStatus] = useState<ComputerSnapshotStatusResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const seen = await getComputerSnapshot(client, signal);
        if (signal?.aborted) return;
        setStatus(seen);
        setLoadProblem(null);
      } catch (error: unknown) {
        if (!signal?.aborted) setLoadProblem(failureOf(error).message);
      }
    },
    [client],
  );

  useEffect(() => {
    const request = new AbortController();
    void load(request.signal);
    return () => request.abort();
  }, [load]);

  const working = status?.activity !== null && status?.activity !== undefined;
  useEffect(() => {
    if (!working) return;
    const request = new AbortController();
    async function poll() {
      await load(request.signal);
      if (!request.signal.aborted) timer = setTimeout(() => void poll(), POLL_MS);
    }
    let timer = setTimeout(() => void poll(), POLL_MS);
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [working, load]);

  const act = useCallback(
    async (request: () => Promise<ComputerSnapshotStatusResponse>) => {
      setBusy(true);
      setProblem(null);
      try {
        setStatus(await request());
      } catch (error) {
        const failure = failureOf(error);
        const code = bodyCode(failure.detail);
        if (failure.code === 'CONFLICT' && code === COMPUTER_BUSY_CODE) {
          setProblem(translate('settings.computer.busy'));
        } else if (failure.code === 'CONFLICT' && code === SNAPSHOT_UNAVAILABLE_CODE) {
          setProblem(translate('api.apiError.thatIsNoLongerAvailable'));
        } else {
          setProblem(failure.message);
        }
        if (failure.code === 'CONFLICT') await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  return (
    <ComputerView
      status={status}
      problem={problem ?? loadProblem}
      busy={busy}
      onSave={() => void act(() => saveComputerSnapshot(client))}
      onRestore={() => void act(() => restoreComputerSnapshot(client))}
    />
  );
}

export type ComputerViewProps = {
  readonly status: ComputerSnapshotStatusResponse | null;
  readonly problem: string | null;
  readonly busy: boolean;
  readonly onSave: () => void;
  readonly onRestore: () => void;
};

/** Presentational, so every snapshot state renders in a test without a server. */
export function ComputerView({ status, problem, busy, onSave, onRestore }: ComputerViewProps) {
  const t = useT();
  const [confirming, setConfirming] = useState<'save' | 'restore' | null>(null);
  const overlay = useOverlayState({
    isOpen: confirming !== null,
    onOpenChange: (open) => {
      if (!open) setConfirming(null);
    },
  });

  if (status === null) {
    if (problem !== null) {
      return (
        <SettingsSection title={t('settings.computer.snapshot')}>
          <SettingsRow label={problem} />
        </SettingsSection>
      );
    }
    return (
      <div aria-busy="true" aria-label={t('settings.computer.loading')}>
        <SettingsSection title={t('settings.computer.snapshot')}>
          <div className="space-y-2.5 px-4 py-4" aria-hidden="true">
            <Skeleton
              animationType="pulse"
              className="h-3.5 w-40 rounded-full motion-reduce:animate-none"
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

  if (!status.supported) {
    return (
      <SettingsSection title={t('settings.computer.snapshot')}>
        <SettingsRow
          label={t('settings.computer.unsupported')}
          description={t('settings.computer.unsupportedLine')}
        />
      </SettingsSection>
    );
  }

  const { snapshot, activity } = status;
  const disabled = busy || activity !== null;
  const saved =
    snapshot === null
      ? null
      : t('settings.computer.savedOn', {
          date: formatTakenAt(snapshot.takenAt),
          size: snapshot.sizeBytes === null ? '' : ` · ${formatSize(snapshot.sizeBytes)}`,
        });

  return (
    <>
      <SettingsSection title={t('settings.computer.snapshot')}>
        <SettingsRow
          label={snapshot === null ? t('settings.computer.none') : t('settings.computer.saved')}
          description={
            <span className="tabular-nums">{saved ?? t('settings.computer.noneLine')}</span>
          }
          control={
            activity === null ? (
              <div className="flex items-center gap-2">
                {snapshot === null ? null : (
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={disabled}
                    onPress={() => setConfirming('restore')}
                  >
                    {t('settings.computer.restore')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={snapshot === null ? 'primary' : 'secondary'}
                  isDisabled={disabled}
                  onPress={() => (snapshot === null ? onSave() : setConfirming('save'))}
                >
                  {t('settings.computer.save')}
                </Button>
              </div>
            ) : (
              <span role="status" className="flex items-center gap-2 text-caption text-muted">
                <Spinner size="sm" />
                {activity === 'SAVING'
                  ? t('settings.computer.saving')
                  : t('settings.computer.restoring')}
              </span>
            )
          }
        />
        <div className="px-4 py-3 text-caption leading-[17px] text-muted">
          {t('settings.computer.explainer')}
        </div>
      </SettingsSection>

      {status.lastError === null ? null : (
        <Alert status="danger" role="alert" className="mb-6">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              {status.lastError === 'SAVE_FAILED'
                ? t('settings.computer.saveFailed')
                : t('settings.computer.restoreFailed')}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {problem === null ? null : (
        <Alert status="danger" role="alert" className="mb-6">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{problem}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      <Modal state={overlay}>
        <Modal.Backdrop>
          <Modal.Container size="sm" placement="center">
            <Modal.Dialog
              aria-label={
                confirming === 'restore'
                  ? t('settings.computer.restoreTitle')
                  : t('settings.computer.replaceTitle')
              }
            >
              <Modal.Header>
                <Modal.Heading>
                  {confirming === 'restore'
                    ? t('settings.computer.restoreTitle')
                    : t('settings.computer.replaceTitle')}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <p className="text-footnote leading-[18px] text-muted">
                  {confirming === 'restore'
                    ? t('settings.computer.restoreConsequence', {
                        date: snapshot === null ? '' : formatTakenAt(snapshot.takenAt),
                      })
                    : t('settings.computer.replaceConsequence')}
                </p>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="tertiary" size="sm" onPress={() => setConfirming(null)}>
                  {t('settings.computer.cancel')}
                </Button>
                <Button
                  variant={confirming === 'restore' ? 'danger' : 'primary'}
                  size="sm"
                  onPress={() => {
                    const chosen = confirming;
                    setConfirming(null);
                    if (chosen === 'restore') onRestore();
                    if (chosen === 'save') onSave();
                  }}
                >
                  {confirming === 'restore'
                    ? t('settings.computer.restoreConfirm')
                    : t('settings.computer.replaceConfirm')}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}

function formatTakenAt(iso: string): string {
  return new Date(iso).toLocaleString(currentLocale(), {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatSize(bytes: number): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(currentLocale(), {
    style: 'unit',
    unit: units[unit],
    unitDisplay: 'short',
    maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0,
  }).format(value);
}
