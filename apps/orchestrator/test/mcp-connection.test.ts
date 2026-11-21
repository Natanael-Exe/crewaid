import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { openMcpConnection, type McpConnection } from '../src/mcp/mcp-connection.js';
import { McpProtocolError } from '../src/mcp/mcp-tools.js';
import { McpTransportError } from '../src/mcp/mcp-transport.js';
import { EndpointRefusedError } from '../src/providers/endpoint-guard.js';

/**
 * M6-BE-01 — the client, against a server that speaks the actual protocol.
 *
 * The stub below is a real HTTP server answering JSON-RPC, not a mocked fetch.
 * That distinction is the point: the failure this suite exists to catch is a
 * client that is wired up wrong in a way a mocked fetch cannot see — the wrong
 * content type, a missing `capabilities.tools`, a handshake that never
 * completed, a cursor that is sent under the wrong key.
 *
 * Two eras are exercised because this SDK speaks two. Streamable HTTP servers
 * that support `server/discover` take the modern path (§ the stub's first
 * request is a discovery probe, not `initialize`); everything else takes the
 * legacy `initialize` handshake, which is also the only path the separate
 * HTTP+SSE transport has. M6-BE-01 admits both transports, so both are driven
 * here end to end.
 *
 * The fetch is passed in for these tests because the default is the GUARDED
 * fetch (D-085), which refuses `http://` and every private address — including
 * the loopback address a test server must listen on. That the default is not
 * the platform fetch is itself asserted below, by the stub receiving nothing.
 */

type RecordedRequest = {
  method: string;
  params: Record<string, unknown> | undefined;
  headers: IncomingHttpHeaders;
};

type StubServer = {
  /** `http://127.0.0.1:<port>/` — loopback, which the guarded fetch refuses. */
  readonly origin: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
};

/** A tool list shaped like a server with more tools than fit in one page. */
function toolPage(cursor: string | undefined): { tools: unknown[]; nextCursor?: string } {
  if (cursor === undefined) {
    return {
      tools: [
        {
          name: 'list_invoices',
          description: 'Lists invoices',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'send_invoice',
          description: 'Sends one invoice',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
          annotations: { readOnlyHint: false },
        },
      ],
      nextCursor: 'page-2',
    };
  }
  if (cursor === 'page-2') {
    return {
      tools: [
        // No description and no annotations: the shape §3 stores as ''/undefined.
        { name: 'ping', inputSchema: { type: 'object' } },
      ],
    };
  }
  throw new Error(`the stub was asked for cursor ${JSON.stringify(cursor)}`);
}

function requestMeta(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const meta = params?.['_meta'];
  return meta !== null && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
}

/**
 * The version the client announced, echoed back as supported.
 *
 * The SDK keeps its protocol version internal, so a stub that hardcoded one
 * would start failing the day the SDK bumps it — for a reason that has nothing
 * to do with this client. Answering with what was asked for keeps the case
 * about the handshake, and the assertion that a discovery probe happened at
 * all is what pins the era.
 */
function announcedVersion(params: Record<string, unknown> | undefined): string {
  const announced = requestMeta(params)['io.modelcontextprotocol/protocolVersion'];
  if (typeof announced !== 'string') {
    throw new Error('the client sent no protocol version to discover against');
  }
  return announced;
}

function jsonRpcResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  // `resultType` is not decoration: the modern era refuses a result without
  // it, which is the protocol's way of saying this is not a legacy answer.
  return { jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } };
}

/** The 2026 spec requires a cacheable result to say how long it may be cached. */
const LIST_CACHE = { ttlMs: 0, cacheScope: 'private' } as const;

