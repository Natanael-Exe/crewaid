import { EventType, type StreamChunk } from '@tanstack/ai';

/** Translate the engine's shared text/thinking lane into distinct AG-UI messages. */
export function publicEventWriter(write: (event: StreamChunk) => Promise<void>) {
  const starts = new Map<string, StreamChunk>();
  const reasoning = new Map<string, string>();
  let sequence = 0;
  async function openText(id: string | undefined) {
    if (id === undefined) return;
    const start = starts.get(id);
    if (start === undefined) return;
    starts.delete(id);
    await write(start);
  }
  return async (event: StreamChunk): Promise<void> => {
    // The engine opens an empty assistant before it thinks. Delay that opener
    // so a native client can display reasoning before the spoken/tool anchor.
    if (event.type === EventType.TEXT_MESSAGE_START) {
      starts.set(event.messageId, event);
      return;
    }
    if (event.type === EventType.TEXT_MESSAGE_CONTENT || event.type === EventType.TEXT_MESSAGE_END)
      await openText(event.messageId);
    else if (event.type === EventType.TOOL_CALL_START) await openText(event.parentMessageId);

    if (event.type === EventType.REASONING_MESSAGE_START) {
      const id = `${event.messageId}-reasoning-${sequence++}`;
      reasoning.set(event.messageId, id);
      await write({ ...event, messageId: id, role: 'reasoning' });
    } else if (
      event.type === EventType.REASONING_MESSAGE_CONTENT ||
      event.type === EventType.REASONING_MESSAGE_END
    ) {
      await write({ ...event, messageId: reasoning.get(event.messageId) ?? event.messageId });
    } else if (event.type === EventType.REASONING_ENCRYPTED_VALUE && event.subtype === 'message') {
      await write({ ...event, entityId: reasoning.get(event.entityId) ?? event.entityId });
    } else await write(event);
  };
}
