import type { TranscriptMessage } from '../state/viewTypes';

export type EntranceHistory = {
  botId: string;
  ids: ReadonlySet<string>;
  newest: number;
};

/** Hydration and older pages never enter; only messages added at the live tail do. */
export function enteringMessageIds(
  previous: EntranceHistory | null,
  botId: string,
  messages: readonly TranscriptMessage[],
  loaded: boolean,
): readonly string[] {
  if (!loaded || previous === null || previous.botId !== botId) return [];
  return messages
    .filter(
      (message) =>
        !previous.ids.has(message.id) &&
        message.createdAt >= previous.newest &&
        message.author !== 'SYSTEM',
    )
    .map((message) => message.id);
}

export function rememberMessages(
  botId: string,
  messages: readonly TranscriptMessage[],
): EntranceHistory {
  return {
    botId,
    ids: new Set(messages.map((message) => message.id)),
    newest: messages.reduce((newest, message) => Math.max(newest, message.createdAt), 0),
  };
}
