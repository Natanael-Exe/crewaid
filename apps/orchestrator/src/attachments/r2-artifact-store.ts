import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { AwsClient } from 'aws4fetch';
import type { ArtifactStore } from './artifact-store.js';

export type R2Config = {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly bucket: string;
};

type FetchFn = (request: Request) => Promise<Response>;

/**
 * Artifacts as objects in one Cloudflare R2 bucket, over its S3 API.
 *
 * The orchestrator keeps nothing on its own disk in this mode: a write sends
 * the bytes it already holds, a download streams R2's body straight into the
 * response. The only file that reads `ARTIFACT_R2_SECRET_ACCESS_KEY`.
 *
 * A failure names the operation and the status, never R2's body — an S3
 * error document is a vendor string, and it would otherwise reach a log line
 * an operator pastes somewhere.
 */
export class R2ArtifactStore implements ArtifactStore {
  readonly kind = 'r2' as const;
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(
    config: R2Config,
    private readonly fetchFn: FetchFn = (request) => fetch(request),
    secretAccessKey: string = readSecret(),
  ) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey,
      service: 's3',
      region: 'auto',
    });
    this.base = `https://${config.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(config.bucket)}`;
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const response = await this.send(key, {
      method: 'PUT',
      headers: { 'content-type': contentType, 'content-length': String(bytes.length) },
      body: bytes,
    });
    await this.expectOk('put', response);
  }

  async get(key: string): Promise<Buffer | null> {
    const response = await this.send(key, { method: 'GET' });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    await this.expectOk('get', response, false);
    return Buffer.from(await response.arrayBuffer());
  }

  async open(key: string): Promise<Readable | null> {
    const response = await this.send(key, { method: 'GET' });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    await this.expectOk('open', response, false);
    if (response.body === null) return Readable.from([]);
    return Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  }

  async delete(key: string): Promise<void> {
    const response = await this.send(key, { method: 'DELETE' });
    // S3 answers 204 for a key that never existed; a 404 is absence too.
    if (response.status === 404) {
      await response.body?.cancel();
      return;
    }
    await this.expectOk('delete', response);
  }

  private async send(key: string, init: RequestInit): Promise<Response> {
    const request = await this.client.sign(this.urlFor(key), init);
    return this.fetchFn(request);
  }

  private urlFor(key: string): string {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async expectOk(operation: string, response: Response, drain = true): Promise<void> {
    if (response.ok) {
      if (drain) await response.body?.cancel();
      return;
    }
    await response.body?.cancel();
    throw new Error(`R2 ${operation} failed with HTTP ${response.status}`);
  }
}

function readSecret(): string {
  const secret = (process.env['ARTIFACT_R2_SECRET_ACCESS_KEY'] ?? '').trim();
  if (secret === '') throw new Error('ARTIFACT_R2_SECRET_ACCESS_KEY is required for R2 storage');
  return secret;
}
