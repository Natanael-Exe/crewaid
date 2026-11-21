import type { ChatEndpoint } from './chatEndpoint';
import type { TranscriptMessage } from '../state/viewTypes';

const MAX_THREADS = 8;
const MAX_ROWS = 100;
const MAX_BYTES = 2 * 1024 * 1024;
const TTL_MS = 60_000;

/** A display-only preview; the chat client always hydrates independently. */
export class ThreadPreviewCache {
  private readonly entries = new Map<
    string,
    {
      botId: string;
      messages: TranscriptMessage[];
      at: number;
      bytes: number;
    }
  >();
  constructor(private readonly now: () => number = Date.now) {}

  private key(endpoint: ChatEndpoint, threadId: string): string {
    return JSON.stringify([endpoint.url, endpoint.headers, threadId]);
  }

  read(endpoint: ChatEndpoint, threadId: string): TranscriptMessage[] | null {
    const key = this.key(endpoint, threadId);
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    this.entries.delete(key);
    if (this.now() - entry.at >= TTL_MS) return null;
    this.entries.set(key, entry);
    return entry.messages;
  }

  write(endpoint: ChatEndpoint, threadId: string, botId: string, rows: TranscriptMessage[]): void {
    const key = this.key(endpoint, threadId);
    this.entries.delete(key);
    const messages = rows.slice(-MAX_ROWS);
    const bytes = JSON.stringify(messages).length * 2;
    if (bytes > MAX_BYTES) return;
    this.entries.set(key, { botId, messages, bytes, at: this.now() });
    let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (this.entries.size > MAX_THREADS || total > MAX_BYTES) {
      const oldest = this.entries.keys().next().value!;
      total -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }

  invalidate(botId: string): void {
    for (const [key, entry] of this.entries) if (entry.botId === botId) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
