import { API_PREFIX, ATTACHMENT_MAX_BYTES } from '@crewaid/shared';
import type { TokenCredentials } from '../connection/wsClient';
import {
  ApiRequestError,
  isAbortError,
  isApiRequestError,
  normalizeApiFailure,
  type ApiFailure,
} from './apiError';
import { t } from '../i18n/i18n';

/**
 * The renderer's single REST transport (R1: transport only, no orchestration).
 *
 * Three properties make this the one place a REST call is expressed:
 *
 * 1. URLs are built from `API_ROUTES` entries, never from string literals, so
 * a path typo is a compile error in `@crewaid/shared` rather than a 404 at
 * runtime (PRD §0 rule 2 — do not invent endpoints).
 * 2. Credentials come from the same CC-07 bag the WS client reads, so there
 * is one place the operator configures the orchestrator and one
 * fail-closed rule when they have not.
 * 3. Every body is parsed through the shared schema before it reaches a
 * caller. A 2xx that does not match the contract raises CONTRACT — the
 * renderer never hands unvalidated JSON to a component.
 *
 * Seams are injected (`credentialsProvider`, `fetchFn`) for the same reason
 * `wsClient` injects its socket factory: the module tests without a browser,
 * an Electron main process, or a live orchestrator.
 */

/** A `"METHOD /path/:param"` entry from the shared `API_ROUTES` registry. */
export type RouteEntry = string;

/**
 * What this client needs of a response schema, structurally.
 *
 * Every `@crewaid/shared` schema satisfies it, but naming the shape rather than
 * the library keeps `zod` out of `@crewaid/desktop`'s dependency list: the
 * renderer consumes contracts, it does not author them, and a direct zod
 * import here is the first step toward a wire shape being declared outside
 * `packages/shared`.
 */
export type ResponseValidator<T> = {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
};

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type ApiClientOptions = {
  readonly credentialsProvider: () => Promise<TokenCredentials>;
  readonly fetchFn?: FetchLike;
};

export type RequestOptions<T> = {
  /** `:name` segments in the route entry. Every one must be supplied. */
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  /** A plain object is JSON-encoded; FormData is passed through untouched. */
  readonly body?: unknown;
  /**
   * The `Idempotency-Key` Start requires, reused across retries of one
   * press. A named option rather than free headers, so no call site can
   * override the bearer this client owns.
   */
  readonly idempotencyKey?: string;
  /** Parsed against the 2xx body. Omit for 204/no-content routes. */
  readonly schema?: ResponseValidator<T>;
  readonly signal?: AbortSignal;
};

/** What a round trip needs, independent of how its response is read. */
export type TransportOptions = Pick<
  RequestOptions<never>,
  'params' | 'query' | 'body' | 'signal' | 'idempotencyKey'
>;

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

function tooLargeToBuffer(bytes: number): ApiFailure {
  return {
    code: 'TOO_LARGE',
    message: t('api.apiClient.thatFileIsTooLarge'),
    detail: `${bytes} bytes exceeds the ${ATTACHMENT_MAX_BYTES} byte ceiling`,
  };
}

/**
 * Split `"GET /bots/:id/messages"` into its method and its path, substituting
 * `:params`. A missing param is a programmer error at the call site, not an
 * operator-facing failure, so it throws rather than normalizing.
 */
export function resolveRoute(
  entry: RouteEntry,
  params: Readonly<Record<string, string>> = {},
): { method: string; path: string } {
  const separator = entry.indexOf(' ');
  const method = separator === -1 ? '' : entry.slice(0, separator);
  const template = separator === -1 ? '' : entry.slice(separator + 1);
  if (method === '' || !template.startsWith('/')) {
    throw new Error(`Malformed API_ROUTES entry: ${entry}`);
  }

  const path = template
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      const name = segment.slice(1);
      const value = params[name];
      if (value === undefined || value === '') {
        throw new Error(`Route ${entry} is missing the ":${name}" parameter`);
      }
      return encodeURIComponent(value);
    })
    .join('/');

  return { method, path };
}

