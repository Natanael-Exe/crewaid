import { realpathSync, statSync } from 'node:fs';
import type { LocalConnectorHarnessId, LocalConnectorReportMode } from '@crewaid/shared';
import type { LocalConnectorStore, StoredLocalConnector } from './localConnectorStore.js';
import {
  type LocalConnectorPromptEvent,
  type LocalConnectorPromptResponse,
  type LocalHarnessDetectionResult,
  type LocalPermissionOptionView,
  type ManagedConnectorActionResult,
  type ManagedConnectorRuntimeState,
  type ManagedConnectorView,
  type ManagedConnectorsListResult,
  type PickFolderResult,
} from './localConnectorTypes.js';
import { detectLocalHarnesses, resolveShellEnvironment } from './shellEnvironment.js';
import { guardedIpc, type TokenIpcMainLike } from './tokenStore.js';

/** Minimal handle matching Electron's `UtilityProcess` for clean unit testing. */
export interface ConnectorWorkerHandle {
  readonly postMessage: (message: unknown) => void;
  readonly onMessage: (listener: (message: unknown) => void) => void;
  readonly onExit: (listener: (code: number) => void) => void;
  readonly kill: () => boolean;
}

export interface LocalConnectorManagerOptions {
  readonly store: LocalConnectorStore;
  readonly workerPath: string;
  readonly appVersion: string;
  readonly forkWorker: (workerPath: string, env: NodeJS.ProcessEnv) => ConnectorWorkerHandle;
  readonly resolveEnv?: () => NodeJS.ProcessEnv;
  readonly validateDirectory?: (dir: string) => string | null;
  readonly onStateChanged?: (connectors: readonly ManagedConnectorView[]) => void;
  readonly onPromptChanged?: (prompt: LocalConnectorPromptEvent | null) => void;
  readonly onNotifyPrompt?: (title: string, body: string) => void;
}

export interface LocalConnectorManager {
  readonly detectHarnesses: (refresh?: boolean) => LocalHarnessDetectionResult;
  readonly list: () => ManagedConnectorsListResult;
  readonly pair: (raw: unknown) => ManagedConnectorActionResult;
  readonly start: (connectorId: unknown) => ManagedConnectorActionResult;
  readonly pause: (connectorId: unknown) => ManagedConnectorActionResult;
  readonly update: (raw: unknown) => ManagedConnectorActionResult;
  readonly unpair: (connectorId: unknown) => ManagedConnectorActionResult;
  readonly respondPrompt: (raw: unknown) => boolean;
  readonly currentPrompt: () => LocalConnectorPromptEvent | null;
  readonly startAutoConnect: () => void;
  readonly stopAll: () => void;
}

interface WorkerRuntime {
  readonly connectorId: string;
  readonly handle: ConnectorWorkerHandle;
  state: ManagedConnectorRuntimeState;
  harnesses: readonly LocalConnectorHarnessId[];
  error?: string;
}

