import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ArtifactStore } from './artifact-store.js';
import { requireArtifactDir } from './attachments.config.js';

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Artifacts as files under one directory: the self-hosted default.
 *
 * Keys are server-generated, but a key that would resolve outside the root is
 * refused anyway — reads and deletes answer "absent", a write throws — so a
 * corrupted row can never reach a path the server did not mean to touch.
 *
 * With no root given, `ARTIFACT_DIR` is read on each operation rather than at
 * construction, so a server that never stores a file does not need it set —
 * the behaviour this store had before it was a class.
 */
export class DiskArtifactStore implements ArtifactStore {
  readonly kind = 'disk' as const;

  constructor(private readonly fixedRoot?: string) {}

  async put(key: string, bytes: Buffer): Promise<void> {
    const absolute = this.resolve(key);
    if (absolute === null) throw new Error(`artifact key escapes the artifact directory: ${key}`);
    await mkdir(path.dirname(absolute), { recursive: true });
    // Streamed, so a large upload is never copied into a second whole buffer.
    await pipeline(Readable.from(bytes), createWriteStream(absolute));
  }

  async get(key: string): Promise<Buffer | null> {
    const absolute = this.resolve(key);
    if (absolute === null) return null;
    try {
      return await readFile(absolute);
    } catch (error: unknown) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async open(key: string): Promise<Readable | null> {
    const absolute = this.resolve(key);
    if (absolute === null) return null;
    // Stat first: a stream opened on a missing file fails only once it is
    // read, after the response headers have gone out as a 200.
    try {
      await stat(absolute);
    } catch (error: unknown) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    return createReadStream(absolute);
  }

  async delete(key: string): Promise<void> {
    const absolute = this.resolve(key);
    if (absolute === null) return;
    try {
      await unlink(absolute);
    } catch (error: unknown) {
      if (!isMissingFile(error)) throw error;
    }
  }

  private resolve(key: string): string | null {
    const root = path.resolve(this.fixedRoot ?? requireArtifactDir());
    const absolute = path.resolve(root, key);
    return absolute.startsWith(root + path.sep) ? absolute : null;
  }
}
