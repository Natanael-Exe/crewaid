import type { LocalConnectorHarnessId, LocalConnectorReportMode } from '@crewaid/shared';

export type BuiltinLocalHarnessId = Exclude<LocalConnectorHarnessId, 'custom'>;

export interface LocalHarnessProbeItem {
  readonly id: BuiltinLocalHarnessId;
  readonly label: string;
  readonly command: string;
  readonly available: boolean;
  readonly resolvedPath: string | null;
  /** Shell command safe to copy into a terminal, or null when installed via GUI/app. */
  readonly installCommand: string | null;
  /** Human-readable install instructions shown in UI / tooltip. */
  readonly installHint: string;
}

export type LocalHarnessDetectionResult =
  | { readonly status: 'ok'; readonly harnesses: readonly LocalHarnessProbeItem[] }
  | { readonly status: 'error'; readonly code: 'UNAUTHORIZED' | 'IPC_ERROR' };

export type PickFolderResult =
  | { readonly status: 'selected'; readonly directory: string; readonly name: string }
  | { readonly status: 'cancelled' }
  | { readonly status: 'error'; readonly code: 'UNAUTHORIZED' | 'IPC_ERROR' };

export type ManagedConnectorRuntimeState =
  | 'starting'
  | 'online'
  | 'busy'
  | 'reconnecting'
  | 'paused'
  | 'error';

/**
 * Sanitized desktop-managed connector state sent to the renderer.
 * Never includes the connector bearer token.
 */
export interface ManagedConnectorView {
  readonly connectorId: string;
  readonly name: string;
  readonly directory: string;
  readonly serverUrl: string;
  readonly reportMode: LocalConnectorReportMode;
  readonly confirmInApp: boolean;
  readonly autoStart: boolean;
  readonly state: ManagedConnectorRuntimeState;
  readonly harnesses: readonly LocalConnectorHarnessId[];
  readonly error?: string;
}

export type ManagedConnectorsListResult =
  | { readonly status: 'ok'; readonly connectors: readonly ManagedConnectorView[] }
  | { readonly status: 'unavailable'; readonly code: 'ENCRYPTION_UNAVAILABLE' }
  | { readonly status: 'error'; readonly code: 'UNAUTHORIZED' | 'IPC_ERROR' | 'STORAGE_ERROR' };

export interface PairLocalConnectorInput {
  readonly connectorId: string;
  readonly name: string;
  readonly directory: string;
  readonly serverUrl: string;
  readonly token: string;
  readonly reportMode: LocalConnectorReportMode;
  readonly confirmInApp: boolean;
}

export interface UpdateLocalConnectorInput {
  readonly connectorId: string;
  readonly reportMode?: LocalConnectorReportMode;
  readonly confirmInApp?: boolean;
  readonly token?: string;
}

export type ManagedConnectorActionErrorCode =
  | 'UNAUTHORIZED'
  | 'IPC_ERROR'
  | 'ENCRYPTION_UNAVAILABLE'
  | 'STORAGE_ERROR'
  | 'INVALID_INPUT'
  | 'INVALID_DIRECTORY'
  | 'NOT_FOUND';

export type ManagedConnectorActionResult =
  | { readonly status: 'ok'; readonly connector?: ManagedConnectorView }
  | { readonly status: 'error'; readonly code: ManagedConnectorActionErrorCode; readonly message?: string };

export interface LocalPermissionOptionView {
  readonly optionId: string;
  readonly name: string;
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export type LocalConnectorPromptEvent =
  | {
      readonly kind: 'confirm_task';
      readonly requestId: string;
      readonly connectorId: string;
      readonly connectorName: string;
      readonly botName: string;
      readonly workspaceName: string;
      readonly relativeCwd: string;
      readonly harness: LocalConnectorHarnessId;
      readonly reportMode: LocalConnectorReportMode;
      readonly prompt: string;
      readonly verifyCommand?: string;
    }
  | {
      readonly kind: 'request_permission';
      readonly requestId: string;
      readonly connectorId: string;
      readonly connectorName: string;
      readonly title: string;
      readonly toolKind: string;
      readonly locations: readonly string[];
      readonly options: readonly LocalPermissionOptionView[];
    };

export type LocalConnectorPromptResponse =
  | { readonly kind: 'confirm_task'; readonly requestId: string; readonly approved: boolean }
  | {
      readonly kind: 'request_permission';
      readonly requestId: string;
      readonly outcome: 'selected';
      readonly optionId: string;
    }
  | {
      readonly kind: 'request_permission';
      readonly requestId: string;
      readonly outcome: 'cancelled';
    };

export const LOCAL_CONNECTOR_STATE_CHANNEL = 'crewaid:local-connector:state';
export const LOCAL_CONNECTOR_PROMPT_CHANNEL = 'crewaid:local-connector:prompt';
