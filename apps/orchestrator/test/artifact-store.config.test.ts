import { describe, expect, it } from 'vitest';

import { readArtifactStorage } from '../src/attachments/artifact-store.config.js';

const R2 = {
  ARTIFACT_R2_ACCOUNT_ID: 'acct',
  ARTIFACT_R2_ACCESS_KEY_ID: 'key',
  ARTIFACT_R2_SECRET_ACCESS_KEY: 'secret',
  ARTIFACT_R2_BUCKET: 'bucket',
};

describe('readArtifactStorage (D-220)', () => {
  it('chooses R2 when all four keys are set, in either edition', () => {
    for (const edition of ['cloud', 'selfhosted'] as const) {
      expect(readArtifactStorage({ ...R2, NODE_ENV: 'production' }, edition)).toEqual({
        kind: 'r2',
        accountId: 'acct',
        accessKeyId: 'key',
        bucket: 'bucket',
      });
    }
  });

  it('refuses a production cloud server with no R2', () => {
    expect(() => readArtifactStorage({ NODE_ENV: 'production' }, 'cloud')).toThrow(
      /CREWAID_EDITION=cloud stores files in R2 only/,
    );
  });

  it('lets a cloud server outside production fall back to disk, and says so', () => {
    expect(readArtifactStorage({ NODE_ENV: 'test' }, 'cloud')).toEqual({
      kind: 'disk',
      cloudOutsideProduction: true,
    });
  });

  it('keeps a self-hosted server without R2 on disk, even in production', () => {
    expect(readArtifactStorage({ NODE_ENV: 'production' }, 'selfhosted')).toEqual({
      kind: 'disk',
      cloudOutsideProduction: false,
    });
  });

  it('refuses some keys without the others, naming what is missing', () => {
    for (const edition of ['cloud', 'selfhosted'] as const) {
      expect(() =>
        readArtifactStorage(
          { ARTIFACT_R2_ACCOUNT_ID: 'acct', ARTIFACT_R2_BUCKET: 'bucket' },
          edition,
        ),
      ).toThrow(/missing ARTIFACT_R2_ACCESS_KEY_ID, ARTIFACT_R2_SECRET_ACCESS_KEY/);
    }
  });

  it('counts an empty or blank value as unset, as compose passes ${KEY:-}', () => {
    const blank = {
      ARTIFACT_R2_ACCOUNT_ID: '',
      ARTIFACT_R2_ACCESS_KEY_ID: ' ',
      ARTIFACT_R2_SECRET_ACCESS_KEY: '',
      ARTIFACT_R2_BUCKET: '',
    };
    expect(readArtifactStorage({ ...blank, NODE_ENV: 'production' }, 'selfhosted').kind).toBe(
      'disk',
    );
    expect(() =>
      readArtifactStorage({ ...R2, ARTIFACT_R2_BUCKET: '  ', NODE_ENV: 'production' }, 'cloud'),
    ).toThrow(/missing ARTIFACT_R2_BUCKET/);
  });
});
