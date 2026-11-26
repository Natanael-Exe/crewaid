import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { parseCliArgs } from './cli.js';
import {
  buildConnectorWsUrl,
  normalizeServerUrl,
  promptHiddenToken,
  readSavedToken,
  saveToken,
  validateTokenFormat,
} from './token-store.js';

const SAMPLE_TOKEN = 'crw_conn_0123456789abcdef0123456789abcdef';

describe('token-store and URL normalization', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes URLs, builds /ws/connectors with zero query params, and rejects embedded credentials', () => {
    expect(normalizeServerUrl('https://crewaid.example.test/')).toBe(
      'https://crewaid.example.test',
    );
    expect(buildConnectorWsUrl('https://crewaid.example.test/')).toBe(
      'wss://crewaid.example.test/ws/connectors',
    );
    expect(buildConnectorWsUrl('http://127.0.0.1:3000/base/')).toBe(
      'ws://127.0.0.1:3000/base/ws/connectors',
    );
    expect(() => normalizeServerUrl('https://user:pass@crewaid.example.test')).toThrow();
    expect(() => normalizeServerUrl('https://crewaid.example.test#frag')).toThrow();
    expect(() => normalizeServerUrl('ftp://crewaid.example.test')).toThrow();
  });

  it('persists tokens with 0700 directory and 0600 file permissions keyed by (url, dir)', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'crewaid-ts-'));
    dirs.push(tmp);
    const storePath = path.join(tmp, 'crewaid', 'connectors.json');

    saveToken(storePath, 'https://crewaid.example.test/', '/repo/a', SAMPLE_TOKEN);
    expect(readSavedToken(storePath, 'https://crewaid.example.test', '/repo/a')).toBe(SAMPLE_TOKEN);
    expect(readSavedToken(storePath, 'https://crewaid.example.test', '/repo/b')).toBeNull();

    if (process.platform !== 'win32') {
      expect(statSync(path.dirname(storePath)).mode & 0o777).toBe(0o700);
      expect(statSync(storePath).mode & 0o777).toBe(0o600);
    }
  });

  it('prompts for token in raw TTY mode without echoing token characters', async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      isRaw?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    input.isTTY = true;
    input.isRaw = false;
    const rawModes: boolean[] = [];
    input.setRawMode = (mode: boolean) => {
      rawModes.push(mode);
      input.isRaw = mode;
    };

    const output = new PassThrough();
    let rendered = '';
    output.on('data', (chunk: Buffer) => {
      rendered += chunk.toString('utf8');
    });

    const pending = promptHiddenToken({ input, output });
    input.write(`${SAMPLE_TOKEN}\r`);
    const token = await pending;

    expect(token).toBe(SAMPLE_TOKEN);
    expect(rendered).not.toContain(SAMPLE_TOKEN);
    expect(rawModes).toEqual([true, false]);
    expect(validateTokenFormat(token)).toBe(SAMPLE_TOKEN);
    expect(() => validateTokenFormat('not-a-token')).toThrow();
  });

  it('parses CLI flags cleanly and rejects invalid options', () => {
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['harnesses'])).toEqual({ kind: 'harnesses' });
    expect(
      parseCliArgs([
        '/repo',
        '--url',
        'https://crewaid.example.test',
        '--save',
        '--report',
        'full',
        '--trust-server-approvals',
        '--disconnect-grace',
        '45',
        '--allow-harnesses',
        'claude-code,codex',
        '--verbose',
      ]),
    ).toMatchObject({
      kind: 'connect',
      dir: '/repo',
      url: 'https://crewaid.example.test',
      save: true,
      reportMode: 'full',
      trustServerApprovals: true,
      disconnectGraceSec: 45,
      allowHarnesses: ['claude-code', 'codex'],
      verbose: true,
    });
    expect(() => parseCliArgs(['/repo'])).toThrow(/--url/);
    expect(() =>
      parseCliArgs(['/repo', '--url', 'https://x.test', '--report', 'invalid']),
    ).toThrow();
  });
});
