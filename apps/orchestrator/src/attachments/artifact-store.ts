import type { Readable } from 'node:stream';

/**
 * Where artifact bytes live: attachments, files a bot attaches, and
 * recording click crops.
 *
 * A key is the row's `storageKey` — always server-generated, never a user
 * filename on its own — and every implementation treats it as opaque. An
 * absent object is an answer (`null`, or a no-op delete), not an error: the
 * callers already decide what a missing file means for them (a 500 on
 * download, a skipped crop, a reap that still removes its row).
 */
export interface ArtifactStore {
  readonly kind: 'disk' | 'r2';
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  open(key: string): Promise<Readable | null>;
  delete(key: string): Promise<void>;
}

/** Nest token for the one store this process uses, chosen at boot. */
export const ARTIFACT_STORE = Symbol('ARTIFACT_STORE');
