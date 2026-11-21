import { describe, expect, it } from 'vitest';
import type { TokenStoreReadResult, TokenStoreWriteResult } from '../src/preload';
import {
  checkFailureMessage,
  draftChanged,
  draftFromStore,
  EMPTY_DRAFT,
  saveFailureMessage,
  storeIssue,
  toTokenBag,
} from '../src/renderer/settings/connectionForm';
import { addressIssue } from '../src/renderer/launch/launchState';

/**
 * The General pane's whole job is diagnosing a connection that does not work,
 * so the failures are the part worth pinning: each one is reachable only with
 * a differently-broken orchestrator, which is not something a manual pass over
 * a working install will ever walk through.
 */
describe('addressIssue — the one address validator', () => {
  // These cases moved here with the validator. `draftIssue` also demanded a
  // session token, which V1-18 removed as a field: nothing an operator can
  // type produces one, so refusing to save an address without it deadlocked
  // the only screen that could set the address in the first place.
  it('names the missing field rather than failing generically', () => {
    expect(addressIssue('')).toContain('address');
    expect(addressIssue('   ')).toContain('address');
  });

  it('rejects a bare host, which is the mistake operators actually make', () => {
    // `new URL('localhost:3000')` does not throw — it parses as the scheme
    // "localhost:" — so the scheme check has to be separate from the parse.
    expect(addressIssue('localhost:3000')).toContain('http://');
    expect(addressIssue('not a url')).toContain('valid URL');
  });

  it('accepts http, https, a port, and a reverse-proxy subpath', () => {
    expect(addressIssue('http://localhost:3000')).toBeNull();
    expect(addressIssue('https://crewaid.example.com/orchestrator')).toBeNull();
  });

  it('ignores surrounding whitespace, which a paste routinely carries', () => {
    expect(addressIssue(' http://localhost:3000 ')).toBeNull();
  });

  it('never asks for a token, because there is no way to type one', () => {
    expect(addressIssue('http://localhost:3000')).toBeNull();
    expect(addressIssue('')).not.toContain('token');
  });
});

describe('draftFromStore', () => {
  it('pre-fills a configured store so changing one field does not retype the other', () => {
    const result: TokenStoreReadResult = {
      status: 'configured',
      credentials: { orchestratorBaseUrl: 'http://localhost:3000', orchestratorToken: 'tok' },
    };
    expect(draftFromStore(result)).toEqual({ baseUrl: 'http://localhost:3000', token: 'tok' });
  });

  it('starts empty on first run and on every failure to read', () => {
    expect(draftFromStore({ status: 'missing' })).toEqual(EMPTY_DRAFT);
    expect(draftFromStore({ status: 'error', code: 'IPC_ERROR' })).toEqual(EMPTY_DRAFT);
  });

  it('tolerates a half-written bag rather than rendering "undefined"', () => {
    expect(
      draftFromStore({ status: 'configured', credentials: { orchestratorToken: 'tok' } }),
    ).toEqual({ baseUrl: '', token: 'tok' });
  });
});

describe('storeIssue', () => {
  it('says nothing about first run — that is the state this pane exists to leave', () => {
    expect(storeIssue({ status: 'missing' })).toBeNull();
    expect(storeIssue({ status: 'configured', credentials: {} })).toBeNull();
  });

  it('warns when the machine cannot encrypt, because every later save will fail too', () => {
    expect(storeIssue({ status: 'unavailable', code: 'ENCRYPTION_UNAVAILABLE' })).toContain(
      'cannot encrypt',
    );
  });

  it('separates a disk failure from an IPC one', () => {
    expect(storeIssue({ status: 'error', code: 'STORAGE_ERROR' })).toContain('disk');
    expect(storeIssue({ status: 'error', code: 'UNAUTHORIZED' })).toContain('credential store');
  });
});

describe('checkFailureMessage', () => {
  it('blames the address for a dead connection and the token for a 401', () => {
    expect(checkFailureMessage({ code: 'NETWORK', message: 'x' })).toContain('Nothing answered');
    expect(checkFailureMessage({ code: 'UNAUTHORIZED', message: 'x' })).toContain(
      'rejected this token',
    );
  });

  it('reads a 404 as the wrong address, not as a missing model', () => {
    // The §4.1 routes live under /api/v1; a host that answers but 404s there
    // is a real server at the wrong address, and "Not found." would send the
    // operator looking for a resource instead of fixing the URL.
    expect(checkFailureMessage({ code: 'NOT_FOUND', message: 'Not found.' })).toContain(
      'no orchestrator API',
    );
  });

  it('falls back to the normalized copy for codes it has nothing better to say about', () => {
    expect(
      checkFailureMessage({ code: 'UNKNOWN', message: 'Something went wrong. Try again.' }),
    ).toBe('Something went wrong. Try again.');
  });
});

describe('saveFailureMessage', () => {
  it('is null only when the write actually landed', () => {
    expect(saveFailureMessage({ status: 'saved' })).toBeNull();
    expect(saveFailureMessage({ status: 'cleared' })).toBeNull();
  });

  it('covers every write failure the store can report', () => {
    const failures: TokenStoreWriteResult[] = [
      { status: 'unavailable', code: 'ENCRYPTION_UNAVAILABLE' },
      { status: 'invalid', code: 'INVALID_CREDENTIALS' },
      { status: 'error', code: 'STORAGE_ERROR' },
      { status: 'error', code: 'IPC_ERROR' },
      { status: 'error', code: 'UNAUTHORIZED' },
    ];
    for (const failure of failures) {
      expect(saveFailureMessage(failure)).toBeTruthy();
    }
  });
});

describe('draftChanged', () => {
  it('compares trimmed values, so a stray space does not arm Save', () => {
    const saved = { baseUrl: 'http://localhost:3000', token: 'tok' };
    expect(draftChanged({ baseUrl: 'http://localhost:3000 ', token: ' tok' }, saved)).toBe(false);
    expect(draftChanged({ baseUrl: 'http://localhost:3001', token: 'tok' }, saved)).toBe(true);
  });
});

describe('toTokenBag', () => {
  it('writes trimmed values — a trailing space in a URL is invisible and fatal', () => {
    expect(toTokenBag({ baseUrl: ' http://localhost:3000 ', token: ' tok ' })).toEqual({
      orchestratorBaseUrl: 'http://localhost:3000',
      orchestratorToken: 'tok',
    });
  });
});
