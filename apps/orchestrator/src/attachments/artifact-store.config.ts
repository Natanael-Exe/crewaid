import type { Edition } from '@crewaid/shared';
import type { ArtifactStore } from './artifact-store.js';
import { DiskArtifactStore } from './disk-artifact-store.js';
import { R2ArtifactStore } from './r2-artifact-store.js';

/** The four keys that select R2: all of them, or none. */
export const R2_KEYS = [
  'ARTIFACT_R2_ACCOUNT_ID',
  'ARTIFACT_R2_ACCESS_KEY_ID',
  'ARTIFACT_R2_SECRET_ACCESS_KEY',
  'ARTIFACT_R2_BUCKET',
] as const;

export type ArtifactStorageChoice =
  | {
      readonly kind: 'disk';
      /** A cloud server outside production, which would refuse this in production. */
      readonly cloudOutsideProduction: boolean;
    }
  | {
      readonly kind: 'r2';
      readonly accountId: string;
      readonly accessKeyId: string;
      readonly bucket: string;
    };

/**
 * Which store this server uses, decided once at boot.
 *
 * A cloud server in production keeps no files on its own disk, so it refuses
 * to start without R2 rather than quietly writing to a volume that is one
 * host's only copy. Every cloud deploy runs as production (the image sets
 * `NODE_ENV=production`); outside it — local development, the test suites and
 * the e2e servers, which all run as `cloud` — a missing R2 falls back to
 * `ARTIFACT_DIR`, the same line `useSecureCookies` draws. A self-hosted server
 * uses R2 when it is configured and its `ARTIFACT_DIR` otherwise. Some keys without the others is a typo, not a
 * choice — either edition refuses it, because guessing would put files
 * somewhere the operator did not configure.
 *
 * An empty value counts as unset, so a compose file can pass `${KEY:-}`.
 */
export function readArtifactStorage(
  env: Readonly<Record<string, string | undefined>>,
  edition: Edition,
): ArtifactStorageChoice {
  const value = (key: (typeof R2_KEYS)[number]): string => (env[key] ?? '').trim();
  const missing = R2_KEYS.filter((key) => value(key) === '');

  if (missing.length === 0) {
    return {
      kind: 'r2',
      accountId: value('ARTIFACT_R2_ACCOUNT_ID'),
      accessKeyId: value('ARTIFACT_R2_ACCESS_KEY_ID'),
      bucket: value('ARTIFACT_R2_BUCKET'),
    };
  }
  if (missing.length < R2_KEYS.length) {
    throw new Error(
      `R2 artifact storage is partly configured: missing ${missing.join(', ')}. ` +
        'Set all four ARTIFACT_R2_* keys or none (infra/compose/.env.example).',
    );
  }
  const production = (env['NODE_ENV'] ?? '').trim() === 'production';
  if (edition === 'cloud' && production) {
    throw new Error(
      `CREWAID_EDITION=cloud stores files in R2 only: set ${R2_KEYS.join(', ')} ` +
        '(infra/compose/.env.example).',
    );
  }
  return { kind: 'disk', cloudOutsideProduction: edition === 'cloud' };
}

export function createArtifactStore(choice: ArtifactStorageChoice): ArtifactStore {
  if (choice.kind === 'r2') return new R2ArtifactStore(choice);
  return new DiskArtifactStore();
}
