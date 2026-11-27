import { randomUUID } from 'node:crypto';
import {
  detectInstalledHarnesses,
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  type ResolvedHarnessCommand,
} from '@crewaid/acp-core';
import type { LocalConnectorHarnessId, LocalConnectorReportMode } from '@crewaid/shared';

import { ConnectorClient, type ConnectorClientRuntimeState } from './connector-client.js';
import type { LocalTaskConfirmRequest } from './local-prompts.js';
import { resolveWorkspaceRoot } from './path-guard.js';
import { buildConnectorWsUrl, normalizeServerUrl, validateTokenFormat } from './token-store.js';

declare const __CREWAID_CONNECT_VERSION__: string | undefined;

export interface DesktopWorkerStartConfig {
  readonly connectorId: string;
  readonly directory: string;
  readonly serverUrl: string;
  readonly token: string;
  readonly reportMode: LocalConnectorReportMode;
  readonly confirmInApp: boolean;
  readonly cliVersion?: string;
  readonly disconnectGraceMs?: number;
}

export type DesktopWorkerInboundMessage =
  | { readonly type: 'start'; readonly config: DesktopWorkerStartConfig }
  | { readonly type: 'stop' }
  | { readonly type: 'confirm_response'; readonly requestId: string; readonly approved: boolean }
  | {
      readonly type: 'permission_response';
      readonly requestId: string;
      readonly decision: AcpPermissionDecision;
    };

export type DesktopWorkerOutboundMessage =
  | {
      readonly type: 'state';
      readonly state: ConnectorClientRuntimeState['state'];
      readonly harnesses?: readonly LocalConnectorHarnessId[];
      readonly error?: string;
      readonly permanent?: boolean;
    }
  | {
      readonly type: 'confirm_task';
      readonly requestId: string;
      readonly request: LocalTaskConfirmRequest;
    }
  | {
      readonly type: 'request_permission';
      readonly requestId: string;
      readonly request: AcpPermissionRequest;
    }
  | {
      readonly type: 'prompt_cancelled';
      readonly requestId: string;
    };

/** Minimal port contract matching Electron's `process.parentPort`. */
export interface DesktopWorkerPort {
  readonly on: (event: 'message', listener: (event: { readonly data: unknown }) => void) => void;
  readonly postMessage: (message: DesktopWorkerOutboundMessage) => void;
}

export interface DesktopWorkerDependencies {
  readonly detectHarnesses?: () => readonly LocalConnectorHarnessId[];
  readonly resolveHarness?: (harness: LocalConnectorHarnessId) => ResolvedHarnessCommand;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly onExit?: (exitCode: number) => void;
}