export class ApiClient {
  private readonly credentialsProvider: ApiClientOptions['credentialsProvider'];
  private readonly fetchFn: FetchLike;

  constructor(options: ApiClientOptions) {
    this.credentialsProvider = options.credentialsProvider;
    this.fetchFn = options.fetchFn ?? defaultFetch;
  }

  /**
   * Fail closed, exactly as `WsClient.open` does: an unconfigured store is a
   * CONFIGURATION failure, never a request to a guessed default host. A
   * renderer that silently fell back to localhost would make a misconfigured
   * install look like a server outage.
   */
  private async readCredentials(): Promise<{ baseUrl: string; token: string }> {
    let credentials: TokenCredentials;
    try {
      credentials = await this.credentialsProvider();
    } catch {
      // A safeStorage/IPC failure is a configuration state, not a request
      // failure — and its message can name paths, so it never propagates.
      throw new ApiRequestError({
        code: 'CONFIGURATION',
        message: t('api.apiClient.thisAppCouldNotRead'),
      });
    }
    return {
      baseUrl: credentials.orchestratorBaseUrl?.trim() ?? '',
      token: credentials.orchestratorToken?.trim() ?? '',
    };
  }

  private async resolveCredentials(): Promise<{ baseUrl: string; token: string }> {
    const credentials = await this.readCredentials();
    if (credentials.token === '' || credentials.baseUrl === '') {
      throw new ApiRequestError({
        code: 'CONFIGURATION',
        message: t('api.apiClient.thisAppIsNotSigned'),
      });
    }
    return credentials;
  }

  private buildUrl(baseUrl: string, path: string, query: RequestOptions<unknown>['query']): string {
    let url: URL;
    try {
      // Resolved RELATIVELY, which is why the base is forced to end in "/" and
      // the route is stripped of its leading one. `new URL('/api/v1/models',
      // 'https://host/crewaid')` discards the "/crewaid" the operator configured for
      // an orchestrator behind a reverse-proxy subpath, and the resulting 404
      // reads as a missing resource rather than a base-URL problem.
      const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
      url = new URL(`${API_PREFIX}${path}`.replace(/^\/+/, ''), base);
    } catch {
      throw new ApiRequestError({
        code: 'CONFIGURATION',
        message: t('api.apiClient.theServerAddressInSettings'),
      });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ApiRequestError({
        code: 'CONFIGURATION',
        message: t('api.apiClient.theServerAddressMustStart'),
      });
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * One authenticated round trip, for every route.
   *
   * Both readers below go through here so that "how a §4.1 call carries its
   * credentials" has exactly one answer, and so a route returning bytes cannot
   * quietly grow a second, less careful transport beside the JSON one.
   */
  private async send(
    entry: RouteEntry,
    options: TransportOptions,
    accept: string,
  ): Promise<Response> {
    const { method, path } = resolveRoute(entry, options.params);
    const { baseUrl, token } = await this.resolveCredentials();
    const url = this.buildUrl(baseUrl, path, options.query);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: accept,
    };
    // Never read from, nor write to, the HTTP cache.
    //
    // The orchestrator now sends `no-store`, so this is the second of two
    // locks on the same door — and the one that holds when the server is an
    // older build than the client, which is exactly the case the cache breaks
    // worst. A body stored before a contract change is replayed afterwards
    // and fails this client's own schema, so the operator is told the server
    // sent an unreadable response while the server is in fact answering
    // correctly. Chromium reached that state on its own: Express attaches a
    // weak ETag and no `Cache-Control`, which leaves the decision to the
    // agent. Nothing behind these routes is cacheable anyway — every one of
    // them is per-user, authenticated, and mutable.
    if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;
    const init: RequestInit = { method, headers, cache: 'no-store' };
    if (options.signal !== undefined) init.signal = options.signal;
    if (options.body !== undefined) {
      if (options.body instanceof FormData) {
        // Multipart MUST NOT carry an explicit Content-Type — the boundary is
        // generated by the runtime and a hand-set header omits it.
        init.body = options.body;
      } else {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, init);
    } catch (error: unknown) {
      // AbortError is the caller's own doing — surfacing it as NETWORK would
      // put "could not reach the server" on screen for a deliberate cancel.
      if (isAbortError(error)) throw error;
      throw new ApiRequestError(normalizeApiFailure(undefined));
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => undefined);
      throw new ApiRequestError(normalizeApiFailure(response.status, raw));
    }
    return response;
  }