function respond(message: {
  id?: unknown;
  method: string;
  params?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  if (message.id === undefined) return undefined; // a notification, not a question
  const id = message.id;

  switch (message.method) {
    case 'server/discover':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'complete',
          supportedVersions: [announcedVersion(message.params)],
          capabilities: { tools: { listChanged: false } },
          instructions: 'Stub server. Every tool here is a fixture.',
          _meta: {
            'io.modelcontextprotocol/serverInfo': { name: 'stub-server', version: '1.2.3' },
          },
        },
      };

    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: message.params?.['protocolVersion'],
          capabilities: { tools: {} },
          serverInfo: { name: 'sse-stub', version: '0.4.2' },
        },
      };

    case 'tools/list': {
      const cursor = message.params?.['cursor'];
      if (typeof cursor !== 'string' && cursor !== undefined) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'cursor is not a string' } };
      }
      const page = toolPage(cursor);
      return jsonRpcResult(id, {
        tools: page.tools,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        ...LIST_CACHE,
      });
    }

    case 'tools/call': {
      const name = message.params?.['name'];
      const args = message.params?.['arguments'];
      if (name === 'refuse') {
        // A JSON-RPC application error: the call did not happen, and the
        // client must see it as an error rather than as an empty result.
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: refuse' } };
      }
      if (name === 'explode') {
        // The other kind of failure: the tool ran, and it says so in-band.
        // §6/M6's failure isolation reads this; the client must not throw it.
        return jsonRpcResult(id, { content: [{ type: 'text', text: 'boom' }], isError: true });
      }
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify({ tool: name, args: args ?? {} }) }],
      });
    }

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      };
  }
}

