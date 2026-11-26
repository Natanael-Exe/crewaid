import { describe, expect, it } from 'vitest';
import { harnessEnvironment } from './connector-client.js';

describe('harnessEnvironment', () => {
  it('keeps the connector token away from the coding harness and keeps everything else', () => {
    const env = harnessEnvironment({
      CREWAID_CONNECTOR_TOKEN: 'crw_conn_secret_value_0123456789',
      PATH: '/usr/bin',
      HOME: '/Users/me',
      ANTHROPIC_API_KEY: 'sk-ant-user-own-key',
    });

    expect(env['CREWAID_CONNECTOR_TOKEN']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/Users/me');
    // The user's own harness credentials stay: the harness needs them to run.
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-user-own-key');
  });
});
