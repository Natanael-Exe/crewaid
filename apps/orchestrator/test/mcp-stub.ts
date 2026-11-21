import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An MCP server that speaks the real protocol, on loopback.
 *
 * ── WHY A REAL SERVER AND NOT A MOCKED FETCH ────────────────────────────────
 *
 * A mocked fetch cannot catch the wiring failures that actually happen:
 * content types, the capability handshake, the shape `toToolDescriptor`
 * accepts, and — since M6-BE-07 — whether a namespaced call arrives under the
 * name the SERVER knows rather than the one the model used. So this answers
 * `server/discover`, `tools/list` and `tools/call` over HTTP JSON-RPC, and the
 * suites drive it through `McpServersService.setMcpFetchForTests`, which is
 * what stands in for "a caller that has already admitted this URL" (D-085
 * refuses a loopback address in production, twice).
 *
 * Shared rather than copied: `mcp-servers.integration.test.ts` needs the list
 * half and the turn suites need the call half, and two stubs of one protocol
 * drift in exactly the place a test stops proving anything.
 */

/** One tool as a server reports it — deliberately `unknown`-ish, like the wire. */
export type StubTool = Record<string, unknown>;

/** One `tools/call` the stub received, in arrival order. */
export type StubToolCall = {
  readonly name: string;
  readonly args: Record<string, unknown> | undefined;
};

export type StubMcpServer = {
  /** `http://127.0.0.1:<port>` — loopback, which the guarded fetch refuses. */
  readonly origin: string;
  /** What `tools/list` answers with. Replaced per case, read at request time. */
  tools: StubTool[];
  /**
   * Successive `tools/list` pages, for the pagination cases. When set, each
   * request shifts one listing off the front and `tools` is ignored.
   */
  listings: StubTool[][] | undefined;
  /** What `tools/call` answers with, by tool name. */
  results: Map<string, Record<string, unknown>>;
  /** When set, every request without `Bearer <this>` is answered 401 (D-114). */
  requireBearer: string | undefined;
  /** The `authorization` header of every request, in arrival order. */
  readonly authorizations: (string | undefined)[];
  /** Every `tools/call` this server received. */
  readonly calls: StubToolCall[];
  /** Forget the recorded calls, so a case reads only its own run. */
  clear(): void;
  close(): Promise<void>;
};

function jsonRpcResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  // `resultType` is not decoration: the modern era refuses a result without
  // it, which is the protocol's way of saying this is not a legacy answer.
  return { jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } };
}

async function readBody(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startStubMcpServer(): Promise<StubMcpServer> {
  const state = {
    tools: [] as StubTool[],
    listings: undefined as StubTool[][] | undefined,
    results: new Map<string, Record<string, unknown>>(),
    calls: [] as StubToolCall[],
    // D-114 — what the stub DEMANDS, and what it was actually sent.
    //
    // A bearer test that only asserts the request succeeded proves nothing:
    // the stub answers every caller. So `requireBearer` makes it answer 401 to
    // the wrong value, and `authorizations` records what arrived, which is how
    // a case says the header carried the token the operator stored rather than
    // some other one.
    requireBearer: undefined as string | undefined,
    authorizations: [] as (string | undefined)[],
  };

  function respond(message: {
    id?: unknown;
    method: string;
    params?: Record<string, unknown>;
  }): Record<string, unknown> | undefined {
    if (message.id === undefined) return undefined; // a notification
    const id = message.id;
    switch (message.method) {
      case 'server/discover': {
        const meta = message.params?.['_meta'];
        const announced =
          meta !== null && typeof meta === 'object'
            ? (meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion']
            : undefined;
        if (typeof announced !== 'string') throw new Error('the client announced no version');
        return {
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'complete',
            supportedVersions: [announced],
            capabilities: { tools: { listChanged: false } },
            instructions: 'Stub server. Every tool here is a fixture.',
            _meta: {
              'io.modelcontextprotocol/serverInfo': { name: 'stub-server', version: '1.2.3' },
            },
          },
        };
      }
      case 'tools/list':
        // The 2026 spec requires a cacheable result to say how long it may be cached.
        return jsonRpcResult(id, {
          tools: state.listings?.shift() ?? state.tools,
          ttlMs: 0,
          cacheScope: 'private',
        });
      case 'tools/call': {
        const name = String(message.params?.['name'] ?? '');
        const args = message.params?.['arguments'] as Record<string, unknown> | undefined;
        state.calls.push({ name, args });
        const configured = state.results.get(name);
        return jsonRpcResult(
          id,
          // The default answer echoes the name, which is what makes "the call
          // reached the RIGHT tool" assertable without configuring a result
          // for every fixture.
          configured ?? { content: [{ type: 'text', text: `called ${name}` }] },
        );
      }
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        };
    }
  }

  const server = createServer((request_, response) => {
    void (async () => {
      const authorization = request_.headers['authorization'];
      state.authorizations.push(typeof authorization === 'string' ? authorization : undefined);
      if (state.requireBearer !== undefined && authorization !== `Bearer ${state.requireBearer}`) {
        // The shape a real server answers with, header included: the client's
        // 401 detection reads the status, and a body that is not JSON-RPC is
        // what a gateway refusing at the edge actually returns.
        response.writeHead(401, {
          'content-type': 'text/plain',
          'www-authenticate': 'Bearer',
        });
        response.end('unauthorized');
        return;
      }
      const body = await readBody(request_);
      let message: { id?: unknown; method: string; params?: Record<string, unknown> };
      try {
        message = JSON.parse(body) as typeof message;
      } catch {
        response.writeHead(400);
        response.end('not JSON-RPC');
        return;
      }
      const payload = respond(message);
      if (payload === undefined) {
        response.writeHead(202);
        response.end();
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
    get tools() {
      return state.tools;
    },
    set tools(next: StubTool[]) {
      state.tools = next;
    },
    get listings() {
      return state.listings;
    },
    set listings(next: StubTool[][] | undefined) {
      state.listings = next;
    },
    get results() {
      return state.results;
    },
    get requireBearer() {
      return state.requireBearer;
    },
    set requireBearer(next: string | undefined) {
      state.requireBearer = next;
    },
    authorizations: state.authorizations,
    calls: state.calls,
    clear: () => {
      state.calls.length = 0;
      state.results.clear();
      // Both, because the stub is one server shared by every case in a file:
      // a demand left standing turns the next case's unrelated request into a
      // 401 it never asked for.
      state.authorizations.length = 0;
      state.requireBearer = undefined;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * A fetch that rewrites the named hosts onto the stub, and passes everything
 * else through.
 *
 * This is the seam `setMcpFetchForTests` documents: a caller that has already
 * decided the URL is admissible. Production passes nothing and gets
 * `createGuardedFetch`, which refuses loopback — so there is no path by which
 * this reaches a real deployment.
 *
 * The host list is not a convenience. A suite that also has a row pointing at
 * a genuinely dead address needs that row to STAY dead: rewriting every URL
 * would send the "did not answer" case to a server that answers, and the case
 * would pass for the wrong reason.
 */
export function stubFetchTo(stub: StubMcpServer, hosts: ReadonlySet<string>): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const original = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (!hosts.has(original.hostname)) return fetch(input, init);
    const rewritten = new URL(original.pathname, stub.origin);
    rewritten.search = original.search;
    return fetch(rewritten, init);
  };
}
