/**
 * The real `SkillHost` — desktop commands via `xdotool` and `scrot` inside the
 * bot container.
 *
 * This is the only module in the package that touches the OS, and it is
 * bounds-first for the same reason the bridge is: the code on the other side
 * of these calls is model-generated, so a wedged X server or a runaway capture
 * must fail the RUN — quickly and with a readable reason — not the container.
 *
 * The capture bounds deliberately mirror infra/sandbox-image's bridge
 * (10 s timeout, 25 MiB cap, PNG signature) — one capture contract, two call
 * sites, so a screenshot taken by a skill and one taken by the bridge cannot
 * disagree about what a valid capture is.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SkillHost } from './executor.js';

export const COMMAND_TIMEOUT_MS = 30_000;
export const SCREENSHOT_TIMEOUT_MS = 10_000;
export const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Runs one program with an argv (never a shell string) and a hard timeout. */
export type CommandExecutor = (
  program: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<void>;

export interface DesktopHostOptions {
  /** Injected in tests; defaults to child_process.execFile. */
  readonly exec?: CommandExecutor;
  /** Injected in tests; defaults to a fresh private path under the temp dir. */
  readonly screenshotPath?: () => string;
  /** Injected in tests; defaults to MAX_SCREENSHOT_BYTES. */
  readonly maxScreenshotBytes?: number;
}

/**
 * At most `limit` bytes of a file, or a refusal.
 *
 * One byte over is read deliberately: it is what distinguishes "exactly at the
 * limit" from "larger than the limit" without reading the rest.
 */
async function readCapped(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0);
    if (bytesRead > limit) throw new Error(`screenshot exceeds ${limit} bytes`);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function createDesktopHost(options: DesktopHostOptions = {}): SkillHost {
  const exec = options.exec ?? execFileCommand;
  const screenshotPath = options.screenshotPath ?? temporaryScreenshotPath;
  const maxScreenshotBytes = options.maxScreenshotBytes ?? MAX_SCREENSHOT_BYTES;

  return {
    runCommand(program: string, args: readonly string[]): Promise<void> {
      return exec(program, args, COMMAND_TIMEOUT_MS);
    },

    async captureScreenshot(): Promise<Buffer> {
      const path = screenshotPath();
      try {
        await exec('scrot', ['--overwrite', path], SCREENSHOT_TIMEOUT_MS);
        // Bounded at the READ, not after it — the same shape as the bridge's
        // `screenshot.read(MAX_SCREENSHOT_BYTES + 1)`. Reading the whole file
        // first and measuring afterwards is a cap that has already been paid:
        // whatever `scrot` wrote is in this process's memory by then, and this
        // process is the one every skill step runs through.
        const data = await readCapped(path, maxScreenshotBytes);
        if (!data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
          throw new Error('scrot did not produce a PNG');
        }
        return data;
      } finally {
        // The temp file is scratch space, never an artifact: the buffer is the
        // screenshot. A failed unlink must not replace the real error.
        await rm(path, { force: true }).catch(() => undefined);
      }
    },

    delay(ms: number): Promise<void> {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    },

    now(): number {
      return performance.now();
    },
  };
}

function temporaryScreenshotPath(): string {
  return join(tmpdir(), `crewaid-skill-shot-${randomBytes(8).toString('hex')}.png`);
}

function execFileCommand(
  program: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      program,
      [...args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve();
          return;
        }
        reject(new Error(describeExecFailure(program, timeoutMs, error, stderr)));
      },
    );
  });
}

function describeExecFailure(
  program: string,
  timeoutMs: number,
  error: Error & { killed?: boolean },
  stderr: string,
): string {
  if (error.killed === true) return `${program} timed out after ${timeoutMs}ms`;
  const detail = stderr.trim().slice(0, 300);
  return detail === '' ? `${program} failed: ${error.message}` : `${program} failed: ${detail}`;
}