function workerVersion(override?: string): string {
  if (override !== undefined && override.trim() !== '') return override.trim();
  return typeof __CREWAID_CONNECT_VERSION__ === 'string' && __CREWAID_CONNECT_VERSION__ !== ''
    ? __CREWAID_CONNECT_VERSION__
    : '0.1.6';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runs a single `ConnectorClient` inside Electron's `utilityProcess.fork()`
 * (D-242). Communicates strictly over structured MessagePort IPC so the
 * connector token never touches argv, environment variables, or disk files,
 * and local task confirmations / ACP permission prompts surface inside the
 * Crewaid window with fail-closed abort semantics.
 */
export function attachDesktopWorker(
  port: DesktopWorkerPort,
  deps: DesktopWorkerDependencies = {},
): void {
  let client: ConnectorClient | null = null;
  let activeHarnesses: readonly LocalConnectorHarnessId[] = [];
  const pendingConfirms = new Map<string, (approved: boolean) => void>();
  const pendingPermissions = new Map<string, (decision: AcpPermissionDecision) => void>();

  const cancelAllPendingPrompts = () => {
    for (const [id, resolve] of pendingConfirms.entries()) {
      pendingConfirms.delete(id);
      resolve(false);
    }
    for (const [id, resolve] of pendingPermissions.entries()) {
      pendingPermissions.delete(id);
      resolve({ outcome: 'cancelled' });
    }
  };

  const confirmTask = (req: LocalTaskConfirmRequest, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted) return Promise.resolve(false);
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (approved: boolean) => {
        if (settled) return;
        settled = true;
        pendingConfirms.delete(requestId);
        signal.removeEventListener('abort', onAbort);
        resolve(approved);
      };
      const onAbort = () => {
        port.postMessage({ type: 'prompt_cancelled', requestId });
        finish(false);
      };
      pendingConfirms.set(requestId, finish);
      signal.addEventListener('abort', onAbort, { once: true });
      port.postMessage({ type: 'confirm_task', requestId, request: req });
    });
  };

  const requestPermission = (
    req: AcpPermissionRequest,
    signal: AbortSignal,
  ): Promise<AcpPermissionDecision> => {
    if (signal.aborted || req.options.length === 0) {
      return Promise.resolve({ outcome: 'cancelled' });
    }
    const requestId = randomUUID();
    return new Promise<AcpPermissionDecision>((resolve) => {
      let settled = false;
      const finish = (decision: AcpPermissionDecision) => {
        if (settled) return;
        settled = true;
        pendingPermissions.delete(requestId);
        signal.removeEventListener('abort', onAbort);
        resolve(decision);
      };
      const onAbort = () => {
        port.postMessage({ type: 'prompt_cancelled', requestId });
        finish({ outcome: 'cancelled' });
      };
      pendingPermissions.set(requestId, finish);
      signal.addEventListener('abort', onAbort, { once: true });
      port.postMessage({ type: 'request_permission', requestId, request: req });
    });
  };

  const startConnector = (config: DesktopWorkerStartConfig) => {
    if (client !== null) {
      client.stop(0);
      client = null;
    }

    let workspace;
    try {
      workspace = resolveWorkspaceRoot(config.directory);
    } catch (error: unknown) {
      port.postMessage({
        type: 'state',
        state: 'error',
        error: error instanceof Error ? error.message : 'Folder could not be opened.',
        permanent: true,
      });
      return;
    }

    let token: string;
    let wsUrl: string;
    try {
      token = validateTokenFormat(config.token);
      wsUrl = buildConnectorWsUrl(normalizeServerUrl(config.serverUrl));
    } catch (error: unknown) {
      port.postMessage({
        type: 'state',
        state: 'error',
        error: error instanceof Error ? error.message : 'Invalid connector configuration.',
        permanent: true,
      });
      return;
    }

    const baseEnv = deps.baseEnv ?? process.env;
    const harnesses: readonly LocalConnectorHarnessId[] =
      deps.detectHarnesses !== undefined
        ? deps.detectHarnesses()
        : detectInstalledHarnesses({ pathEnv: baseEnv['PATH'], pathExtEnv: baseEnv['PATHEXT'] }).map(
            (h) => h.id,
          );

    if (harnesses.length === 0) {
      port.postMessage({
        type: 'state',
        state: 'error',
        harnesses: [],
        error: 'NO_HARNESSES_FOUND',
        permanent: true,
      });
      return;
    }
    activeHarnesses = harnesses;

    const nextClient = new ConnectorClient({
      wsUrl,
      token,
      cliVersion: workerVersion(config.cliVersion),
      workspaceRoot: workspace.root,
      workspaceName: workspace.workspaceName,
      harnesses,
      defaultHarness: harnesses[0] ?? null,
      reportMode: config.reportMode,
      trustServerApprovals: !config.confirmInApp,
      disconnectGraceMs: config.disconnectGraceMs ?? 60_000,
      baseEnv,
      log: () => undefined,
      onStateChange: (next) => {
        port.postMessage({
          type: 'state',
          state: next.state,
          harnesses: activeHarnesses,
          ...(next.error === undefined ? {} : { error: next.error }),
          ...(next.permanent === undefined ? {} : { permanent: next.permanent }),
        });
      },
      confirmTask,
      requestPermission,
      ...(deps.resolveHarness === undefined ? {} : { resolveHarness: deps.resolveHarness }),
    });

    client = nextClient;
    nextClient.start();
    void nextClient.done.then((exitCode) => {
      cancelAllPendingPrompts();
      if (client === nextClient) {
        client = null;
      }
      deps.onExit?.(exitCode);
    });
  };

  port.on('message', (event) => {
    const data = event.data;
    if (!isRecord(data) || typeof data['type'] !== 'string') return;
    const msg = data as unknown as DesktopWorkerInboundMessage;
    switch (msg.type) {
      case 'start':
        startConnector(msg.config);
        return;
      case 'stop':
        cancelAllPendingPrompts();
        if (client !== null) {
          client.stop(0);
          client = null;
        } else {
          port.postMessage({ type: 'state', state: 'stopped' });
        }
        return;
      case 'confirm_response': {
        const resolve = pendingConfirms.get(msg.requestId);
        if (resolve !== undefined) resolve(msg.approved === true);
        return;
      }
      case 'permission_response': {
        const resolve = pendingPermissions.get(msg.requestId);
        if (resolve !== undefined) resolve(msg.decision);
        return;
      }
    }
  });
}

// Auto-attach only when executed inside Electron's utilityProcess.fork().
const maybeParentPort = (process as unknown as { readonly parentPort?: DesktopWorkerPort })
  .parentPort;
if (maybeParentPort !== undefined) {
  attachDesktopWorker(maybeParentPort, {
    onExit: (code) => {
      process.exit(code);
    },
  });
}
