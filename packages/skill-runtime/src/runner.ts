/**
 * The skill runner — the bridge's in-container execution entry.
 *
 * Reads ONE request from stdin (`{"script": string, "params": object}` — the
 * exact shape the bridge already validated against the M2 contract, D-040) and
 * writes ONE outcome JSON object to the path given in argv[2].
 *
 * Exit codes are about the RUNNER, not the skill:
 * 0 — an outcome was produced and written (a skill that threw is `ok: false`
 * INSIDE that outcome: the bridge asked for a run, and a failed run is
 * an answer).
 * 1 — no outcome could be produced (no workspace, unreadable stdin).
 * 2 — the runner was invoked wrong (no outcome path).
 *
 * The outcome travels through a FILE rather than stdout on purpose: the skill
 * code shares this process, so anything it writes to stdout would corrupt a
 * stdout-framed protocol. Stray output is harmless here; the outcome file is
 * the only channel the bridge reads.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright-core';

import { runSkill, type SkillHost } from './executor.js';
import { createBrowserPage, type BrowserPage } from './browser.js';
import { createDesktopHost } from './host.js';
import type { SkillModule } from './index.js';
import { loadModuleFromSource } from './loader.js';

const USAGE = 'usage: runner.mjs <outcome-file>   (request JSON on stdin)';

export interface SkillRunRequest {
  readonly script: string;
  readonly params: unknown;
}

/** The bridge validated this shape, so a violation here is a runner bug, not input. */
export class SkillRequestError extends Error {}

export function parseRequest(raw: string): SkillRunRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SkillRequestError('request is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SkillRequestError('request must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  const script = record['script'];
  const params = record['params'];
  if (typeof script !== 'string' || script.trim() === '') {
    throw new SkillRequestError('script must be a non-empty string');
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new SkillRequestError('params must be a JSON object');
  }
  return { script, params };
}

export interface RunOneOptions {
  /** Injected in tests; defaults to the real desktop host. */
  readonly host?: SkillHost;
  /** Injected in tests; defaults to loadModuleFromSource under the run's workspace. */
  readonly loadModule?: (workspace: string, source: string) => Promise<SkillModule<unknown>>;
  /**
   * Injected in tests; defaults to the real page — a lazy CDP connection to
   * the Chrome in this container. Lazy matters here: a skill that
   * never touches `ctx.page` never opens a socket.
   */
  readonly page?: BrowserPage;
  /** Seat-local endpoint supplied by the bridge, never by skill parameters. */
  readonly cdpEndpoint?: string;
  readonly botId?: string;
  readonly seatId?: string;
  readonly connectBrowser?: (endpoint: string) => Promise<Browser>;
}

async function connectSeatBrowser(options: RunOneOptions, signal: AbortSignal): Promise<Browser> {
  const { botId, seatId, cdpEndpoint } = options;
  if (!botId || !seatId || !cdpEndpoint)
    throw new Error('Browser replay requires the bridge-authorized private seat.');
  const endpoint = new URL(cdpEndpoint);
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    !endpoint.port ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error('Browser replay requires a seat-local CDP endpoint.');
  const response = await fetch('http://127.0.0.1:7070/seats/browser', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botId }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  if (!response.ok)
    throw new Error(`seat browser unavailable: ${(await response.text()).slice(0, 2000)}`);
  const value: unknown = await response.json();
  const result =
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const raw = result['seat'];
  const seat = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (
    result['ok'] !== true ||
    seat['botId'] !== botId ||
    seat['seatId'] !== seatId ||
    seat['cdpPort'] !== Number(endpoint.port) ||
    seat['browserReady'] !== true ||
    typeof seat['profile'] !== 'string' ||
    typeof seat['browserGeneration'] !== 'number' ||
    !Number.isSafeInteger(seat['browserGeneration']) ||
    seat['browserGeneration'] <= 0
  )
    throw new Error('Browser readiness did not match the authorized private seat.');
  // Chrome reports its internal listening port; use only the authorized relay.
  const discovery = await fetch(new URL('/json/version', endpoint), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: { Connection: 'close' },
  });
  if (!discovery.ok) throw new Error('Seat CDP discovery failed.');
  const metadata: unknown = await discovery.json();
  const version =
    metadata !== null && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  if (typeof version['webSocketDebuggerUrl'] !== 'string')
    throw new Error('Seat CDP discovery returned no browser endpoint.');
  const socket = new URL(version['webSocketDebuggerUrl']);
  if (socket.protocol !== 'ws:' || !socket.pathname.startsWith('/devtools/browser/'))
    throw new Error('Seat CDP discovery returned an invalid browser endpoint.');
  socket.host = endpoint.host;
  socket.username = '';
  socket.password = '';
  socket.search = '';
  socket.hash = '';
  signal.throwIfAborted();
  return options.connectBrowser === undefined
    ? chromium.connectOverCDP(socket.href, { noDefaults: true, timeout: 15_000 })
    : options.connectBrowser(socket.href);
}

/**
 * One full run: parse, execute through a fresh workspace, write the outcome.
 *
 * @returns the runner exit code (0 when an outcome file was written).
 */
export async function runOne(
  raw: string,
  outcomePath: string,
  options: RunOneOptions = {},
): Promise<number> {
  const request = parseRequest(raw);
  const workspace = await mkdtemp(join(tmpdir(), 'crewaid-skill-'));
  const page = options.page ?? createBrowserPage((signal) => connectSeatBrowser(options, signal));
  try {
    const host = options.host ?? createDesktopHost();
    const loadModule =
      options.loadModule ??
      ((space: string, source: string) => loadModuleFromSource(space, source));
    const outcome = await runSkill(request.script, request.params, {
      host,
      loadModule: (source) => loadModule(workspace, source),
      page,
    });
    writeFileSync(outcomePath, JSON.stringify(outcome));
    return 0;
  } finally {
    // The page's socket must not outlive the run: an open WebSocket keeps
    // this process — and the bridge call waiting on it — alive, so closing
    // it here is what lets `main` exit as soon as the outcome exists.
    await page.close().catch(() => undefined);
    // Scratch space, never an artifact. Cleanup must not replace the outcome.
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** CLI seam: `argv` is every argument after `node runner.mjs`. */
export async function main(argv: readonly string[], stdin: string): Promise<number> {
  const outcomePath = argv[0];
  if (outcomePath === undefined || !outcomePath.startsWith('/')) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    return await runOne(stdin, outcomePath, {
      ...(argv[1] ? { cdpEndpoint: argv[1] } : {}),
      ...(argv[2] ? { botId: argv[2] } : {}),
      ...(argv[3] ? { seatId: argv[3] } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    process.stderr.write(`skill runner failed: ${detail}\n`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2), readFileSync(0, 'utf8'));
}
