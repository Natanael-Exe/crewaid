import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScreenTicketClaims } from '@crewaid/shared';

import { PersistentTicketReplays } from './ticket-replays.js';

const NOW = Date.now();
const claims = (jti = 'consumed-ticket', exp = NOW + 60_000): ScreenTicketClaims => ({
  v: 1,
  aud: 'crewaid-screen',
  session: 'computer',
  botId: 'bot',
  port: 5901,
  exp,
  jti,
});

describe('persistent ticket consumption', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ticket-replays-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('refuses a consumed ID after recreating the guard', async () => {
    expect(await new PersistentTicketReplays(directory).claim(claims(), NOW)).toBe(true);
    expect(await new PersistentTicketReplays(directory).claim(claims(), NOW)).toBe(false);
    expect(await new PersistentTicketReplays(directory).claim(claims('fresh-ticket'), NOW)).toBe(
      true,
    );
  });

  it('atomically admits one concurrent claimant, including overlapping processes', async () => {
    const results = await Promise.all([
      new PersistentTicketReplays(directory).claim(claims(), NOW),
      new PersistentTicketReplays(directory).claim(claims(), NOW),
    ]);
    expect(results.sort()).toEqual([false, true]);
  });

  it('keeps an incomplete receipt reserved instead of parsing its prefix as an expiry', async () => {
    await new PersistentTicketReplays(directory).claim(claims(), NOW);
    const name = (await readdir(directory))[0];
    if (name === undefined) throw new Error('no receipt');
    await writeFile(join(directory, name), '1');
    expect(await new PersistentTicketReplays(directory).claim(claims(), NOW + 1)).toBe(false);
  });

  it('removes expired receipts while retaining live ones', async () => {
    const first = new PersistentTicketReplays(directory);
    await first.claim(claims('expired-ticket', NOW + 10), NOW);
    await first.claim(claims('live-ticket'), NOW);
    await new PersistentTicketReplays(directory).claim(claims('new-ticket'), NOW + 11);
    expect(await readdir(directory)).toHaveLength(2);
    expect(
      await new PersistentTicketReplays(directory).claim(claims('live-ticket'), NOW + 11),
    ).toBe(false);
  });

  it('keeps path-like IDs inside the receipt directory and refuses their reuse', async () => {
    const guard = new PersistentTicketReplays(directory);
    expect(await guard.claim(claims('../../outside-ticket'), NOW)).toBe(true);
    expect(await guard.claim(claims('../../outside-ticket'), NOW)).toBe(false);
    expect(await readdir(directory)).toHaveLength(1);
  });

  it('fails closed when receipt storage is unavailable', async () => {
    const file = join(directory, 'not-a-directory');
    await writeFile(file, 'unavailable');
    await expect(new PersistentTicketReplays(file).claim(claims(), NOW)).rejects.toThrow();
  });
});
