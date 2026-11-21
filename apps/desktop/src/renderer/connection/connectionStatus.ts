import type { WsConnectionState } from './wsClient';
import { t } from '../i18n/i18n';

export type ConnectionTone = 'default' | 'accent' | 'success' | 'warning';

export type ConnectionStatusCopy = {
  readonly label: string;
  readonly detail: string;
  readonly tone: ConnectionTone;
};

export type ConnectionStatus = WsConnectionState;

export function connectionStatusCopy(state: ConnectionStatus): ConnectionStatusCopy {
  switch (state.status) {
    case 'connected':
      return {
        label: t('connection.connectionStatus.connected'),
        detail: t('connection.connectionStatus.liveUpdatesOn'),
        tone: 'success',
      };
    case 'connecting':
      return {
        label: t('connection.connectionStatus.connecting'),
        detail: t('connection.connectionStatus.openingLiveUpdates'),
        tone: 'accent',
      };
    case 'reconnecting':
      return {
        label: t('connection.connectionStatus.reconnecting'),
        detail: t('connection.connectionStatus.retryingIn', {
          seconds: Math.ceil((state.retryDelayMs ?? 0) / 1_000),
        }),
        tone: 'warning',
      };
    case 'disconnected':
      return {
        label: t('connection.connectionStatus.offline'),
        detail: t('connection.connectionStatus.configureTheOrchestratorToConnect'),
        tone: 'default',
      };
  }
}