async function readBody(request: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A server that answers JSON, or one long-lived `text/event-stream` body. */
async function startStubServer(
  options: {
    /** Answer every request with this status and `location`, following nothing. */
    redirectTo?: string;
    /** Answer `tools/list` with `text/event-stream` instead of `application/json`. */
    eventStream?: boolean;
    /** Replace a listing with a tool the SDK cannot bind to HTTP headers. */
    invalidToolHeader?: boolean;
  } = {},
): Promise<StubServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      // Recorded on ARRIVAL, before the body is understood. A case that asserts
      // a second host received nothing is asserting about a request that may
      // never have been a well-formed JSON-RPC POST — a followed redirect turns
      // a POST into a bodyless GET — so counting only parsed messages would
      // report "nothing arrived" for exactly the request that leaked.
      const arrival: RecordedRequest = {
        method: '(unparsed)',
        params: undefined,
        headers: request.headers,
      };
      requests.push(arrival);
      const body = await readBody(request);
      let message: { id?: unknown; method: string; params?: Record<string, unknown> };
      try {
        message = JSON.parse(body) as typeof message;
        arrival.method = message.method;
        arrival.params = message.params;
      } catch {
        response.writeHead(400);
        response.end('not JSON-RPC');
        return;
      }
      // Answered after recording, so a case that expects a refusal can prove
      // the request arrived and was refused, rather than never being sent.
      if (options.redirectTo !== undefined) {
        response.writeHead(302, { location: options.redirectTo });
        response.end();
        return;
      }
      const payload =
        options.invalidToolHeader === true && message.method === 'tools/list'
          ? jsonRpcResult(message.id, {
              ...LIST_CACHE,
              tools: [
                {
                  name: 'unusable',
                  inputSchema: {
                    type: 'object',
                    properties: { value: { type: 'array', 'x-mcp-header': 'value' } },
                  },
                },
              ],
            })
          : respond(message);
      if (payload === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      if (options.eventStream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * The separate HTTP+SSE transport: one long-lived GET, then POSTs whose
 * answers come back on it. Same-origin only, so the endpoint is a path.
 */
async function startSseStubServer(): Promise<StubServer & { streamOpens: () => number }> {
  const requests: RecordedRequest[] = [];
  const streams = new Set<{ write(chunk: string): void }>();
  let opens = 0;
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      opens += 1;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.flushHeaders();
      streams.add(response);
      response.write('event: endpoint\ndata: /messages\n\n');
      return;
    }
    void (async () => {
      const body = await readBody(request);
      const message = JSON.parse(body) as {
        id?: unknown;
        method: string;
        params?: Record<string, unknown>;
      };
      requests.push({ method: message.method, params: message.params, headers: request.headers });
      // The POST is acknowledged with 202; the JSON-RPC answer travels on the
      // GET stream, which is what makes this a different transport and not a
      // header variant.
      response.writeHead(202);
      response.end();
      const payload = respond(message);
      if (payload === undefined) return;
      for (const stream of streams) {
        stream.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      }
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    streamOpens: () => opens,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const open: McpConnection[] = [];
const stubs: StubServer[] = [];

afterEach(async () => {
  for (const connection of open.splice(0)) {
    await connection.close().catch(() => undefined);
  }
  for (const stub of stubs.splice(0)) {
    await stub.close();
  }
});

/** Track a stub and every connection so one failing case cannot leak either. */
function track<T extends StubServer>(stub: T): T {
  stubs.push(stub);
  return stub;
}

async function connect(
  stub: StubServer,
  target: { url?: string; transport?: 'HTTP' | 'SSE'; headers?: Record<string, string> } = {},
): Promise<McpConnection> {
  const connection = await openMcpConnection(
    {
      url: target.url ?? `${stub.origin}/`,
      transport: target.transport ?? 'HTTP',
      ...(target.headers === undefined ? {} : { headers: target.headers }),
    },
    { fetch },
  );
  open.push(connection);
  return connection;
}

describe('openMcpConnection over streamable HTTP', () => {
  it('completes the modern handshake', async () => {
    const stub = track(await startStubServer());
    await connect(stub);

    // The era is part of the contract: a server that supports discovery is
    // asked to discover, and if this ever regresses to a plain `initialize`
    // the modern-only capabilities (tool parameter headers among them) are
    // silently lost.
    expect(stub.requests[0]?.method).toBe('server/discover');
    expect(stub.requests.map((entry) => entry.method)).not.toContain('initialize');
  });

  it('claims no capability to answer a server’s input requests (D-194)', async () => {
    const stub = track(await startStubServer());
    await connect(stub);

    const announced = JSON.stringify(stub.requests[0]?.params ?? {});
    expect(announced).not.toContain('elicitation');
    expect(announced).not.toContain('sampling');
  });

  it('announces this client by name and version', async () => {
    const stub = track(await startStubServer());
    await connect(stub);

    const meta = requestMeta(stub.requests[0]?.params);
    expect(meta['io.modelcontextprotocol/clientInfo']).toMatchObject({ name: 'crewaid' });
  });

  it('lists every tool, across pages, with each tool’s own claims intact', async () => {
    const stub = track(await startStubServer());
    const connection = await connect(stub);

    const tools = await connection.listTools();

    expect(tools.map((entry) => entry.name)).toEqual(['list_invoices', 'send_invoice', 'ping']);
    expect(tools[0]).toEqual({
      name: 'list_invoices',
      description: 'Lists invoices',
      inputSchema: { type: 'object', properties: {} },
      readOnlyHint: true,
    });
    expect(tools[1]?.readOnlyHint).toBe(false);
    // The third tool is the one §6/M6's ladder has to decide about: no
    // annotation at all is not the same as `readOnlyHint: false`.
    expect(tools[2]).toEqual({
      name: 'ping',
      description: '',
      inputSchema: { type: 'object' },
    });
    // Present-and-undefined rather than absent: the descriptor's field is part
    // of the contract M6-BE-08 reads, not an optional extra.
    expect(Object.hasOwn(tools[2] as object, 'readOnlyHint')).toBe(true);

    const listings = stub.requests.filter((entry) => entry.method === 'tools/list');
    expect(listings).toHaveLength(2);
    expect(listings[0]?.params?.['cursor']).toBeUndefined();
    expect(listings[1]?.params?.['cursor']).toBe('page-2');
  });

  it('keeps a tool with a parameter header in the listing rather than dropping it', async () => {
    // A client that filtered such a tool would cache a short listing that looks
    // complete; this one keeps it, with its schema as the server wrote it.
    const stub = track(await startStubServer({ invalidToolHeader: true }));
    const connection = await connect(stub);

    const tools = await connection.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['unusable']);
    expect(tools[0]?.inputSchema).toMatchObject({
      properties: { value: { 'x-mcp-header': 'value' } },
    });
  });

  it('calls a tool by the name the server gave it, and returns the server’s answer', async () => {
    const stub = track(await startStubServer());
    const connection = await connect(stub);

    const result = await connection.callTool('send_invoice', { id: 'inv-9' });

    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ tool: 'send_invoice', args: { id: 'inv-9' } }) },
    ]);
    const call = stub.requests.find((entry) => entry.method === 'tools/call');
    expect(call?.params?.['name']).toBe('send_invoice');
    expect(call?.params?.['arguments']).toEqual({ id: 'inv-9' });
  });

  it('rejects when the server answers a call with a JSON-RPC error', async () => {
    const stub = track(await startStubServer());
    const connection = await connect(stub);

    await expect(connection.callTool('refuse')).rejects.toThrow(/Unknown tool: refuse/);
  });

  it('resolves an in-band tool failure as a result, because that is what it is', async () => {
    // `isError` is how a server says the tool ran and failed. Throwing here
    // would turn a tool-level failure into a transport-level one, and §6/M6's
    // failure isolation (three strikes, drop the server) must not count a
    // server that answered correctly against its own health.
    const stub = track(await startStubServer());
    const connection = await connect(stub);

    const result = await connection.callTool('explode');
    expect(result.isError).toBe(true);
  });

  it('sends the caller’s headers on every request, which is how a credential reaches the server', async () => {
    const stub = track(await startStubServer());
    await connect(stub, { headers: { authorization: 'Bearer stub-token' } });

    expect(stub.requests.length).toBeGreaterThan(0);
    for (const entry of stub.requests) {
      expect(entry.headers['authorization']).toBe('Bearer stub-token');
    }
  });

  it('reads a result that arrives as text/event-stream, not only as JSON', async () => {
    // The Streamable HTTP spec lets a server answer either way, and plenty do.
    const stub = track(await startStubServer({ eventStream: true }));
    const connection = await connect(stub);

    expect((await connection.listTools()).map((entry) => entry.name)).toContain('list_invoices');
  });

  it('tears the connection down once, and tolerates being asked twice', async () => {
    const stub = track(await startStubServer());
    const connection = await connect(stub);
    await connection.close();
    await connection.close();
  });
});

