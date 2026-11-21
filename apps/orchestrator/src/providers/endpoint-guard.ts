import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { classifyAddress } from './ip-classification.js';

/**
 * Endpoint admission for custom providers.
 *
 * A custom endpoint is a URL an unprivileged user typed that the orchestrator
 * then makes requests to. That is a server-side request forgery primitive, and
 * without this the orchestrator is a proxy into whatever network it runs in.
 *
 * ⚠️ CHECKED TWICE, AND THE SECOND CHECK IS THE ONE THAT MATTERS. Admission
 * happens when a connection is saved; the name is resolved AGAIN when a
 * request is made, because a host that passes admission and later resolves to
 * 169.254.169.254 is not an edge case, it is the attack. An admission-time
 * check on its own reports on a value it does not control.
 */

export class EndpointRefusedError extends Error {
  readonly code = 'ENDPOINT_REFUSED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'EndpointRefusedError';
  }
}

/**
 * Shape validation, with no network involved.
 *
 * Mirrors `ProviderEndpointSchema` in `@crewaid/shared` and is deliberately a
 * second copy rather than an import: the schema states the CONTRACT (what a
 * client may send) and this states the ORCHESTRATOR'S RULE (what it will open
 * a socket to). They agree today; if one is ever relaxed, the other must not
 * silently follow.
 */
export function parseEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EndpointRefusedError('endpoint must be an absolute URL');
  }
  if (url.protocol !== 'https:') {
    // Plaintext would put the API key on the wire in the clear, which makes
    // the vault pointless for exactly the connections it was added for.
    throw new EndpointRefusedError('endpoint must use https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new EndpointRefusedError(
      'endpoint must not contain credentials — the API key is stored separately and encrypted',
    );
  }
  if (url.hostname === '') {
    throw new EndpointRefusedError('endpoint has no host');
  }
  if (url.hash !== '') {
    // A fragment is never sent to a server, so one here means the operator
    // pasted something other than an API base URL.
    throw new EndpointRefusedError('endpoint must not contain a fragment');
  }
  return url;
}

/**
 * `URL.hostname` for an IPv6 literal keeps the brackets — `[::1]` — and
 * `net.isIP('[::1]')` is 0. Without stripping them, an IPv6 literal falls
 * through to the DNS branch and is treated as a NAME.
 *
 * Today that still fails closed, because resolving `[::1]` errors and the
 * error becomes a refusal. It fails for the wrong reason, though, and "it
 * happens to be refused by the resolver" is not a property anyone can rely on
 * — a resolver that answered would let `https://[::1]/` straight through.
 */
export function bareHostname(url: URL): string {
  const host = url.hostname;
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Test seam: resolve a hostname to the addresses a socket would use. */
export type AddressResolver = (hostname: string) => Promise<readonly string[]>;

export const systemResolver: AddressResolver = async (hostname) => {
  // `all: true` because a name with several A/AAAA records is exactly where a
  // partial check fails: resolving once and validating one address leaves the
  // others unchecked, and which one the stack picks is not ours to decide.
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

/**
 * Resolve a host and refuse unless EVERY address it answers with is public.
 *
 * Every, not any. A name that returns one public and one private address is a
 * DNS-rebinding primitive: the checker sees the public one and the connection
 * uses whichever the resolver hands the socket. There is no benign reason for
 * an inference endpoint to resolve into a private range at all.
 */
export async function assertPublicHost(
  hostname: string,
  resolve: AddressResolver = systemResolver,
): Promise<readonly string[]> {
  // A literal address skips DNS entirely — there is nothing to re-resolve, and
  // it must still be classified.
  if (isIP(hostname) !== 0) {
    const verdict = classifyAddress(hostname);
    if (!verdict.ok) {
      throw new EndpointRefusedError(`endpoint address is ${verdict.reason}`);
    }
    return [hostname];
  }

  let addresses: readonly string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    // The resolver's own message can name internal search domains, so it is
    // not surfaced. What an operator needs is "this name did not resolve".
    throw new EndpointRefusedError(`endpoint host "${hostname}" could not be resolved`);
  }
  if (addresses.length === 0) {
    throw new EndpointRefusedError(`endpoint host "${hostname}" resolved to no addresses`);
  }
  for (const address of addresses) {
    const verdict = classifyAddress(address);
    if (!verdict.ok) {
      throw new EndpointRefusedError(
        `endpoint host "${hostname}" resolves to ${verdict.reason}, which this orchestrator ` +
          'will not connect to',
      );
    }
  }
  return addresses;
}

/**
 * The connection-time check, run when a custom connection is saved.
 *
 * Returns the parsed URL so the caller stores the normalised form rather than
 * whatever was typed.
 */
export async function admitEndpoint(
  raw: string,
  resolve: AddressResolver = systemResolver,
): Promise<URL> {
  const url = parseEndpoint(raw);
  await assertPublicHost(bareHostname(url), resolve);
  return url;
}

/**
 * A `fetch` that re-checks before every request and refuses redirects.
 *
 * Handed to the provider SDK in place of the global `fetch` (V1-06), which is
 * what makes the request-time half of D-085 unavoidable rather than something
 * a call site can forget.
 *
 * `redirect: 'manual'` and then a refusal: a permitted host that answers 302
 * to an internal address defeats a check that only inspected the original URL,
 * and following one is never something the user asked for. A 3xx is surfaced
 * as a refusal rather than transparently followed, so an operator whose
 * endpoint genuinely redirects is told to configure the final URL.
 */
export function createGuardedFetch(
  resolve: AddressResolver = systemResolver,
  underlying: typeof fetch = fetch,
): typeof fetch {
  return async function guardedFetch(input, init) {
    const requested = typeof input === 'string' || input instanceof URL ? input : input.url;
    const url = parseEndpoint(String(requested));
    await assertPublicHost(bareHostname(url), resolve);

    const response = await underlying(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      throw new EndpointRefusedError(
        `endpoint answered ${response.status} with a redirect${
          location === null ? '' : ` to ${redactTarget(location, url)}`
        }. Redirects are not followed — configure the final URL instead.`,
      );
    }
    return response;
  };
}

/**
 * Report where a redirect pointed without echoing an arbitrary header value.
 *
 * The `location` header is attacker-controlled, and this string reaches an
 * operator's screen; only the origin is useful for deciding what to configure.
 */
function redactTarget(location: string, base: URL): string {
  try {
    return new URL(location, base).origin;
  } catch {
    return 'an unparseable location';
  }
}
