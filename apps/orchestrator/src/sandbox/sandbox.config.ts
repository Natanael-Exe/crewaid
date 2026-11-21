/**
 * The §7/§8 lifecycle knobs (M2-BE-11, D-039 §11).
 *
 * Read once, at construction, and a malformed value throws there — the
 * `auth.guard.ts` pattern. A ceiling that silently reads as `NaN` would admit
 * every start (`n >= NaN` is false), which is the failure mode of a capacity
 * limit that looks configured and is not.
 *
 * Collected in one file rather than inlined next to each reader because the
 * defaults ARE the contract: D-039 §11 names them, and two copies of "6" in
 * two services is one edit away from disagreeing.
 */

/**
 * §7.5's sizing — six concurrent bots on 8 vCPU / 16 GB. A measurement target,
 * not a proven guarantee; M2-QA-09 records the real numbers and this is
 * expected to move.
 */
export const DEFAULT_MAX_RUNNING = 6;

/** Thirty minutes. `0` disables idle stop, matching SANDBOX_HEALTH_INTERVAL_MS. */
export const DEFAULT_IDLE_STOP_MS = 1_800_000;

export function readWorkspaceRetentionMs(raw: string | undefined): number {
  const days = readNumber('SANDBOX_WORKSPACE_RETENTION_DAYS', raw, 7);
  if (!Number.isSafeInteger(days) || days < 1 || !Number.isSafeInteger(days * 86_400_000)) {
    throw new Error('SANDBOX_WORKSPACE_RETENTION_DAYS must be a positive whole number of days');
  }
  return days * 86_400_000;
}

/** `SANDBOX_MAX_RUNNING` — the host capacity ceiling. */
export function readMaxRunning(raw: string | undefined): number {
  const value = readNumber('SANDBOX_MAX_RUNNING', raw, DEFAULT_MAX_RUNNING);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `SANDBOX_MAX_RUNNING must be an integer >= 1, got ${JSON.stringify(raw)}. ` +
        'There is no "disabled" value: a host with room for no sandboxes is a ' +
        'misconfiguration, not a policy.',
    );
  }
  return value;
}

/** `SANDBOX_IDLE_STOP_MS` — how long a sandbox may sit doing nothing (§8). */
export function readIdleStopMs(raw: string | undefined): number {
  const value = readNumber('SANDBOX_IDLE_STOP_MS', raw, DEFAULT_IDLE_STOP_MS);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`SANDBOX_IDLE_STOP_MS must be an integer >= 0, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Where customer computers run (D-150, D-151, D-217). One provider per deployment. */
export type SandboxProviderConfig =
  | { readonly kind: 'docker' }
  | {
      readonly kind: 'digitalocean';
      readonly template: string;
      readonly size: string;
      readonly baseAdapter: string;
    }
  | { readonly kind: 'cloudflare'; readonly controlUrl: string }
  | {
      readonly kind: 'runtime';
      readonly image: string;
      readonly vcpu: number;
      readonly memoryMiB: number;
      readonly diskMiB: number;
    };

/** What the boot check may know about each provider's credential: whether it is set. */
export interface ProviderCredentials {
  readonly digitalOceanToken: boolean;
  readonly cloudflareControlSecret: boolean;
  readonly runtimeApiKey: boolean;
}

/**
 * `SANDBOX_PROVIDER` and what the chosen one needs, read at boot.
 *
 * An unknown provider, or a hosted one without its credential or target,
 * throws here: a deployment that fell back to Docker because of a typo would
 * run customers' computers on the orchestrator's own host, which is the one
 * outcome nobody configured. Credentials are asked about rather than read, so
 * each stays in the one file that uses it.
 */
export function readSandboxProvider(
  env: Readonly<Record<string, string | undefined>>,
  credentials: ProviderCredentials,
): SandboxProviderConfig {
  const raw = (env['SANDBOX_PROVIDER'] ?? '').trim();
  if (raw === '' || raw === 'docker') return { kind: 'docker' };
  if (raw === 'cloudflare') return readCloudflare(env, credentials.cloudflareControlSecret);
  if (raw === 'runtime') return readRuntime(env, credentials.runtimeApiKey);
  if (raw !== 'digitalocean') {
    throw new Error(
      'SANDBOX_PROVIDER must be "docker", "digitalocean", "cloudflare" or "runtime", ' +
        `got ${JSON.stringify(raw)}`,
    );
  }
  if (!credentials.digitalOceanToken) {
    throw new Error('SANDBOX_PROVIDER=digitalocean needs DIGITALOCEAN_ACCESS_TOKEN');
  }
  const template = (env['SANDBOX_DO_TEMPLATE'] ?? '').trim();
  if (template === '') {
    throw new Error(
      'SANDBOX_PROVIDER=digitalocean needs SANDBOX_DO_TEMPLATE, the custom template built ' +
        'from the sandbox image',
    );
  }
  return {
    kind: 'digitalocean',
    template,
    size: (env['SANDBOX_DO_SIZE'] ?? '').trim() || 'mars-4vcpu-8gb',
    baseAdapter: (env['SANDBOX_DO_BASE_ADAPTER'] ?? '').trim() || 'opencode',
  };
}

function readCloudflare(
  env: Readonly<Record<string, string | undefined>>,
  hasSecret: boolean,
): SandboxProviderConfig {
  if (!hasSecret) {
    throw new Error('SANDBOX_PROVIDER=cloudflare needs SANDBOX_CF_CONTROL_SECRET');
  }
  const raw = (env['SANDBOX_CF_CONTROL_URL'] ?? '').trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      'SANDBOX_PROVIDER=cloudflare needs SANDBOX_CF_CONTROL_URL, the control Worker’s URL',
    );
  }
  // The secret goes with every request; over plain HTTP it would travel in clear.
  if (url.protocol !== 'https:') {
    throw new Error('SANDBOX_CF_CONTROL_URL must be an https:// URL');
  }
  return { kind: 'cloudflare', controlUrl: url.origin };
}

function readRuntime(
  env: Readonly<Record<string, string | undefined>>,
  hasKey: boolean,
): SandboxProviderConfig {
  if (!hasKey) {
    throw new Error('SANDBOX_PROVIDER=runtime needs RUNTIME_API_KEY');
  }
  const image = (env['SANDBOX_RUNTIME_IMAGE'] ?? '').trim();
  if (image === '') {
    throw new Error(
      'SANDBOX_PROVIDER=runtime needs SANDBOX_RUNTIME_IMAGE, the sandbox image on Runtime: ' +
        'crewaid-sandbox:latest follows releases (packages/sandbox-runtime/scripts/build-image.mjs)',
    );
  }
  // Runtime's own bounds for one sandbox, so a typo fails the boot rather
  // than every computer's first start.
  return {
    kind: 'runtime',
    image,
    vcpu: readBoundedInteger('SANDBOX_RUNTIME_VCPU', env['SANDBOX_RUNTIME_VCPU'], 4, 1, 16),
    memoryMiB: readBoundedInteger(
      'SANDBOX_RUNTIME_MEMORY_MIB',
      env['SANDBOX_RUNTIME_MEMORY_MIB'],
      8192,
      1024,
      65_536,
    ),
    diskMiB: readBoundedInteger(
      'SANDBOX_RUNTIME_DISK_MIB',
      env['SANDBOX_RUNTIME_DISK_MIB'],
      20_480,
      8192,
      409_600,
    ),
  };
}

function readBoundedInteger(
  key: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = readNumber(key, raw, fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function readNumber(key: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}