  /** Perform a request and return the parsed body. */
  async request<T>(
    entry: RouteEntry,
    options: RequestOptions<T> & { schema: ResponseValidator<T> },
  ): Promise<T>;
  /** Perform a request that returns no body (204, or a body we do not read). */
  async request(entry: RouteEntry, options?: RequestOptions<never>): Promise<void>;
  async request<T>(entry: RouteEntry, options: RequestOptions<T> = {}): Promise<T | void> {
    const response = await this.send(entry, options, 'application/json');

    const { schema } = options;
    if (schema === undefined) return;

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error: unknown) {
      // The abort can land here rather than at fetch: headers arrive long
      // before the body does. Re-thrown for the same reason `send` re-throws
      // it — CONTRACT tells the operator the build is wrong about the server,
      // which is a bad thing to say about their own cancel.
      if (isAbortError(error)) throw error;
      throw new ApiRequestError({
        code: 'CONTRACT',
        message: t('api.apiClient.theServerSentAResponse'),
        detail: 'response body was not JSON',
      });
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiRequestError({
        code: 'CONTRACT',
        message: t('api.apiClient.theServerSentAResponse'),
        detail: parsed.error.message,
      });
    }
    return parsed.data;
  }

  /**
   * The bytes of a route whose response is a file rather than a §4.1 body.
   *
   * An `<a href>` — and the Electron download manager behind it — issues its
   * request outside `fetch`, so it carries no Authorization header and
   * `AuthGuard` answers 401. An authenticated route therefore has to be
   * *fetched*, whatever it returns; the bytes reach disk afterwards through a
   * blob URL. That also keeps the bearer out of the URL entirely: the §4.2
   * socket carries a query token because a WebSocket handshake cannot send
   * headers, which is not a constraint here.
   *
   * The response ultimately buffers into a Blob rather than writing directly
   * to disk, so the ceiling is enforced rather than assumed. D-022 fences the
   * upload route at the same number, but that is only a limit on what this
   * client can PUT there — anything else that reaches ARTIFACT_DIR (an
   * agent-produced artifact, an operator-placed file) arrives on this route
   * unbounded. Content-Length is checked before the body is read, then every
   * streamed chunk is counted because the header is a claim rather than fact.
   */
  async download(entry: RouteEntry, options: TransportOptions = {}): Promise<Blob> {
    const response = await this.send(entry, options, '*/*');

    const contentLength = response.headers.get('content-length');
    const declared = contentLength === null ? undefined : Number(contentLength);
    if (declared !== undefined && Number.isFinite(declared) && declared > ATTACHMENT_MAX_BYTES) {
      throw new ApiRequestError(tooLargeToBuffer(declared));
    }

    const reader = response.body?.getReader();
    if (reader === undefined) {
      return new Blob([], { type: response.headers.get('content-type') ?? '' });
    }

    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > ATTACHMENT_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new ApiRequestError(tooLargeToBuffer(received));
        }

        // Copy each view into an ArrayBuffer-backed chunk. Besides satisfying
        // Blob's stricter type, this avoids retaining a much larger pooled
        // fetch buffer because a small view still references its whole owner.
        const chunk = new Uint8Array(value.byteLength);
        chunk.set(value);
        chunks.push(chunk);
      }
    } catch (error: unknown) {
      // A cancel usually lands here, not at fetch: the status line arrives in
      // milliseconds and the megabytes take seconds, so this is the read the
      // operator actually interrupts.
      if (isAbortError(error) || isApiRequestError(error)) throw error;
      // A truncated transfer also fails here, and the status line already said
      // 200 — so it is a network failure, not a contract one.
      throw new ApiRequestError(normalizeApiFailure(undefined));
    } finally {
      reader.releaseLock();
    }

    return new Blob(chunks, { type: response.headers.get('content-type') ?? '' });
  }
}
