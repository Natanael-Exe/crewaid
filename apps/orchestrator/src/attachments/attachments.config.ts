import path from 'node:path';

/**
 * Artifact storage policy knobs.
 *
 * Read once, at construction, and a malformed value throws there — the
 * `sandbox.config.ts` pattern. A quota that silently reads as `NaN` would
 * admit every upload (`x > NaN` is false), which is the failure mode of a
 * capacity limit that looks configured and is not.
 *
 * Collected in one file rather than inlined next to each reader because the
 * defaults ARE the contract: two copies of "2048" in two services is one
 * edit away from disagreeing.
 */

/**
 * Unclaimed uploads past this age are read-fenced (410) and reaped.
 * M8-BE-07 may move the scheduling into BullMQ.
 */
export const UNCLAIMED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The cumulative artifact quota: the total bytes of every Attachment row
 * (claimed and unclaimed) the host will hold. Two gigabytes is a measurement
 * target for the personal MVP, not a proven guarantee. It protects a local
 * disk, so it applies to the disk store only.
 */
export const DEFAULT_MAX_TOTAL_MB = 2048;

/**
 * The per-user cap: the bytes of every Attachment row one user owns,
 * claimed or not, across every bot. Applies whichever store holds them.
 */
export const DEFAULT_MAX_USER_MB = 10_240;

/** One hour between reaper passes. `0` disables the periodic sweep. */
export const DEFAULT_REAP_INTERVAL_MS = 3_600_000;

/**
 * Disk-pressure floor on the ARTIFACT_DIR volume: below this, uploads are
 * refused even under quota. `0` disables the check. Disk store only.
 */
export const DEFAULT_MIN_FREE_MB = 200;

/** `ARTIFACT_MAX_TOTAL_MB` — the cumulative cap on stored artifact bytes. */
export function readArtifactMaxTotalBytes(raw: string | undefined): number {
  const value = readNumber('ARTIFACT_MAX_TOTAL_MB', raw, DEFAULT_MAX_TOTAL_MB);
  const bytes = value * 1024 * 1024;
  if (!Number.isInteger(value) || value < 1 || !Number.isSafeInteger(bytes)) {
    throw new Error(
      `ARTIFACT_MAX_TOTAL_MB must be a safe integer >= 1, got ${JSON.stringify(raw)}. ` +
        'There is no "disabled" value: storage with room for no artifacts is a ' +
        'misconfiguration, not a policy.',
    );
  }
  return bytes;
}

/** `ARTIFACT_MAX_USER_MB` — the cap on stored artifact bytes per user. */
export function readArtifactMaxUserBytes(raw: string | undefined): number {
  const value = readNumber('ARTIFACT_MAX_USER_MB', raw, DEFAULT_MAX_USER_MB);
  const bytes = value * 1024 * 1024;
  if (!Number.isInteger(value) || value < 1 || !Number.isSafeInteger(bytes)) {
    throw new Error(
      `ARTIFACT_MAX_USER_MB must be a safe integer >= 1, got ${JSON.stringify(raw)}. ` +
        'A user with room for no files is a misconfiguration, not a policy.',
    );
  }
  return bytes;
}

/** `ARTIFACT_REAP_INTERVAL_MS` — how often expired uploads are reaped. */
export function readReapIntervalMs(raw: string | undefined): number {
  const value = readNumber('ARTIFACT_REAP_INTERVAL_MS', raw, DEFAULT_REAP_INTERVAL_MS);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `ARTIFACT_REAP_INTERVAL_MS must be an integer >= 0, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/** `ARTIFACT_REAP_ON_BOOT` — run one reap pass at startup (default on). */
export function readReapOnBoot(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`ARTIFACT_REAP_ON_BOOT must be 'true' or 'false', got ${JSON.stringify(raw)}`);
}

/** `ARTIFACT_MIN_FREE_MB` — free-disk floor on the ARTIFACT_DIR volume. */
export function readMinFreeBytes(raw: string | undefined): number {
  const value = readNumber('ARTIFACT_MIN_FREE_MB', raw, DEFAULT_MIN_FREE_MB);
  const bytes = value * 1024 * 1024;
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(bytes)) {
    throw new Error(`ARTIFACT_MIN_FREE_MB must be a safe integer >= 0, got ${JSON.stringify(raw)}`);
  }
  return bytes;
}

function readNumber(key: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Shared ARTIFACT_DIR resolution; throws loudly when unset. */
export function requireArtifactDir(): string {
  const dir = process.env['ARTIFACT_DIR'];
  if (dir === undefined || dir === '') {
    throw new Error('ARTIFACT_DIR is required for attachment storage (infra/compose/.env.example)');
  }
  return path.resolve(dir);
}
