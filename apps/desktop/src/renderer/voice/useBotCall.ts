import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallAllowanceResponse, ServerFrame } from '@crewaid/shared';
import { callAllowance, startCall, updateCall, useApiClient } from '../api';
import {
  CallSession,
  IDLE_CALL,
  browserCallTimers,
  connectElevenLabs,
  type CallDeps,
  type CallSnapshot,
} from './callSession';
import { resolveMicrophone } from './microphonePreference';

/**
 * Whether this account can call at all: `absent` on a server with no call
 * routes (self-hosted, or no voice agent), and while the answer is unknown.
 */
export type CallAvailability =
  | { readonly kind: 'absent' }
  | { readonly kind: 'available'; readonly allowance: CallAllowanceResponse };

export type BotCall = {
  readonly snapshot: CallSnapshot;
  readonly availability: CallAvailability;
  readonly start: () => void;
  readonly hangUp: () => void;
  readonly setMuted: (muted: boolean) => void;
  readonly dismissError: () => void;
  /** What the shell tells the call about the bot's thread. */
  readonly runProgress: (progress: string | null) => void;
  readonly approvalWaiting: () => void;
  readonly approvalsAnswered: () => void;
};

/**
 * The call with the selected bot, if any. Owned by the shell because
 * a call outlives the thread component under it, and ends when the bot does:
 * switching bots, or closing the window, hangs up.
 */
export function useBotCall(
  bot: { readonly id: string; readonly name: string } | null,
  sendToBot: (text: string) => Promise<string | null>,
  onBotFrames: (botId: string, listener: (frame: ServerFrame) => void) => () => void,
  connect: CallDeps['connect'] = connectElevenLabs,
): BotCall {
  const client = useApiClient();
  const [snapshot, setSnapshot] = useState<CallSnapshot>(IDLE_CALL);
  const [availability, setAvailability] = useState<CallAvailability>({ kind: 'absent' });
  const session = useRef<CallSession | null>(null);
  const send = useRef(sendToBot);
  send.current = sendToBot;

  const refreshAllowance = useCallback(() => {
    callAllowance(client).then(
      (allowance) => setAvailability({ kind: 'available', allowance }),
      () => setAvailability({ kind: 'absent' }),
    );
  }, [client]);
  useEffect(refreshAllowance, [refreshAllowance]);

  const start = useCallback(() => {
    if (bot === null || (session.current !== null && session.current.state.phase !== 'idle')) {
      return;
    }
    const created = new CallSession(
      {
        start: (botId) => startCall(client, botId),
        update: (callId, body) => updateCall(client, callId, body),
        connect,
        microphone: () => resolveMicrophone(),
        sendToBot: (text) => send.current(text),
        ...browserCallTimers,
      },
      bot,
      (next) => {
        setSnapshot(next);
        // The minutes left change when a call ends, and only then.
        if (next.phase === 'idle') refreshAllowance();
      },
    );
    session.current = created;
    void created.start();
  }, [bot, client, connect, refreshAllowance]);

  const hangUp = useCallback(() => void session.current?.hangUp(), []);

  // A call is with one bot: leaving it, or the window, ends the call.
  useEffect(() => {
    const leave = () => void session.current?.hangUp();
    window.addEventListener('beforeunload', leave);
    return () => {
      window.removeEventListener('beforeunload', leave);
      leave();
    };
  }, [bot?.id]);

  // The server says when a request is answered, on the bot's socket.
  const botId = bot?.id;
  useEffect(() => {
    if (botId === undefined) return;
    return onBotFrames(botId, (frame) => {
      if (frame.type === 'run.settled') session.current?.runSettled(frame.payload);
      else if (frame.type === 'bot.status') session.current?.botStatusChanged(frame.payload.status);
    });
  }, [botId, onBotFrames]);

  // Stable, so the thread's bridge does not re-run its effects every render.
  const setMuted = useCallback((muted: boolean) => session.current?.setMuted(muted), []);
  const dismissError = useCallback(
    () => setSnapshot((current) => ({ ...current, error: null })),
    [],
  );
  const runProgress = useCallback(
    (progress: string | null) => session.current?.runProgress(progress),
    [],
  );
  const approvalWaiting = useCallback(() => session.current?.approvalWaiting(), []);
  const approvalsAnswered = useCallback(() => session.current?.approvalsAnswered(), []);

  return {
    snapshot,
    availability,
    start,
    hangUp,
    setMuted,
    dismissError,
    runProgress,
    approvalWaiting,
    approvalsAnswered,
  };
}
