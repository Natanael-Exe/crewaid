import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScreenTicketClaims } from '@crewaid/shared';
import { SCREEN_TICKET_TTL_MS } from '@crewaid/screen-stream';

/** Process restarts keep the key, so they must also keep consumed ticket IDs. */
export class PersistentTicketReplays {
  private nextSweep = 0;

  constructor(private readonly directory: string) {}

  async claim(claims: ScreenTicketClaims, now: number): Promise<boolean> {
    if (claims.exp <= now) return false;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (now >= this.nextSweep) {
      this.nextSweep = now + SCREEN_TICKET_TTL_MS;
      await this.sweep(now);
    }
    // Hash the verified ID, not the URL's spelling: base64 aliases of the same
    // signed ticket must reserve the same receipt and cannot name a path.
    const receipt = join(this.directory, createHash('sha256').update(claims.jti).digest('hex'));
    let handle;
    try {
      handle = await open(receipt, 'wx', 0o600);
    } catch (error: unknown) {
      if (hasCode(error, 'EEXIST')) return false;
      throw error;
    }
    try {
      await handle.writeFile(`${claims.exp}\n`);
      await handle.sync();
    } finally {
      // A failed or interrupted write still reserves the ID. Deleting it here
      // could admit a replay after an uncertain write or a process crash.
      await handle.close();
    }
    return true;
  }

  private async sweep(now: number): Promise<void> {
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const path = join(this.directory, name);
      try {
        const text = await readFile(path, 'utf8');
        // An incomplete reservation remains spent for the maximum ticket
        // lifetime after its write, rather than treating an empty file as 0.
        const expiry =
          /^[1-9]\d*\n$/.test(text) && Number.isSafeInteger(Number(text))
            ? Number(text)
            : (await stat(path)).mtimeMs + SCREEN_TICKET_TTL_MS;
        if (expiry <= now) await unlink(path);
      } catch (error: unknown) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
    }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
