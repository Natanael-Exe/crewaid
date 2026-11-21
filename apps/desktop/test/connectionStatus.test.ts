import { describe, expect, it } from 'vitest';
import {
  connectionStatusCopy,
  type ConnectionStatus,
} from '../src/renderer/connection/connectionStatus';

describe('connectionStatusCopy', () => {
  it('labels a connected socket as ready', () => {
    expect(connectionStatusCopy({ status: 'connected', attempt: 0, retryDelayMs: null })).toEqual({
      label: 'Connected',
      detail: 'Live updates on',
      tone: 'success',
    });
  });

  it('shows the bounded retry delay without exposing transport errors', () => {
    expect(
      connectionStatusCopy({ status: 'reconnecting', attempt: 3, retryDelayMs: 4_000 }),
    ).toEqual({
      label: 'Reconnecting',
      detail: 'Retrying in 4s',
      tone: 'warning',
    });
  });

  it('uses neutral copy when credentials are not configured', () => {
    expect(
      connectionStatusCopy({ status: 'disconnected', attempt: 0, retryDelayMs: null }),
    ).toEqual({
      label: 'Offline',
      detail: 'Configure the orchestrator to connect',
      tone: 'default',
    });
  });

  it('distinguishes the initial handshake from a retry', () => {
    const state: ConnectionStatus = { status: 'connecting', attempt: 0, retryDelayMs: null };
    expect(connectionStatusCopy(state)).toEqual({
      label: 'Connecting',
      detail: 'Opening live updates',
      tone: 'accent',
    });
  });
});
