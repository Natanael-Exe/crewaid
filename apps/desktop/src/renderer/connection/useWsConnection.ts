import { useCallback, useEffect, useRef, useState } from 'react';
import { credentialsProvider } from '../bridge';
import type { ClientFrame, ServerFrame } from '@crewaid/shared';
import {
  WsClient,
  type TokenCredentials,
  type WebSocketFactory,
  type WsClientError,
  type WsConnectionState,
} from './wsClient';

export type UseWsConnectionOptions = {
  readonly enabled?: boolean;
  /** Every validated WebSocket server frame. Kept in a ref so a new callback
   * identity does not tear down and reopen the socket. */
  readonly onFrame?: (frame: ServerFrame) => void;
  readonly tokenProvider?: () => Promise<TokenCredentials>;
  readonly webSocketFactory?: WebSocketFactory;
};

const disconnected: WsConnectionState = {
  status: 'disconnected',
  attempt: 0,
  retryDelayMs: null,
};

/** React lifecycle wrapper around the typed WS transport. */
export function useWsConnection(options: UseWsConnectionOptions = {}): {
  readonly state: WsConnectionState;
  readonly lastError: WsClientError | null;
  readonly send: (frame: ClientFrame) => boolean;
  readonly sendScreenInput: (botId: string, rfb: Uint8Array) => boolean;
  readonly reconnect: () => void;
} {
  const [state, setState] = useState<WsConnectionState>(disconnected);
  const onFrameRef = useRef(options.onFrame);
  // Synced in an effect rather than during render. A render can be discarded —
  // concurrent rendering, a transition, StrictMode's double invoke — and a
  // discarded render must not leave its callback behind in a ref the live
  // socket then dispatches through.
  useEffect(() => {
    onFrameRef.current = options.onFrame;
  }, [options.onFrame]);
  const [lastError, setLastError] = useState<WsClientError | null>(null);
  const clientRef = useRef<WsClient | null>(null);
  const enabled = options.enabled ?? true;
  const tokenProvider = options.tokenProvider ?? credentialsProvider;
  const webSocketFactory = options.webSocketFactory;

  useEffect(() => {
    if (!enabled) return undefined;

    const client = new WsClient({
      tokenProvider,
      ...(webSocketFactory === undefined ? {} : { webSocketFactory }),
    });
    clientRef.current = client;
    const removeStatus = client.onStatus(setState);
    const removeError = client.onError(setLastError);
    const removeFrame = client.onFrame((frame) => onFrameRef.current?.(frame));
    client.start();

    return () => {
      removeStatus();
      removeError();
      removeFrame();
      client.stop();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [enabled, tokenProvider, webSocketFactory]);

  /**
   * Reopen now, with whatever credentials the store holds at this instant.
   *
   * The socket already re-reads the CC-07 bag on every attempt, so a save
   * eventually takes hold on its own — but "eventually" is up to the 30s
   * ceiling of the reconnect backoff, which reads as a save that did nothing.
   * `stop()` clears the pending timer and resets the attempt counter, so the
   * following `start()` opens immediately rather than serving the old delay.
   */
  const reconnect = useCallback(() => {
    const client = clientRef.current;
    if (client === null) return;
    client.stop();
    client.start();
  }, []);

  const send = useCallback(
    (frame: ClientFrame): boolean => clientRef.current?.send(frame) ?? false,
    [],
  );
  const sendScreenInput = useCallback(
    (botId: string, rfb: Uint8Array): boolean =>
      clientRef.current?.sendScreenInput(botId, rfb) ?? false,
    [],
  );
  return { state, lastError, send, sendScreenInput, reconnect };
}
