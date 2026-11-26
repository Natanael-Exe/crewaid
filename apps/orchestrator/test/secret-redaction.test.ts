import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { StructuredLogger } from '../src/logging/structured-logger.js';
import { BullSkillCompileQueue, SKILL_COMPILE_JOB } from '../src/skills/skill-compile.queue.js';

/**
 * V1-16 — a key does not get out, and the test proves the door was open.
 *
 * ── THE RULE THIS FILE IS ORGANISED AROUND ──────────────────────────────────
 *
 * Assert an absence against a presence. A redaction test that never puts a key
 * in front of the logger passes on a logger that was never called, on a sink
 * that dropped everything, and on a redactor that deletes its input. So every
 * case here checks TWO things: the secret is gone, and the message that
 * carried it still arrived.
 *
 * ── WHAT DRIVING IT FOUND ───────────────────────────────────────────────────
 *
 * `sanitizeText` redacted a secret that sat next to a key NAME — `x-api-key:
 * sk-ant-…` — and nothing else. Two of the three supported vendors do not 401
 * in that shape:
 *
 *   OpenAI      `Incorrect API key provided: sk-proj-…`  — "provided" is not a
 *                                                          sensitive word
 *   OpenRouter  `No auth credentials found (sk-or-v1-…)` — no assignment at all
 *
 * Both leaked into the orchestrator's log. `VENDOR_KEY_TEXT` closes it.
 *
 * It also found the redactor eating its own output: `sanitizeText` runs twice
 * on a Nest message, and the second pass rebuilt `[REDACTED]` as
 * `[REDACTED]]`. Cosmetic, but a redactor that is not idempotent is one nobody
 * can reason about.
 */

/** Not a real key. Long enough and shaped like the vendors' own. */
const KEY = 'sk-proj-V116xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const ANT_KEY = 'sk-ant-api03-V116xxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const OR_KEY = 'sk-or-v1-V116xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

