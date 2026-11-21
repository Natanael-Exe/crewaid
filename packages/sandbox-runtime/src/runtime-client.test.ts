import { afterEach, describe, expect, it } from 'vitest';

import { RuntimeApiError, SdkRuntimeApi, runtimeApiKeyConfigured } from './runtime-client.js';

const KEY = 'RUNTIME_API_KEY';
const saved = process.env[KEY];

afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe('the SDK adapter (D-217)', () => {
  it('refuses to start without a key, rather than using a login saved on the machine', () => {
    for (const value of [undefined, '', '   ']) {
      if (value === undefined) delete process.env[KEY];
      else process.env[KEY] = value;
      expect(runtimeApiKeyConfigured()).toBe(false);
      expect(() => new SdkRuntimeApi()).toThrow(RuntimeApiError);
      try {
        new SdkRuntimeApi();
      } catch (error) {
        expect(error).toMatchObject({ code: 'missing_api_key', unauthorized: true });
      }
    }
  });

  it('builds a client from the key without calling the API', () => {
    process.env[KEY] = 'rt_test_not_a_real_key';
    expect(runtimeApiKeyConfigured()).toBe(true);
    expect(() => new SdkRuntimeApi({ baseUrl: 'http://127.0.0.1:9' })).not.toThrow();
  });
});
