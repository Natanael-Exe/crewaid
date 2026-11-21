import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));

const originalArgv = process.argv;
const exited = new Error('packager exited');
const scriptUrl = new URL('../scripts/package.mjs', import.meta.url).href;

beforeEach(() => {
  vi.resetModules();
  vi.mocked(spawnSync).mockClear();
  vi.stubEnv('CSC_LINK', '');
  vi.stubEnv('APPLE_API_KEY', '');
  vi.stubEnv('APPLE_API_KEY_ID', '');
  vi.stubEnv('APPLE_API_ISSUER', '');
  vi.stubEnv('CREWAID_ORCHESTRATOR_URL', 'https://orchestrator.example');
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw exited;
  });
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function packageEdition(edition: string): Promise<readonly string[]> {
  process.argv = [process.execPath, 'package.mjs', edition, '--mac', '--dir'];
  await expect(import(scriptUrl)).rejects.toBe(exited);
  expect(spawnSync).toHaveBeenCalledOnce();
  return vi.mocked(spawnSync).mock.calls[0]?.[1] as readonly string[];
}

describe('macOS packaging identity', () => {
  it.each(['cloud', 'selfhosted'])(
    'binds the %s bundle without a Developer ID',
    async (edition) => {
      const args = await packageEdition(edition);
      expect(args).toContain('-c.mac.identity=-');
      expect(args).toContain('-c.mac.hardenedRuntime=false');
      expect(args).not.toContain('-c.mac.identity=null');
      // An ad-hoc signature cannot authenticate an automatic update.
      expect(args).toContain('-c.extraMetadata.crewaid.macSigned=false');
      expect(args).not.toContain('-c.mac.notarize=true');
    },
  );

  it('does not forward an empty certificate variable, which electron-builder reads as a path', async () => {
    vi.stubEnv('CSC_LINK', '');
    vi.stubEnv('CSC_KEY_PASSWORD', '');
    await packageEdition('cloud');
    const options = vi.mocked(spawnSync).mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env).not.toHaveProperty('CSC_LINK');
    expect(options.env).not.toHaveProperty('CSC_KEY_PASSWORD');
    expect(options.env.CSC_FOR_PULL_REQUEST).toBe('true');
  });

  it('keeps certificate signing, hardened runtime and automatic updates for Developer ID builds', async () => {
    vi.stubEnv('CSC_LINK', 'certificate-fixture.p12');
    const args = await packageEdition('cloud');
    expect(args.some((arg) => arg.startsWith('-c.mac.identity='))).toBe(false);
    expect(args).not.toContain('-c.mac.hardenedRuntime=false');
    expect(args).toContain('-c.extraMetadata.crewaid.macSigned=true');
  });

  it('notarizes only when both the Developer ID and App Store Connect key are supplied', async () => {
    vi.stubEnv('APPLE_API_KEY', 'key-fixture.p8');
    vi.stubEnv('APPLE_API_KEY_ID', 'key-id-fixture');
    vi.stubEnv('APPLE_API_ISSUER', 'issuer-fixture');
    expect(await packageEdition('cloud')).not.toContain('-c.mac.notarize=true');

    vi.resetModules();
    vi.mocked(spawnSync).mockClear();
    vi.stubEnv('CSC_LINK', 'certificate-fixture.p12');
    expect(await packageEdition('cloud')).toContain('-c.mac.notarize=true');
  });
});
