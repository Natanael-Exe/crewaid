import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { COMMAND_TIMEOUT_MS, createDesktopHost, SCREENSHOT_TIMEOUT_MS } from './host.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);

describe('createDesktopHost', () => {
  it('passes commands through with the desktop command timeout', async () => {
    const seen: { program: string; args: readonly string[]; timeoutMs: number }[] = [];
    const host = createDesktopHost({
      exec: (program, args, timeoutMs) => {
        seen.push({ program, args, timeoutMs });
        return Promise.resolve();
      },
    });
    await host.runCommand('xdotool', ['mousemove', '1', '2']);
    expect(seen).toEqual([
      { program: 'xdotool', args: ['mousemove', '1', '2'], timeoutMs: COMMAND_TIMEOUT_MS },
    ]);
  });

  it('captures through scrot, validates the PNG, and removes the temp file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crewaid-host-test-'));
    const path = join(directory, 'shot.png');
    const host = createDesktopHost({
      exec: (program, args, timeoutMs) => {
        expect(program).toBe('scrot');
        expect(timeoutMs).toBe(SCREENSHOT_TIMEOUT_MS);
        return writeFile(args[1] as string, PNG);
      },
      screenshotPath: () => path,
    });
    await expect(host.captureScreenshot()).resolves.toEqual(PNG);
    await expect(readFile(path)).rejects.toThrow();
  });

  it('rejects output that is not a PNG and still removes the temp file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crewaid-host-test-'));
    const path = join(directory, 'shot.png');
    const host = createDesktopHost({
      exec: () => writeFile(path, 'not an image'),
      screenshotPath: () => path,
    });
    await expect(host.captureScreenshot()).rejects.toThrow('scrot did not produce a PNG');
    await expect(readFile(path)).rejects.toThrow();
  });

  it('rejects a capture over the byte cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crewaid-host-test-'));
    const path = join(directory, 'shot.png');
    const host = createDesktopHost({
      exec: () => writeFile(path, Buffer.concat([PNG, Buffer.alloc(64)])),
      screenshotPath: () => path,
      maxScreenshotBytes: 32,
    });
    await expect(host.captureScreenshot()).rejects.toThrow('screenshot exceeds 32 bytes');
  });

  it('propagates a scrot failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crewaid-host-test-'));
    const path = join(directory, 'shot.png');
    const host = createDesktopHost({
      exec: () => Promise.reject(new Error('scrot timed out after 10000ms')),
      screenshotPath: () => path,
    });
    await expect(host.captureScreenshot()).rejects.toThrow('scrot timed out after 10000ms');
  });
});