/** A logger writing to a sink this test can read back. */
function capture(): { logger: StructuredLogger; lines: () => Promise<string> } {
  const sink = new PassThrough();
  const chunks: string[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  const logger = new StructuredLogger(pino({ level: 'debug' }, sink) as never);
  return {
    logger,
    lines: async () => {
      // Pino writes asynchronously; a test that read too early would see an
      // empty sink and call it redaction.
      await new Promise((resolve) => setTimeout(resolve, 40));
      return chunks.join('');
    },
  };
}

describe('V1-16 — a provider key never reaches the log', () => {
  it('redacts every shape the three supported vendors 401 in', async () => {
    const { logger, lines } = capture();

    logger.log(`invalid x-api-key: ${ANT_KEY}`);
    logger.log(`Incorrect API key provided: ${KEY}. You can find your API key at …`);
    logger.log(`No auth credentials found (${OR_KEY})`);

    const output = await lines();

    for (const secret of [KEY, ANT_KEY, OR_KEY]) {
      expect(output).not.toContain(secret);
    }
    // THE PRESENCE. Without these three the case passes on a logger that was
    // never called and on a sink that dropped every line.
    expect(output).toContain('invalid x-api-key');
    expect(output).toContain('Incorrect API key provided');
    expect(output).toContain('No auth credentials found');
    expect(output.match(/\[REDACTED\]/g)?.length).toBe(3);
  });

  it('keeps the operator’s diagnostic, which is the reason the log has it at all', async () => {
    // D-006 bars vendor text from the TRANSCRIPT and deliberately allows it in
    // the log, because the operator sentence says "check logs for detail". The
    // fix narrows what "detail" includes rather than removing it: this still
    // says the key was rejected, and by which header.
    const { logger, lines } = capture();
    logger.log(`AUTH_FAILED — invalid x-api-key: ${ANT_KEY}`);

    const output = await lines();
    expect(output).toContain('AUTH_FAILED');
    expect(output).toContain('invalid x-api-key: [REDACTED]');
  });

  it('redacts the other services’ key shapes too, with no key name beside them', async () => {
    // Fixtures assembled at run time so no scanner reads them as real keys.
    const tail = 'V116xxxxxxxxxxxxxxxxxxxxxxxx';
    const others = [
      `sk_${tail}`, // ElevenLabs, Stripe secret
      `rk_live_${tail}`, // Stripe restricted
      `whsec_${tail}`, // Stripe webhook
      `ghp_${tail}`, // GitHub
      `github_pat_${tail}`,
      `xoxb-${tail}`, // Slack
      `AIza${tail}xxxxxxxx`, // Google
      `crw_conn_${tail}`, // Crewaid local connector token
    ];
    const { logger, lines } = capture();
    for (const secret of others) logger.log(`upstream refused ${secret} today`);

    const output = await lines();
    for (const secret of others) expect(output).not.toContain(secret);
    expect(output.match(/upstream refused \[REDACTED\] today/g)?.length).toBe(others.length);
  });

  it('redacts a key with no key name anywhere near it', async () => {
    const { logger, lines } = capture();
    logger.log(`the key ${KEY} was rejected`);
    logger.log(`rotated ${KEY} out of the ring`);

    const output = await lines();
    expect(output).not.toContain(KEY);
    expect(output).toContain('was rejected');
    expect(output).toContain('rotated');
  });

  it('is idempotent, so sanitising twice does not corrupt the message', async () => {
    // `sanitizeText` runs once in `log()` and again when `sanitizeFields`
    // walks the payload. Before V1-16 the second pass matched `[REDACTED`
    // and rebuilt it as `[REDACTED]]`.
    const { logger, lines } = capture();
    logger.log(`x-api-key: ${ANT_KEY}`);

    const output = await lines();
    expect(output).toContain('x-api-key: [REDACTED]');
    expect(output).not.toContain('[REDACTED]]');
  });

  it('redacts a key carried as a structured field, however deep', async () => {
    const { logger, lines } = capture();
    logger.info('provider.refused', {
      apiKey: KEY,
      nested: { credential: KEY, note: 'kept' },
    });

    const output = await lines();
    expect(output).not.toContain(KEY);
    expect(output).toContain('provider.refused');
    // The presence, again: the surrounding object survived the redaction.
    expect(output).toContain('kept');
  });

  it('redacts a key riding on a thrown Error, which is how a provider failure arrives', async () => {
    const { logger, lines } = capture();
    const error = new Error(`Incorrect API key provided: ${KEY}`);

    logger.error(error.message, error.stack);

    const output = await lines();
    expect(output).not.toContain(KEY);
    expect(output).toContain('Incorrect API key provided');
  });

  it('does not redact a model id that merely looks technical', async () => {
    // The other direction, and the reason `VENDOR_KEY_TEXT` is narrow rather
    // than "anything long and random": a redactor that eats `gpt-5.1` or a
    // cuid makes every log useless and nobody notices until an incident.
    const { logger, lines } = capture();
    logger.log('resolved claude-opus-4-5 on connection cmu5jk2nw00021f3b4p313zg6');

    const output = await lines();
    expect(output).toContain('claude-opus-4-5');
    expect(output).toContain('cmu5jk2nw00021f3b4p313zg6');
    expect(output).not.toContain('[REDACTED]');
  });
});

describe('V1-16 — a provider key never reaches the queue', () => {
  it('enqueues a recording id and nothing else', async () => {
    // A job payload is written once and read by another process, possibly
    // minutes later, possibly after a restart — so anything in it outlives the
    // request that made it. The compile worker re-reads the owner from the row
    // and asks the vault itself (V1-10); the payload carries no credential
    // because it carries almost nothing.
    const added: unknown[] = [];
    const queue = new BullSkillCompileQueue({
      add: (name: string, data: unknown) => {
        added.push({ name, data });
        return Promise.resolve();
      },
    } as never);

    await queue.enqueue('cmu5jk2nw00021f3b4p313zg6');

    expect(added).toEqual([
      { name: SKILL_COMPILE_JOB, data: { recordingId: 'cmu5jk2nw00021f3b4p313zg6' } },
    ]);
    // The presence: something really was enqueued, so "no credential in the
    // payload" is a statement about a payload that exists.
    expect(added).toHaveLength(1);
  });
});