describe('openMcpConnection over HTTP+SSE', () => {
  it('initializes over the stream and answers calls on it', async () => {
    const stub = track(await startSseStubServer());
    const connection = await connect(stub, { transport: 'SSE' });

    expect((await connection.listTools()).map((entry) => entry.name)).toEqual([
      'list_invoices',
      'send_invoice',
      'ping',
    ]);
    const result = await connection.callTool('send_invoice', { id: 'inv-9' });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ tool: 'send_invoice', args: { id: 'inv-9' } }) },
    ]);

    // The transport, not just the handshake: this transport learns its POST
    // endpoint from the stream, so an open stream is what every later request
    // depends on.
    expect(stub.streamOpens()).toBe(1);
    expect(stub.requests.some((entry) => entry.method === 'tools/call')).toBe(true);
  });
});

describe('openMcpConnection refusals', () => {
  it('refuses a stdio target by name before it opens anything', async () => {
    const stub = track(await startStubServer());

    await expect(
      openMcpConnection(
        { url: `${stub.origin}/`, transport: 'stdio' as unknown as 'HTTP' },
        { fetch },
      ),
    ).rejects.toThrow(McpTransportError);
    expect(stub.requests).toEqual([]);
  });

  it('does not fall back to the platform fetch when the caller omits one', async () => {
    // The default is the guarded fetch (D-085), and a loopback `http://` URL is
    // refused by shape. The stub's request log is the assertion that matters:
    // a default that quietly used `globalThis.fetch` would have connected.
    const stub = track(await startStubServer());

    await expect(openMcpConnection({ url: `${stub.origin}/`, transport: 'HTTP' })).rejects.toThrow(
      EndpointRefusedError,
    );
    await expect(openMcpConnection({ url: `${stub.origin}/`, transport: 'HTTP' })).rejects.toThrow(
      /https/,
    );
    expect(stub.requests).toEqual([]);
  });

  it('refuses to be redirected, so a permitted host cannot point the credential somewhere else', async () => {
    const target = track(await startStubServer());
    const redirecting = track(await startStubServer({ redirectTo: `${target.origin}/` }));

    await expect(connect(redirecting)).rejects.toThrow();
    // The request was made — so this is not a case that passed by never
    // connecting…
    expect(redirecting.requests.length).toBeGreaterThan(0);
    // …and the redirect was refused rather than followed: the second server
    // would otherwise have received the request, and with a credential in the
    // headers, the credential.
    expect(target.requests).toEqual([]);
  });
});
