import { describe, expect, it } from 'vitest';

import {
  McpTransportError,
  mcpTransportConfig,
  parseMcpTransport,
} from '../src/mcp/mcp-transport.js';

/**
 * M6-BE-01 — the two transports §6/M6 admits and the one it refuses.
 *
 * The refusal is the case with teeth. `transport` is typed as the shared
 * `McpTransport` union, so nothing in this repo can spell `stdio` without a
 * cast — but the value originates in a Prisma string column, and D-018's rule
 * is that schema and code deploy together or not at all. A row written by a
 * build that admitted a third transport arrives here as a string that merely
 * claims to be an enum, and the difference between a named error and a spawned
 * third-party process is this function.
 */

describe('parseMcpTransport', () => {
  it('admits the two transports §6/M6 names', () => {
    expect(parseMcpTransport('HTTP')).toBe('HTTP');
    expect(parseMcpTransport('SSE')).toBe('SSE');
  });

  const refused: readonly (readonly [unknown, string])[] = [
    ['stdio', 'the transport the PRD puts out of scope'],
    ['STDIO', 'the same transport, shouted — the enum is not case-insensitive'],
    ['websocket', 'a transport MCP does not have, so a typo rather than a plan'],
    ['', 'an empty string, which is what a column that never got a value carries'],
    [undefined, 'a row read before the column existed'],
    [null, 'the JSON spelling of the same thing'],
    [1, 'a number where an enum is expected'],
    [{ type: 'stdio' }, 'an object that says stdio in a field name'],
  ];

  // `%j` prints the value and `%s` the reason the case exists, so a failure
  // reads as the thing that was refused rather than as an index.
  it.each(refused)('refuses %j (%s)', (value, _reason) => {
    expect(() => parseMcpTransport(value)).toThrow(McpTransportError);
  });

  it('names what it refused, in the operator’s words, and says where stdio would run', () => {
    let thrown: unknown;
    try {
      parseMcpTransport('stdio');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpTransportError);
    const error = thrown as McpTransportError;
    expect(error.code).toBe('MCP_TRANSPORT_UNSUPPORTED');
    // The value itself, so an operator reading a log knows what was typed…
    expect(error.message).toContain('"stdio"');
    // …and the reason, so the next person does not "fix" it by adding the case
    // to the map above: a stdio server is a process, and the process that would
    // spawn it here holds every credential R10 exists to keep out of one.
    expect(error.message).toContain('container');
  });

  it('reports the type, not a stringified value, when the value is not a string', () => {
    expect(() => parseMcpTransport({ type: 'stdio' })).toThrow(/object/);
  });
});

describe('mcpTransportConfig', () => {
  const stubFetch = (() => Promise.reject(new Error('not called'))) as unknown as typeof fetch;

  it('maps each admitted transport onto the SDK’s spelling', () => {
    expect(
      mcpTransportConfig({ url: 'https://mcp.example.com/', transport: 'HTTP', fetch: stubFetch })
        .type,
    ).toBe('http');
    expect(
      mcpTransportConfig({ url: 'https://mcp.example.com/', transport: 'SSE', fetch: stubFetch })
        .type,
    ).toBe('sse');
  });

  it('sends every request through the caller’s fetch, refusing redirects', async () => {
    // A permitted host that answers 302 defeats a check on the original URL,
    // so the redirect policy rides on every request whatever fetch is given.
    const seen: (RequestInit | undefined)[] = [];
    const recording: typeof fetch = (_input, init) => {
      seen.push(init);
      return Promise.resolve(new Response('{}'));
    };
    const config = mcpTransportConfig({
      url: 'https://mcp.example.com/',
      transport: 'HTTP',
      fetch: recording,
    });
    expect(config.url).toBe('https://mcp.example.com/');
    await config.fetch?.('https://mcp.example.com/', { method: 'POST', redirect: 'follow' });
    expect(seen).toEqual([{ method: 'POST', redirect: 'error' }]);
  });

  it('copies headers instead of holding the caller’s record', () => {
    const headers: Record<string, string> = { authorization: 'Bearer one' };
    const config = mcpTransportConfig({
      url: 'https://mcp.example.com/',
      transport: 'HTTP',
      headers,
      fetch: stubFetch,
    });
    // The SDK reads this object per request; a record mutated after the call is
    // a caller deciding to change live request headers, which is how a token
    // from one server ends up on another's socket.
    headers['authorization'] = 'Bearer two';
    expect(config.headers).toEqual({ authorization: 'Bearer one' });
  });

  it('sends no headers for a server that has none', () => {
    const config = mcpTransportConfig({
      url: 'https://mcp.example.com/',
      transport: 'HTTP',
      fetch: stubFetch,
    });
    expect(config.headers).toEqual({});
  });
});
