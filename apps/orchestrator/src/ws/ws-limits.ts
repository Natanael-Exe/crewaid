/**
 * The two bounds a WebSocket lives inside.
 *
 * Inbound: `ws` buffers a whole message before handing it on, and its default
 * ceiling is 100 MiB — so without one of ours, a handful of sockets each
 * sending one large frame hold hundreds of megabytes and a synchronous
 * `JSON.parse` over each. Every client frame is a small envelope; the largest
 * legitimate one is an approval answer carrying edited arguments.
 *
 * Outbound: `send` queues whatever the peer has not read yet, and nothing
 * stops that queue growing. A client that stops reading — a frozen tab, a
 * socket held open on purpose — would keep every frame this process broadcasts
 * to it. Past the bound the socket is ended instead: the desktop reconnects
 * and resyncs from REST (it already does after any drop), which is cheaper
 * than a queue nobody will drain.
 */
export const WS_MAX_INBOUND_FRAME_BYTES = 1024 * 1024;
export const WS_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** How deep a parsed client frame may nest before any schema reads it. */
export const WS_MAX_FRAME_DEPTH = 64;

/** Whether a parsed JSON value nests deeper than `max`. Iterative, for the same reason. */
export function nestsDeeperThan(value: unknown, max: number): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (typeof next.value !== 'object' || next.value === null) continue;
    if (next.depth >= max) return true;
    const children = Array.isArray(next.value)
      ? (next.value as unknown[])
      : Object.values(next.value as Record<string, unknown>);
    for (const child of children) pending.push({ value: child, depth: next.depth + 1 });
  }
  return false;
}

/** The slice of a `ws` socket the bound needs. */
export type BoundedSocket = {
  readonly bufferedAmount: number;
  send(data: string): void;
  terminate(): void;
};

/** Send, or end a socket whose peer has stopped reading. Returns whether it sent. */
export function sendBounded(client: BoundedSocket, data: string): boolean {
  if (client.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
    client.terminate();
    return false;
  }
  client.send(data);
  return true;
}
