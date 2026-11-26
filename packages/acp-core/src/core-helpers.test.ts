import { describe, expect, it } from 'vitest';
import { computeLocalTaskPayloadHash, normalizeRelativeCwd } from './payload-hash.js';
import {
  boundSummary,
  CODE_OMITTED_MARKER,
  formatDiffExcerpt,
  MAX_SUMMARY_ONLY_CHARS,
  relativizeReportedPath,
  sanitizeOneLine,
} from './privacy.js';
import {
  assertSupportedNodeVersion,
  BUILTIN_ACP_HARNESSES,
  detectInstalledHarnesses,
  parseCommandLine,
  resolveHarnessCommand,
} from './harnesses.js';

describe('payload-hash', () => {
  it('produces identical SHA-256 hex for equivalent relativeCwd spellings', () => {
    const base = {
      botId: 'bot_1',
      connectorId: 'conn_1',
      harness: 'claude-code',
      prompt: 'Fix the failing test',
    };
    const h1 = computeLocalTaskPayloadHash({ ...base, relativeCwd: '' });
    const h2 = computeLocalTaskPayloadHash({ ...base, relativeCwd: '.' });
    const h3 = computeLocalTaskPayloadHash({ ...base, relativeCwd: './' });
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
    expect(normalizeRelativeCwd('./apps/web/')).toBe('apps/web');
    expect(() => normalizeRelativeCwd('../outside')).toThrow();
    expect(() => normalizeRelativeCwd('apps/../../outside')).toThrow();
    expect(() => normalizeRelativeCwd('/etc/passwd')).toThrow();
    expect(() => normalizeRelativeCwd('C:\\Windows')).toThrow();
  });

  it('changes hash whenever bot, connector, folder, harness, prompt, or verifyCommand changes', () => {
    const base = {
      botId: 'bot_1',
      connectorId: 'conn_1',
      relativeCwd: 'apps/desktop',
      harness: 'claude-code',
      prompt: 'Refactor header',
      verifyCommand: 'pnpm test',
    };
    const ref = computeLocalTaskPayloadHash(base);
    expect(computeLocalTaskPayloadHash({ ...base, botId: 'bot_2' })).not.toBe(ref);
    expect(computeLocalTaskPayloadHash({ ...base, connectorId: 'conn_2' })).not.toBe(ref);
    expect(computeLocalTaskPayloadHash({ ...base, relativeCwd: 'apps/orchestrator' })).not.toBe(
      ref,
    );
    expect(computeLocalTaskPayloadHash({ ...base, harness: 'codex' })).not.toBe(ref);
    expect(computeLocalTaskPayloadHash({ ...base, prompt: 'Refactor header!' })).not.toBe(ref);
    expect(computeLocalTaskPayloadHash({ ...base, verifyCommand: 'pnpm build' })).not.toBe(ref);
  });
});

describe('privacy helpers', () => {
  it('relativizes paths inside cwd and collapses outside host paths to basename', () => {
    expect(relativizeReportedPath('/Users/alice/repo', '/Users/alice/repo/src/index.ts')).toBe(
      'src/index.ts',
    );
    expect(relativizeReportedPath('/Users/alice/repo', '/Users/alice/.ssh/id_ed25519')).toBe(
      'id_ed25519',
    );
  });

  it('strips newlines and truncates single-line step titles', () => {
    expect(sanitizeOneLine('line1\n\tline2   line3', 20)).toBe('line1 line2 line3');
    expect(sanitizeOneLine('a'.repeat(50), 10)).toBe('aaaaaaaaa…');
  });

  it('keeps code out of a summary-only final message, and caps it', () => {
    const message =
      'Fixed the token refresh.\n```ts\nconst SECRET = "sk-live-123";\n```\nTests pass.\n~~~\nleft open';
    const summary = boundSummary('summary', message);
    expect(summary).not.toContain('sk-live-123');
    expect(summary).not.toContain('left open');
    expect(summary).toContain('Fixed the token refresh.');
    expect(summary).toContain('Tests pass.');
    expect(summary).toContain(CODE_OMITTED_MARKER);

    expect(boundSummary('summary', 'x'.repeat(10_000)).length).toBeLessThanOrEqual(
      MAX_SUMMARY_ONLY_CHARS,
    );
    expect(boundSummary('full', message)).toContain('sk-live-123');
  });

  it('never formats diff excerpts in summary mode', () => {
    expect(formatDiffExcerpt('summary', '/repo', '/repo/a.ts', 'old', 'new')).toBeUndefined();
    const full = formatDiffExcerpt('full', '/repo', '/repo/a.ts', 'old', 'new');
    expect(full).toContain('--- a.ts');
    expect(full).toContain('- old');
    expect(full).toContain('+ new');
  });
});

describe('harnesses', () => {
  it('uses current official ACP harness binaries and args', () => {
    expect(BUILTIN_ACP_HARNESSES['claude-code']).toMatchObject({
      command: 'claude-agent-acp',
      args: [],
      minNodeMajor: 22,
    });
    expect(BUILTIN_ACP_HARNESSES['codex']).toMatchObject({
      command: 'codex-acp',
      args: [],
      minNodeMajor: 22,
    });
    expect(BUILTIN_ACP_HARNESSES['opencode']).toMatchObject({
      command: 'opencode',
      args: ['acp'],
    });
    expect(BUILTIN_ACP_HARNESSES['antigravity']).toMatchObject({
      command: 'agy',
      args: ['acp'],
    });
  });

  it('detects installed harnesses on PATH cleanly', () => {
    const available = new Set(['/usr/local/bin/claude-agent-acp', '/opt/bin/agy']);
    const detected = detectInstalledHarnesses({
      pathEnv: '/usr/local/bin:/opt/bin',
      platform: 'darwin',
      isExecutable: (p) => available.has(p),
    });
    expect(detected.map((h) => h.id)).toEqual(['claude-code', 'antigravity']);
    expect(detected[0]?.resolvedPath).toBe('/usr/local/bin/claude-agent-acp');
  });

  it('parses custom commands without invoking a shell and rejects malformed quotes', () => {
    expect(parseCommandLine('my-agent --mode "acp mode" --flag \'a b\'')).toEqual([
      'my-agent',
      '--mode',
      'acp mode',
      '--flag',
      'a b',
    ]);
    expect(resolveHarnessCommand('custom', '/usr/local/bin/my-acp --verbose')).toEqual({
      id: 'custom',
      label: 'my-acp',
      command: '/usr/local/bin/my-acp',
      args: ['--verbose'],
    });
    expect(() => parseCommandLine('my-agent "unterminated')).toThrow(/unterminated/);
    expect(() => parseCommandLine('   ')).toThrow(/binary name/);
  });

  it('enforces Node >= 22', () => {
    expect(() => assertSupportedNodeVersion('22.0.0')).not.toThrow();
    expect(() => assertSupportedNodeVersion('24.20.0')).not.toThrow();
    expect(() => assertSupportedNodeVersion('20.18.1')).toThrow(/Node\.js >= 22/);
  });
});
