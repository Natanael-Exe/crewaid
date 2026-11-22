import { describe, expect, it } from 'vitest';
import { readSandboxProvider } from '../src/sandbox/sandbox.config.js';

const NONE = {
  digitalOceanToken: false,
  cloudflareControlSecret: false,
  runtimeApiKey: false,
  instaboxApiKey: false,
};
const DO = { ...NONE, digitalOceanToken: true };
const CF = { ...NONE, cloudflareControlSecret: true };
const RT = { ...NONE, runtimeApiKey: true };
const IB = { ...NONE, instaboxApiKey: true };
const BOTH = {
  digitalOceanToken: true,
  cloudflareControlSecret: true,
  runtimeApiKey: true,
  instaboxApiKey: true,
};

describe('sandbox provider selection (D-150, D-151, D-217)', () => {
  it('defaults to Docker, for local development and self-hosting', () => {
    expect(readSandboxProvider({}, NONE)).toEqual({ kind: 'docker' });
    expect(readSandboxProvider({ SANDBOX_PROVIDER: ' docker ' }, NONE)).toEqual({
      kind: 'docker',
    });
  });

  it('selects DigitalOcean with its template and defaults', () => {
    expect(
      readSandboxProvider(
        { SANDBOX_PROVIDER: 'digitalocean', SANDBOX_DO_TEMPLATE: 'crewaid-sandbox' },
        DO,
      ),
    ).toEqual({
      kind: 'digitalocean',
      template: 'crewaid-sandbox',
      size: 'mars-4vcpu-8gb',
      baseAdapter: 'opencode',
    });
    expect(
      readSandboxProvider(
        {
          SANDBOX_PROVIDER: 'digitalocean',
          SANDBOX_DO_TEMPLATE: 't',
          SANDBOX_DO_SIZE: 'mars-16vcpu-32gb',
          SANDBOX_DO_BASE_ADAPTER: 'codex',
        },
        DO,
      ),
    ).toMatchObject({ size: 'mars-16vcpu-32gb', baseAdapter: 'codex' });
  });

  it('fails the boot instead of falling back to Docker', () => {
    // A typo that silently ran customers' computers on the orchestrator's own
    // host is the outcome nobody configured.
    expect(() => readSandboxProvider({ SANDBOX_PROVIDER: 'digital-ocean' }, BOTH)).toThrow(
      'SANDBOX_PROVIDER must be "docker", "digitalocean", "cloudflare", "runtime" or "instabox"',
    );
    expect(() =>
      readSandboxProvider({ SANDBOX_PROVIDER: 'digitalocean', SANDBOX_DO_TEMPLATE: 't' }, NONE),
    ).toThrow('DIGITALOCEAN_ACCESS_TOKEN');
    expect(() => readSandboxProvider({ SANDBOX_PROVIDER: 'digitalocean' }, DO)).toThrow(
      'SANDBOX_DO_TEMPLATE',
    );
  });

  it('selects Cloudflare with its control Worker, keeping only the origin', () => {
    expect(
      readSandboxProvider(
        {
          SANDBOX_PROVIDER: 'cloudflare',
          SANDBOX_CF_CONTROL_URL: 'https://crewaid-computers.example.workers.dev/',
        },
        CF,
      ),
    ).toEqual({ kind: 'cloudflare', controlUrl: 'https://crewaid-computers.example.workers.dev' });
  });

  it('refuses Cloudflare without its secret, its URL, or over plain HTTP', () => {
    const url = { SANDBOX_CF_CONTROL_URL: 'https://w.example.workers.dev' };
    expect(() => readSandboxProvider({ SANDBOX_PROVIDER: 'cloudflare', ...url }, DO)).toThrow(
      'SANDBOX_CF_CONTROL_SECRET',
    );
    expect(() => readSandboxProvider({ SANDBOX_PROVIDER: 'cloudflare' }, CF)).toThrow(
      'SANDBOX_CF_CONTROL_URL',
    );
    // The secret travels with every request.
    expect(() =>
      readSandboxProvider(
        { SANDBOX_PROVIDER: 'cloudflare', SANDBOX_CF_CONTROL_URL: 'http://w.example.workers.dev' },
        CF,
      ),
    ).toThrow('https://');
  });

  it('selects Runtime with its image and a 4 vCPU / 8 GiB default size', () => {
    expect(
      readSandboxProvider(
        { SANDBOX_PROVIDER: 'runtime', SANDBOX_RUNTIME_IMAGE: ' crewaid-sandbox:v0.0.9 ' },
        RT,
      ),
    ).toEqual({
      kind: 'runtime',
      image: 'crewaid-sandbox:v0.0.9',
      vcpu: 4,
      memoryMiB: 8192,
      diskMiB: 20_480,
    });
    expect(
      readSandboxProvider(
        {
          SANDBOX_PROVIDER: 'runtime',
          SANDBOX_RUNTIME_IMAGE: 'crewaid-sandbox',
          SANDBOX_RUNTIME_VCPU: '8',
          SANDBOX_RUNTIME_MEMORY_MIB: '16384',
          SANDBOX_RUNTIME_DISK_MIB: '40960',
        },
        RT,
      ),
    ).toMatchObject({ vcpu: 8, memoryMiB: 16_384, diskMiB: 40_960 });
  });

  it('refuses Runtime without its key, its image, or a size it can run', () => {
    const base = { SANDBOX_PROVIDER: 'runtime', SANDBOX_RUNTIME_IMAGE: 'crewaid-sandbox' };
    expect(() => readSandboxProvider(base, NONE)).toThrow('RUNTIME_API_KEY');
    expect(() => readSandboxProvider({ SANDBOX_PROVIDER: 'runtime' }, RT)).toThrow(
      'SANDBOX_RUNTIME_IMAGE',
    );
    expect(() => readSandboxProvider({ ...base, SANDBOX_RUNTIME_VCPU: '1.5' }, RT)).toThrow(
      'SANDBOX_RUNTIME_VCPU must be an integer from 1 to 16',
    );
    expect(() => readSandboxProvider({ ...base, SANDBOX_RUNTIME_VCPU: '32' }, RT)).toThrow(
      'SANDBOX_RUNTIME_VCPU',
    );
    expect(() => readSandboxProvider({ ...base, SANDBOX_RUNTIME_MEMORY_MIB: 'lots' }, RT)).toThrow(
      'SANDBOX_RUNTIME_MEMORY_MIB must be a number',
    );
    expect(() => readSandboxProvider({ ...base, SANDBOX_RUNTIME_DISK_MIB: '1024' }, RT)).toThrow(
      'SANDBOX_RUNTIME_DISK_MIB',
    );
  });

  it('selects Instabox only when explicitly configured, defaulting image and template without forcing a paid size', () => {
    // Providing INSTABOX_API_KEY alone must never silently switch off Docker.
    expect(readSandboxProvider({}, IB)).toEqual({ kind: 'docker' });

    expect(readSandboxProvider({ SANDBOX_PROVIDER: 'instabox' }, IB)).toEqual({
      kind: 'instabox',
      image: 'ghcr.io/natanael-exe/crewaid-sandbox:latest',
      template: 'agent-browser',
    });

    expect(
      readSandboxProvider(
        {
          SANDBOX_PROVIDER: 'instabox',
          SANDBOX_INSTABOX_IMAGE: ' ghcr.io/natanael-exe/crewaid-sandbox:0.1.4 ',
          SANDBOX_INSTABOX_TEMPLATE: 'universal',
          SANDBOX_INSTABOX_VCPU: '8',
          SANDBOX_INSTABOX_MEMORY_MIB: '16384',
          INSTABOX_API_URL: 'https://api.instabox.example/v1/',
        },
        IB,
      ),
    ).toEqual({
      kind: 'instabox',
      image: 'ghcr.io/natanael-exe/crewaid-sandbox:0.1.4',
      template: 'universal',
      vcpus: 8,
      memoryMiB: 16_384,
      apiUrl: 'https://api.instabox.example',
    });
  });

  it('refuses Instabox without its key, with a half-specified size, out-of-range size, or plain HTTP API URL', () => {
    expect(() => readSandboxProvider({ SANDBOX_PROVIDER: 'instabox' }, NONE)).toThrow(
      'INSTABOX_API_KEY',
    );
    expect(() =>
      readSandboxProvider({ SANDBOX_PROVIDER: 'instabox', SANDBOX_INSTABOX_VCPU: '4' }, IB),
    ).toThrow('SANDBOX_INSTABOX_VCPU and SANDBOX_INSTABOX_MEMORY_MIB must be set together');
    expect(() =>
      readSandboxProvider(
        { SANDBOX_PROVIDER: 'instabox', SANDBOX_INSTABOX_MEMORY_MIB: '8192' },
        IB,
      ),
    ).toThrow('SANDBOX_INSTABOX_VCPU and SANDBOX_INSTABOX_MEMORY_MIB must be set together');
    expect(() =>
      readSandboxProvider(
        {
          SANDBOX_PROVIDER: 'instabox',
          SANDBOX_INSTABOX_VCPU: '32',
          SANDBOX_INSTABOX_MEMORY_MIB: '8192',
        },
        IB,
      ),
    ).toThrow('SANDBOX_INSTABOX_VCPU must be an integer from 1 to 16');
    expect(() =>
      readSandboxProvider(
        {
          SANDBOX_PROVIDER: 'instabox',
          SANDBOX_INSTABOX_VCPU: '4',
          SANDBOX_INSTABOX_MEMORY_MIB: '512',
        },
        IB,
      ),
    ).toThrow('SANDBOX_INSTABOX_MEMORY_MIB must be an integer from 1024 to 65536');
    expect(() =>
      readSandboxProvider(
        { SANDBOX_PROVIDER: 'instabox', INSTABOX_API_URL: 'http://api.instabox.sh' },
        IB,
      ),
    ).toThrow('https://');
  });
});
