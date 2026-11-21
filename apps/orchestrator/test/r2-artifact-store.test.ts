import { describe, expect, it } from 'vitest';

import { R2ArtifactStore } from '../src/attachments/r2-artifact-store.js';

const CONFIG = { accountId: 'acct123', accessKeyId: 'AKIDEXAMPLE', bucket: 'crewaid-artifacts' };
const BUCKET_URL = 'https://acct123.r2.cloudflarestorage.com/crewaid-artifacts';

type Seen = { method: string; url: string; headers: Headers; body: Buffer | null };

/** A fake R2 that records each signed request and answers from a script. */
function fakeR2(answer: (seen: Seen) => Response) {
  const requests: Seen[] = [];
  const fetchFn = async (request: Request): Promise<Response> => {
    const body = request.body === null ? null : Buffer.from(await request.arrayBuffer());
    const seen = { method: request.method, url: request.url, headers: request.headers, body };
    requests.push(seen);
    return answer(seen);
  };
  return { requests, store: new R2ArtifactStore(CONFIG, fetchFn, 'secret-example') };
}

describe('R2ArtifactStore (D-220)', () => {
  it('PUTs the bytes to the bucket, signed, with their content type', async () => {
    const { requests, store } = fakeR2(() => new Response(null, { status: 200 }));
    const bytes = Buffer.from('hello');

    await store.put('2026-10-13/abc-report.pdf', bytes, 'application/pdf');

    const [put] = requests;
    expect(put?.method).toBe('PUT');
    expect(put?.url).toBe(`${BUCKET_URL}/2026-10-13/abc-report.pdf`);
    expect(put?.headers.get('content-type')).toBe('application/pdf');
    expect(put?.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/,
    );
    expect(put?.body).toEqual(bytes);
  });

  it('encodes each key segment but keeps the slashes', async () => {
    const { requests, store } = fakeR2(() => new Response(null, { status: 204 }));

    await store.delete('recordings/rec 1/a#b.png');

    expect(requests[0]?.url).toBe(`${BUCKET_URL}/recordings/rec%201/a%23b.png`);
  });

  it('reads an object, and answers null for one that is absent', async () => {
    const { store } = fakeR2(({ url }) =>
      url.endsWith('/present')
        ? new Response(Buffer.from('bytes'), { status: 200 })
        : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }),
    );

    expect(await store.get('present')).toEqual(Buffer.from('bytes'));
    expect(await store.get('absent')).toBeNull();
    expect(await store.open('absent')).toBeNull();
  });

  it('streams a download body rather than buffering it', async () => {
    const { store } = fakeR2(() => new Response(Buffer.from('streamed'), { status: 200 }));

    const stream = await store.open('key');
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk as Uint8Array));

    expect(Buffer.concat(chunks).toString()).toBe('streamed');
  });

  it('treats deleting an absent object as done', async () => {
    const { store } = fakeR2(() => new Response(null, { status: 404 }));

    await expect(store.delete('gone')).resolves.toBeUndefined();
  });

  it('fails with the operation and status, never the body R2 sent', async () => {
    const { store } = fakeR2(
      () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }),
    );

    const failure = store.put('k', Buffer.from('x'), 'text/plain');
    await expect(failure).rejects.toThrow('R2 put failed with HTTP 403');
    await expect(failure).rejects.not.toThrow(/AccessDenied/);
    await expect(store.get('k')).rejects.toThrow('R2 get failed with HTTP 403');
    await expect(store.delete('k')).rejects.toThrow('R2 delete failed with HTTP 403');
  });
});