interface QueuedPrompt {
  readonly connectorId: string;
  readonly event: LocalConnectorPromptEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultValidateDirectory(dir: string): string | null {
  try {
    const resolved = realpathSync(dir);
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function isValidServerUrl(raw: string): boolean {
  if (raw.trim() === '' || raw !== raw.trim()) return false;
  try {
    const parsed = new URL(raw);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

function isValidHarnessId(value: unknown): value is LocalConnectorHarnessId {
  return (
    value === 'claude-code' ||
    value === 'codex' ||
    value === 'opencode' ||
    value === 'antigravity' ||
    value === 'custom'
  );
}

function isValidReportMode(value: unknown): value is LocalConnectorReportMode {
  return value === 'summary' || value === 'full';
}

function parsePermissionOptions(raw: unknown): readonly LocalPermissionOptionView[] {
  if (!Array.isArray(raw)) return [];
  const out: LocalPermissionOptionView[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const optionId = item['optionId'];
    const name = item['name'];
    const kind = item['kind'];
    if (
      typeof optionId === 'string' &&
      typeof name === 'string' &&
      (kind === 'allow_once' ||
        kind === 'allow_always' ||
        kind === 'reject_once' ||
        kind === 'reject_always')
    ) {
      out.push({ optionId, name, kind });
    }
  }
  return out;
}

/**
 * Main-process supervisor for desktop-managed local connectors (D-242).
 *
 * Keeps Electron free of AI orchestration while giving users one-click local
 * folder pairing, `safeStorage`-encrypted tokens, login-shell harness
 * detection, automatic reconnect on launch, and in-app local permission
 * prompts routed from isolated `utilityProcess` workers.
 */
export function createLocalConnectorManager(
  options: LocalConnectorManagerOptions,
): LocalConnectorManager {
  const resolveEnvFn = options.resolveEnv ?? (() => resolveShellEnvironment());
  const validateDir = options.validateDirectory ?? defaultValidateDirectory;

  let cachedEnv: NodeJS.ProcessEnv | null = null;
  const runtimes = new Map<string, WorkerRuntime>();
  const lastErrors = new Map<string, string>();
  const lastHarnesses = new Map<string, readonly LocalConnectorHarnessId[]>();
  const promptQueue: QueuedPrompt[] = [];

  function getEnv(refresh = false): NodeJS.ProcessEnv {
    if (cachedEnv === null || refresh) {
      cachedEnv = resolveEnvFn();
    }
    return cachedEnv;
  }

  function toView(stored: StoredLocalConnector): ManagedConnectorView {
    const rt = runtimes.get(stored.connectorId);
    const harnesses = rt?.harnesses ?? lastHarnesses.get(stored.connectorId) ?? [];
    const error = rt?.error ?? lastErrors.get(stored.connectorId);
    const state: ManagedConnectorRuntimeState =
      rt !== undefined ? rt.state : error !== undefined ? 'error' : 'paused';
    return {
      connectorId: stored.connectorId,
      name: stored.name,
      directory: stored.directory,
      serverUrl: stored.serverUrl,
      reportMode: stored.reportMode,
      confirmInApp: stored.confirmInApp,
      autoStart: stored.autoStart,
      state,
      harnesses,
      ...(error === undefined ? {} : { error }),
    };
  }

  function broadcastState(): void {
    const listed = list();
    if (listed.status === 'ok') {
      options.onStateChanged?.(listed.connectors);
    }
  }

  function broadcastPrompt(): void {
    options.onPromptChanged?.(promptQueue[0]?.event ?? null);
  }

  function dropPromptsForConnector(connectorId: string): void {
    const hadHead = promptQueue[0]?.event.requestId;
    for (let i = promptQueue.length - 1; i >= 0; i -= 1) {
      if (promptQueue[i]?.connectorId === connectorId) {
        promptQueue.splice(i, 1);
      }
    }
    if (promptQueue[0]?.event.requestId !== hadHead) {
      broadcastPrompt();
    }
  }

  function removePromptById(requestId: string): QueuedPrompt | null {
    const idx = promptQueue.findIndex((item) => item.event.requestId === requestId);
    if (idx === -1) return null;
    const [removed] = promptQueue.splice(idx, 1);
    broadcastPrompt();
    return removed ?? null;
  }

  function stopWorker(connectorId: string): void {
    const rt = runtimes.get(connectorId);
    if (rt === undefined) return;
    runtimes.delete(connectorId);
    dropPromptsForConnector(connectorId);
    try {
      rt.handle.postMessage({ type: 'stop' });
    } catch {
      // Ignore postMessage failure on closing worker.
    }
    try {
      rt.handle.kill();
    } catch {
      // Ignore kill failure if already exited.
    }
  }

  function spawnWorker(entry: StoredLocalConnector): void {
    stopWorker(entry.connectorId);
    lastErrors.delete(entry.connectorId);

    const env = getEnv(false);
    const handle = options.forkWorker(options.workerPath, env);
    const runtime: WorkerRuntime = {
      connectorId: entry.connectorId,
      handle,
      state: 'starting',
      harnesses: lastHarnesses.get(entry.connectorId) ?? [],
    };
    runtimes.set(entry.connectorId, runtime);
    broadcastState();

    handle.onMessage((raw: unknown) => {
      if (runtimes.get(entry.connectorId) !== runtime) return;
      if (!isRecord(raw) || typeof raw['type'] !== 'string') return;

      switch (raw['type']) {
        case 'state': {
          const nextState = raw['state'];
          if (Array.isArray(raw['harnesses'])) {
            const harnesses = raw['harnesses'].filter(isValidHarnessId);
            runtime.harnesses = harnesses;
            lastHarnesses.set(entry.connectorId, harnesses);
          }
          if (
            nextState === 'connecting' ||
            nextState === 'online' ||
            nextState === 'busy' ||
            nextState === 'reconnecting'
          ) {
            runtime.state = nextState === 'connecting' ? 'starting' : nextState;
            delete runtime.error;
            lastErrors.delete(entry.connectorId);
          } else if (nextState === 'error') {
            const errMsg = typeof raw['error'] === 'string' ? raw['error'] : 'Connection error';
            runtime.state = 'error';
            runtime.error = errMsg;
            lastErrors.set(entry.connectorId, errMsg);
            if (raw['permanent'] === true) {
              runtimes.delete(entry.connectorId);
              dropPromptsForConnector(entry.connectorId);
            }
          } else if (nextState === 'stopped') {
            runtimes.delete(entry.connectorId);
            dropPromptsForConnector(entry.connectorId);
          }
          broadcastState();
          return;
        }
        case 'confirm_task': {
          const requestId = raw['requestId'];
          const req = raw['request'];
          if (typeof requestId !== 'string' || !isRecord(req)) return;
          const harness = req['harness'];
          const reportMode = req['reportMode'];
          if (
            typeof req['botName'] !== 'string' ||
            typeof req['workspaceName'] !== 'string' ||
            typeof req['relativeCwd'] !== 'string' ||
            typeof req['prompt'] !== 'string' ||
            !isValidHarnessId(harness) ||
            !isValidReportMode(reportMode)
          ) {
            return;
          }
          const verifyCommand =
            typeof req['verifyCommand'] === 'string' ? req['verifyCommand'] : undefined;
          const event: LocalConnectorPromptEvent = {
            kind: 'confirm_task',
            requestId,
            connectorId: entry.connectorId,
            connectorName: entry.name,
            botName: req['botName'],
            workspaceName: req['workspaceName'],
            relativeCwd: req['relativeCwd'],
            harness,
            reportMode,
            prompt: req['prompt'],
            ...(verifyCommand === undefined ? {} : { verifyCommand }),
          };
          promptQueue.push({ connectorId: entry.connectorId, event });
          broadcastPrompt();
          options.onNotifyPrompt?.(
            `Crewaid task from ${event.botName}`,
            `Confirm local task in ${event.workspaceName}`,
          );
          return;
        }
        case 'request_permission': {
          const requestId = raw['requestId'];
          const req = raw['request'];
          if (typeof requestId !== 'string' || !isRecord(req)) return;
          const title = typeof req['title'] === 'string' ? req['title'] : 'Tool action';
          const toolKind = typeof req['toolKind'] === 'string' ? req['toolKind'] : 'other';
          const locations = Array.isArray(req['locations'])
            ? req['locations'].filter((loc): loc is string => typeof loc === 'string')
            : [];
          const permOptions = parsePermissionOptions(req['options']);
          const event: LocalConnectorPromptEvent = {
            kind: 'request_permission',
            requestId,
            connectorId: entry.connectorId,
            connectorName: entry.name,
            title,
            toolKind,
            locations,
            options: permOptions,
          };
          promptQueue.push({ connectorId: entry.connectorId, event });
          broadcastPrompt();
          options.onNotifyPrompt?.('Local harness permission required', title);
          return;
        }
        case 'prompt_cancelled': {
          const requestId = raw['requestId'];
          if (typeof requestId === 'string') {
            removePromptById(requestId);
          }
          return;
        }
      }
    });

    handle.onExit((code: number) => {
      if (runtimes.get(entry.connectorId) !== runtime) return;
      runtimes.delete(entry.connectorId);
      dropPromptsForConnector(entry.connectorId);
      if (code !== 0 && !lastErrors.has(entry.connectorId)) {
        lastErrors.set(
          entry.connectorId,
          `Local connector exited unexpectedly (code ${String(code)}).`,
        );
      }
      broadcastState();
    });

    handle.postMessage({
      type: 'start',
      config: {
        connectorId: entry.connectorId,
        directory: entry.directory,
        serverUrl: entry.serverUrl,
        token: entry.token,
        reportMode: entry.reportMode,
        confirmInApp: entry.confirmInApp,
        cliVersion: options.appVersion,
      },
    });
  }

  function detectHarnesses(refresh = false): LocalHarnessDetectionResult {
    const env = getEnv(refresh);
    return {
      status: 'ok',
      harnesses: detectLocalHarnesses({ env }),
    };
  }

  function list(): ManagedConnectorsListResult {
    const stored = options.store.list();
    if (stored.status === 'unavailable') return stored;
    if (stored.status === 'error') return stored;
    return {
      status: 'ok',
      connectors: stored.connectors.map(toView),
    };
  }

  function pair(raw: unknown): ManagedConnectorActionResult {
    if (!isRecord(raw)) return { status: 'error', code: 'INVALID_INPUT' };
    const connectorId = raw['connectorId'];
    const name = raw['name'];
    const directory = raw['directory'];
    const serverUrl = raw['serverUrl'];
    const token = raw['token'];
    const reportMode = raw['reportMode'];
    const confirmInApp = raw['confirmInApp'];

    if (
      typeof connectorId !== 'string' ||
      connectorId.trim() === '' ||
      typeof name !== 'string' ||
      name.trim() === '' ||
      typeof directory !== 'string' ||
      directory.trim() === '' ||
      typeof serverUrl !== 'string' ||
      !isValidServerUrl(serverUrl) ||
      typeof token !== 'string' ||
      !token.startsWith('crw_conn_') ||
      token.length < 24 ||
      !isValidReportMode(reportMode) ||
      typeof confirmInApp !== 'boolean'
    ) {
      return { status: 'error', code: 'INVALID_INPUT' };
    }

    const resolvedDir = validateDir(directory);
    if (resolvedDir === null) {
      return { status: 'error', code: 'INVALID_DIRECTORY' };
    }

    const entry: StoredLocalConnector = {
      connectorId: connectorId.trim(),
      name: name.trim(),
      directory: resolvedDir,
      serverUrl: serverUrl.trim(),
      token,
      reportMode,
      confirmInApp,
      autoStart: true,
    };

    const saved = options.store.upsert(entry);
    if (saved.status === 'unavailable') {
      return { status: 'error', code: 'ENCRYPTION_UNAVAILABLE' };
    }
    if (saved.status === 'error') {
      return { status: 'error', code: 'STORAGE_ERROR' };
    }

    spawnWorker(entry);
    return { status: 'ok', connector: toView(entry) };
  }

  function findStored(connectorId: string): StoredLocalConnector | null | 'unavailable' | 'error' {
    const stored = options.store.list();
    if (stored.status === 'unavailable') return 'unavailable';
    if (stored.status === 'error') return 'error';
    return stored.connectors.find((item) => item.connectorId === connectorId) ?? null;
  }

  function start(connectorId: unknown): ManagedConnectorActionResult {
    if (typeof connectorId !== 'string' || connectorId.trim() === '') {
      return { status: 'error', code: 'INVALID_INPUT' };
    }
    const found = findStored(connectorId);
    if (found === 'unavailable') return { status: 'error', code: 'ENCRYPTION_UNAVAILABLE' };
    if (found === 'error') return { status: 'error', code: 'STORAGE_ERROR' };
    if (found === null) return { status: 'error', code: 'NOT_FOUND' };

    const resolvedDir = validateDir(found.directory);
    if (resolvedDir === null) {
      return { status: 'error', code: 'INVALID_DIRECTORY' };
    }
    const updated: StoredLocalConnector = { ...found, directory: resolvedDir, autoStart: true };
    const saved = options.store.upsert(updated);
    if (saved.status !== 'saved') {
      return {
        status: 'error',
        code: saved.status === 'unavailable' ? 'ENCRYPTION_UNAVAILABLE' : 'STORAGE_ERROR',
      };
    }
    spawnWorker(updated);
    return { status: 'ok', connector: toView(updated) };
  }

  function pause(connectorId: unknown): ManagedConnectorActionResult {
    if (typeof connectorId !== 'string' || connectorId.trim() === '') {
      return { status: 'error', code: 'INVALID_INPUT' };
    }
    const found = findStored(connectorId);
    if (found === 'unavailable') return { status: 'error', code: 'ENCRYPTION_UNAVAILABLE' };
    if (found === 'error') return { status: 'error', code: 'STORAGE_ERROR' };
    if (found === null) return { status: 'error', code: 'NOT_FOUND' };

    stopWorker(connectorId);
    lastErrors.delete(connectorId);
    const updated: StoredLocalConnector = { ...found, autoStart: false };
    const saved = options.store.upsert(updated);
    if (saved.status !== 'saved') {
      return {
        status: 'error',
        code: saved.status === 'unavailable' ? 'ENCRYPTION_UNAVAILABLE' : 'STORAGE_ERROR',
      };
    }
    broadcastState();
    return { status: 'ok', connector: toView(updated) };
  }

  function update(raw: unknown): ManagedConnectorActionResult {
    if (!isRecord(raw) || typeof raw['connectorId'] !== 'string') {
      return { status: 'error', code: 'INVALID_INPUT' };
    }
    const connectorId = raw['connectorId'];
    const found = findStored(connectorId);
    if (found === 'unavailable') return { status: 'error', code: 'ENCRYPTION_UNAVAILABLE' };
    if (found === 'error') return { status: 'error', code: 'STORAGE_ERROR' };
    if (found === null) return { status: 'error', code: 'NOT_FOUND' };

    const nextReportMode = raw['reportMode'] !== undefined ? raw['reportMode'] : found.reportMode;
    const nextConfirmInApp =
      raw['confirmInApp'] !== undefined ? raw['confirmInApp'] : found.confirmInApp;
    const nextToken = raw['token'] !== undefined ? raw['token'] : found.token;

    if (
      !isValidReportMode(nextReportMode) ||
      typeof nextConfirmInApp !== 'boolean' ||
      typeof nextToken !== 'string' ||
      !nextToken.startsWith('crw_conn_') ||
      nextToken.length < 24
    ) {
      return { status: 'error', code: 'INVALID_INPUT' };
    }

    const updated: StoredLocalConnector = {
      ...found,
      reportMode: nextReportMode,
      confirmInApp: nextConfirmInApp,
      token: nextToken,
    };
    const saved = options.store.upsert(updated);
    if (saved.status !== 'saved') {
      return {
        status: 'error',
        code: saved.status === 'unavailable' ? 'ENCRYPTION_UNAVAILABLE' : 'STORAGE_ERROR',
      };
    }

    const shouldRun = runtimes.has(connectorId) || updated.autoStart;
    if (shouldRun && validateDir(updated.directory) !== null) {
      spawnWorker(updated);
    } else {
      broadcastState();
    }
    return { status: 'ok', connector: toView(updated) };
  }

  function unpair(connectorId: unknown): ManagedConnectorActionResult {
    if (typeof connectorId !== 'string' || connectorId.trim() === '') {
      return { status: 'error', code: 'INVALID_INPUT' };
    }
    stopWorker(connectorId);
    lastErrors.delete(connectorId);
    lastHarnesses.delete(connectorId);
    const removed = options.store.remove(connectorId);
    if (removed.status !== 'saved') {
      return {
        status: 'error',
        code: removed.status === 'unavailable' ? 'ENCRYPTION_UNAVAILABLE' : 'STORAGE_ERROR',
      };
    }
    broadcastState();
    return { status: 'ok' };
  }

  function respondPrompt(raw: unknown): boolean {
    if (!isRecord(raw) || typeof raw['requestId'] !== 'string' || typeof raw['kind'] !== 'string') {
      return false;
    }
    const response = raw as unknown as LocalConnectorPromptResponse;
    // Check the answer matches the prompt's kind BEFORE dequeuing it: dropping
    // a prompt on a mismatched answer would leave the worker waiting on a reply
    // that never comes, and the task stuck until its deadline.
    const pending = promptQueue.find((item) => item.event.requestId === response.requestId);
    if (pending === undefined || pending.event.kind !== response.kind) return false;
    const queued = removePromptById(response.requestId);
    if (queued === null) return false;

    const rt = runtimes.get(queued.connectorId);
    if (rt === undefined) return false;

    if (response.kind === 'confirm_task' && queued.event.kind === 'confirm_task') {
      rt.handle.postMessage({
        type: 'confirm_response',
        requestId: response.requestId,
        approved: response.approved === true,
      });
      return true;
    }
    if (response.kind === 'request_permission' && queued.event.kind === 'request_permission') {
      const decision =
        response.outcome === 'selected' && typeof response.optionId === 'string'
          ? { outcome: 'selected' as const, optionId: response.optionId }
          : { outcome: 'cancelled' as const };
      rt.handle.postMessage({
        type: 'permission_response',
        requestId: response.requestId,
        decision,
      });
      return true;
    }
    return false;
  }

  function currentPrompt(): LocalConnectorPromptEvent | null {
    return promptQueue[0]?.event ?? null;
  }

  function startAutoConnect(): void {
    const stored = options.store.list();
    if (stored.status !== 'ok') return;
    for (const entry of stored.connectors) {
      if (!entry.autoStart) continue;
      if (runtimes.has(entry.connectorId)) continue;
      if (validateDir(entry.directory) === null) {
        lastErrors.set(entry.connectorId, 'Folder no longer exists on this computer.');
        continue;
      }
      spawnWorker(entry);
    }
    broadcastState();
  }

  function stopAll(): void {
    for (const id of [...runtimes.keys()]) {
      stopWorker(id);
    }
    if (promptQueue.length > 0) {
      promptQueue.length = 0;
      broadcastPrompt();
    }
    broadcastState();
  }

  return {
    detectHarnesses,
    list,
    pair,
    start,
    pause,
    update,
    unpair,
    respondPrompt,
    currentPrompt,
    startAutoConnect,
    stopAll,
  };
}

export function registerLocalConnectorIpc(options: {
  readonly ipcMain: TokenIpcMainLike;
  readonly isTrustedSender: (event: unknown) => boolean;
  readonly manager: LocalConnectorManager;
  readonly pickFolder: () => Promise<PickFolderResult>;
}): void {
  const register = guardedIpc(options);

  register(
    'crewaid:local-connector:detect-harnesses',
    (refresh) => options.manager.detectHarnesses(refresh === true),
    {
      unauthorized: { status: 'error', code: 'UNAUTHORIZED' } satisfies LocalHarnessDetectionResult,
      failed: { status: 'error', code: 'IPC_ERROR' } satisfies LocalHarnessDetectionResult,
    },
  );

  register('crewaid:local-connector:pick-folder', () => options.pickFolder(), {
    unauthorized: { status: 'error', code: 'UNAUTHORIZED' } satisfies PickFolderResult,
    failed: { status: 'error', code: 'IPC_ERROR' } satisfies PickFolderResult,
  });

  register('crewaid:local-connector:list', () => options.manager.list(), {
    unauthorized: { status: 'error', code: 'UNAUTHORIZED' } satisfies ManagedConnectorsListResult,
    failed: { status: 'error', code: 'IPC_ERROR' } satisfies ManagedConnectorsListResult,
  });

  register('crewaid:local-connector:pair', (input) => options.manager.pair(input), {
    unauthorized: { status: 'error', code: 'UNAUTHORIZED' } satisfies ManagedConnectorActionResult,
    failed: { status: 'error', code: 'IPC_ERROR' } satisfies ManagedConnectorActionResult,
  });

  register('crewaid:local-connector:start', (id) => options.manager.start(id), {
    unauthorized: { status: 'error', code: 'UNAUTHORIZED' } satisfies ManagedConnectorActionResult,
    failed: { status: 'error', code: 'IPC_ERROR' } satisfies ManagedConnectorActionResult,
  });

  register('crewaid:local-connector:pause', (id) => options.manager.pause(id), {
    unauthorized: { status: 'error', code: 'UNAUTHORIZED' } satisfies ManagedConnectorActionResult,
    failed: { status: 'error', code: 'IPC_ERROR' } satisfies ManagedConnectorActionResult,
  });

  register('crewaid:local-connector:update', (input) => options.manager.update(input), {
    unauthorized: { status: 'error', code: 'UNAUTHORIZED' } satisfies ManagedConnectorActionResult,
    failed: { status: 'error', code: 'IPC_ERROR' } satisfies ManagedConnectorActionResult,
  });

  register('crewaid:local-connector:unpair', (id) => options.manager.unpair(id), {
    unauthorized: { status: 'error', code: 'UNAUTHORIZED' } satisfies ManagedConnectorActionResult,
    failed: { status: 'error', code: 'IPC_ERROR' } satisfies ManagedConnectorActionResult,
  });

  register('crewaid:local-connector:current-prompt', () => options.manager.currentPrompt(), {
    unauthorized: null as LocalConnectorPromptEvent | null,
    failed: null as LocalConnectorPromptEvent | null,
  });

  register(
    'crewaid:local-connector:respond-prompt',
    (response) => options.manager.respondPrompt(response),
    {
      unauthorized: false,
      failed: false,
    },
  );
}
