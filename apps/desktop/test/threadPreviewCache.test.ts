import { describe, expect, it } from 'vitest';
import { ThreadPreviewCache } from '../src/renderer/chat/threadPreviewCache';
import { toTranscriptMessage } from '../src/renderer/chat/uiMessage';

const endpoint = { url: 'https://orch.example/chat', headers: { Authorization: 'Bearer alice' } };
const row = (id: string, text = 'Hello') =>
  toTranscriptMessage(
    {
      id,
      role: 'user',
      content: text,
      metadata: { tanstack: { createdAt: 0 } },
    },
    'bot',
  );

describe('ephemeral thread previews', () => {
  it('isolates credentials, thread and endpoint, expires, and invalidates deletions', () => {
    let now = 0;
    const cache = new ThreadPreviewCache(() => now);
    cache.write(endpoint, 'thread', 'bot', [row('a')]);
    expect(cache.read(endpoint, 'thread')?.[0]?.id).toBe('a');
    expect(
      cache.read({ ...endpoint, headers: { Authorization: 'Bearer bob' } }, 'thread'),
    ).toBeNull();
    expect(cache.read({ ...endpoint, url: 'https://other.example/chat' }, 'thread')).toBeNull();
    expect(cache.read(endpoint, 'other')).toBeNull();
    now = 60_000;
    expect(cache.read(endpoint, 'thread')).toBeNull();
    cache.write(endpoint, 'thread', 'bot', [row('b')]);
    cache.invalidate('bot');
    expect(cache.read(endpoint, 'thread')).toBeNull();
  });

  it('bounds rows, evicts least-used threads and rejects oversized payloads', () => {
    const cache = new ThreadPreviewCache();
    cache.write(
      endpoint,
      '0',
      'bot',
      Array.from({ length: 150 }, (_, index) => row(String(index))),
    );
    expect(cache.read(endpoint, '0')).toHaveLength(100);
    expect(cache.read(endpoint, '0')?.[0]?.id).toBe('50');
    for (let i = 1; i < 8; i++) cache.write(endpoint, String(i), 'bot', [row(String(i))]);
    cache.read(endpoint, '0');
    cache.write(endpoint, '8', 'bot', [row('8')]);
    expect(cache.read(endpoint, '1')).toBeNull();
    expect(cache.read(endpoint, '0')).not.toBeNull();
    cache.write(endpoint, 'huge', 'bot', [row('huge', 'x'.repeat(2 * 1024 * 1024))]);
    expect(cache.read(endpoint, 'huge')).toBeNull();
    cache.clear();
    expect(cache.read(endpoint, '0')).toBeNull();
  });
});
