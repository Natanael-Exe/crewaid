import { describe, expect, it, vi } from 'vitest';

import { classifyAddress } from '../src/providers/ip-classification.js';
import {
  admitEndpoint,
  assertPublicHost,
  createGuardedFetch,
  EndpointRefusedError,
  parseEndpoint,
  type AddressResolver,
} from '../src/providers/endpoint-guard.js';

/**
 * V1-04 / D-085 — a custom endpoint is a URL an unprivileged user typed that
 * the orchestrator then makes requests to. Without this it is a proxy into
 * whatever network it runs in.
 *
 * The cases that earn their place are the ones a check written from memory
 * gets wrong: 169.254.169.254 (in none of the three famous private blocks),
 * ::ffff:169.254.169.254 (an IPv4 address wearing an IPv6 coat), a name that
 * answers with one public and one private address, and a permitted host that
 * answers 302 to an internal one.
 */

const resolverFor = (map: Record<string, readonly string[]>): AddressResolver => {
  return (hostname) => {
    const addresses = map[hostname];
    if (addresses === undefined) return Promise.reject(new Error('ENOTFOUND'));
    return Promise.resolve(addresses);
  };
};

describe('address classification', () => {
  const refused: readonly (readonly [string, string])[] = [
    // The one that matters most in practice, and the one a check built from
    // "10/8, 172.16/12, 192.168/16" misses entirely.
    ['169.254.169.254', 'cloud instance metadata'],
    ['169.254.0.1', 'link-local'],
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback, anywhere in the /8'],
    ['0.0.0.0', 'the this-network block'],
    ['0.1.2.3', 'the this-network block'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private, top of the /12'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['240.0.0.1', 'reserved'],
    ['::1', 'IPv6 loopback'],
    ['::', 'the unspecified address'],
    ['fc00::1', 'unique-local'],
    ['fd00::1', 'unique-local'],
    ['fe80::1', 'IPv6 link-local'],
    ['ff02::1', 'IPv6 multicast'],
    // THE bypass: an IPv4 address inside an IPv6 one. A checker that does not
    // unwrap it sees an unrecognised IPv6 address and lets the stack connect
    // to the IPv4 address inside.
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::127.0.0.1', 'IPv4-compatible loopback'],
    ['64:ff9b::1', 'NAT64, which translates to an address this check cannot see'],
    // 6to4: the same IPv4-inside-IPv6 trick one prefix over. These read as
    // ordinary global unicast to any check that stops at the first two bytes,
    // and the embedded address is in bytes 2..5 rather than 12..15.
    ['2002:7f00:1::1', '6to4 loopback (127.0.0.1)'],
    ['2002:a9fe:a9fe::1', '6to4 metadata (169.254.169.254)'],
    ['2002:c0a8:1::1', '6to4 private (192.168.0.1)'],
    ['2002:a00:1::1', '6to4 private (10.0.0.1)'],
    ['2001:db8::1', 'IPv6 documentation space'],
  ];

  for (const [address, why] of refused) {
    it(`refuses ${address} — ${why}`, () => {
      const verdict = classifyAddress(address);
      expect(verdict.ok, `${address} was treated as public`).toBe(false);
    });
  }

  const allowed = [
    '1.1.1.1',
    '8.8.8.8',
    '104.18.0.1',
    '172.15.255.255', // just below the private /12
    '172.32.0.1', // just above it
    '100.63.255.255', // just below the CGNAT /10
    '100.128.0.1', // just above it
    '2606:4700::1111',
    '::ffff:8.8.8.8', // IPv4-mapped, but a public one
    '2002:808:808::1', // 6to4, but wrapping a public address (8.8.8.8)
  ];

  for (const address of allowed) {
    it(`allows ${address}`, () => {
      expect(classifyAddress(address).ok, `${address} was refused`).toBe(true);
    });
  }

  it('refuses an address with a zone index', () => {
    expect(classifyAddress('fe80::1%eth0').ok).toBe(false);
  });

  it('refuses octal-looking octets rather than guessing', () => {
    // ⚠️ THE OCTET MUST BE ONE WHERE THE TWO READINGS DIVERGE ACROSS THE
    // PUBLIC/PRIVATE LINE, or the test proves nothing.
    //
    // `0177.0.0.1` is 127.0.0.1 to `inet_aton` (leading zero means octal, and
    // 0177 is 127) and 177.0.0.1 to a naive `Number()` — public. So a checker
    // that strips the leading zero waves it through and the connector opens a
    // socket to loopback.
    //
    // The first draft used `010.0.0.1`, which reads as 8.0.0.1 or 10.0.0.1 —
    // both refused, one for being the this-network block and the other for
    // being private — so it passed with the leading-zero rule removed and
    // survived the mutation.
    //
    // TWO LAYERS ENFORCE THIS and the falsification has to remove both:
    // `net.isIPv4` is strict and rejects these outright, and `ipv4ToInt`
    // rejects leading zeros for the case where that gate is ever loosened.
    expect(classifyAddress('0177.0.0.1').ok, 'octal loopback was treated as public').toBe(false);
    // Hex, which inet_aton also accepts: 0x7f is 127.
    expect(classifyAddress('0x7f.0.0.1').ok).toBe(false);
    // The single-integer form of 127.0.0.1, which inet_aton accepts too.
    expect(classifyAddress('2130706433').ok).toBe(false);
  });

  it('refuses anything that is not a literal address', () => {
    for (const value of ['example.com', '', 'not an ip', '1.2.3', '1.2.3.4.5', '999.1.1.1']) {
      expect(classifyAddress(value).ok, `${value} was treated as public`).toBe(false);
    }
  });
});

describe('endpoint shape', () => {
  it('accepts a plain https base URL', () => {
    expect(parseEndpoint('https://api.example.com/v1').hostname).toBe('api.example.com');
  });

  it('refuses http — the key would go over the wire in the clear', () => {
    expect(() => parseEndpoint('http://api.example.com/v1')).toThrow(/must use https/);
  });

  it('refuses credentials in the URL', () => {
    // A second, unencrypted credential store the vault knows nothing about.
    expect(() => parseEndpoint('https://user:secret@api.example.com/v1')).toThrow(
      /must not contain credentials/,
    );
  });

  it('refuses a fragment', () => {
    expect(() => parseEndpoint('https://api.example.com/v1#section')).toThrow(/fragment/);
  });

  it('refuses a relative or malformed URL', () => {
    for (const value of ['api.example.com/v1', '/v1', '', 'https://']) {
      expect(() => parseEndpoint(value)).toThrow(EndpointRefusedError);
    }
  });

  it('refuses other schemes, including file: and gopher:', () => {
    for (const value of ['file:///etc/passwd', 'gopher://x/1', 'ftp://x/']) {
      expect(() => parseEndpoint(value)).toThrow(EndpointRefusedError);
    }
  });
});

describe('host resolution', () => {
  it('admits a host that resolves entirely to public addresses', async () => {
    const resolve = resolverFor({ 'api.example.com': ['93.184.216.34'] });
    await expect(admitEndpoint('https://api.example.com/v1', resolve)).resolves.toBeInstanceOf(URL);
  });

  it('refuses a host that resolves to a private address', async () => {
    const resolve = resolverFor({ 'evil.example.com': ['169.254.169.254'] });
    await expect(admitEndpoint('https://evil.example.com/v1', resolve)).rejects.toThrow(
      /link-local/,
    );
  });

  it('refuses when ANY answer is private, not only when all of them are', async () => {
    // A name answering with one public and one private address is a
    // rebinding primitive: the checker sees the public one and the socket
    // uses whichever the resolver hands it. There is no benign reason for an
    // inference endpoint to resolve into a private range at all.
    const resolve = resolverFor({ 'split.example.com': ['93.184.216.34', '10.0.0.5'] });
    await expect(admitEndpoint('https://split.example.com/v1', resolve)).rejects.toThrow(
      EndpointRefusedError,
    );
  });

  it('refuses a host that resolves to nothing', async () => {
    const resolve = resolverFor({ 'empty.example.com': [] });
    await expect(assertPublicHost('empty.example.com', resolve)).rejects.toThrow(
      /resolved to no addresses/,
    );
  });

  it('refuses a name that does not resolve, without echoing the resolver', async () => {
    // A resolver message can name internal search domains.
    const resolve: AddressResolver = () =>
      Promise.reject(new Error('queryA ENOTFOUND api.internal.corp.example'));
    await expect(assertPublicHost('nope.example.com', resolve)).rejects.toThrow(
      /could not be resolved/,
    );
    await expect(assertPublicHost('nope.example.com', resolve)).rejects.not.toThrow(
      /internal\.corp/,
    );
  });

  it('classifies a literal address in the URL without asking DNS', async () => {
    const resolve = vi.fn<AddressResolver>();
    await expect(admitEndpoint('https://169.254.169.254/v1', resolve)).rejects.toThrow(
      /link-local/,
    );
    expect(resolve, 'a literal address should not be resolved').not.toHaveBeenCalled();
  });

  it('allows a literal public address', async () => {
    const resolve = vi.fn<AddressResolver>();
    await expect(admitEndpoint('https://1.1.1.1/v1', resolve)).resolves.toBeInstanceOf(URL);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('classifies a bracketed IPv6 literal by what is inside the brackets', async () => {
    const resolve = vi.fn<AddressResolver>();
    // `new URL` keeps the brackets in `hostname`… or does not, depending on
    // the runtime. Either way this must be refused rather than treated as an
    // unresolvable hostname that happens to fail for a different reason.
    await expect(admitEndpoint('https://[::1]/v1', resolve)).rejects.toThrow(EndpointRefusedError);
  });
});

describe('the guarded fetch', () => {
  const ok = (): Response => new Response('{}', { status: 200 });

  it('re-resolves on every request, not once at admission', async () => {
    // THE request-time half of D-085. Admission and the request are two
    // separate resolutions, and the second is the one the socket uses.
    const resolve = vi.fn<AddressResolver>(() => Promise.resolve(['93.184.216.34']));
    const guarded = createGuardedFetch(resolve, () => Promise.resolve(ok()));

    await guarded('https://api.example.com/v1/chat');
    await guarded('https://api.example.com/v1/chat');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('refuses a host that has since started resolving privately', async () => {
    let answer: readonly string[] = ['93.184.216.34'];
    const resolve: AddressResolver = () => Promise.resolve(answer);
    const guarded = createGuardedFetch(resolve, () => Promise.resolve(ok()));

    await expect(guarded('https://api.example.com/v1')).resolves.toBeInstanceOf(Response);
    answer = ['169.254.169.254'];
    await expect(guarded('https://api.example.com/v1')).rejects.toThrow(EndpointRefusedError);
  });

  it('refuses a redirect instead of following it', async () => {
    // A permitted host answering 302 to an internal address defeats a check
    // that only inspected the original URL.
    const resolve: AddressResolver = () => Promise.resolve(['93.184.216.34']);
    const guarded = createGuardedFetch(resolve, () =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }),
      ),
    );
    await expect(guarded('https://api.example.com/v1')).rejects.toThrow(
      /Redirects are not followed/,
    );
  });

  it('asks the underlying fetch not to follow redirects itself', async () => {
    // Without `redirect: 'manual'` the platform follows it before this code
    // ever sees a status, and the refusal above never fires.
    const resolve: AddressResolver = () => Promise.resolve(['93.184.216.34']);
    const underlying = vi.fn(() => Promise.resolve(ok()));
    const guarded = createGuardedFetch(resolve, underlying as unknown as typeof fetch);
    await guarded('https://api.example.com/v1');
    expect(underlying.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('reports only the origin a redirect pointed at', async () => {
    // `location` is attacker-controlled and this string reaches a screen.
    const resolve: AddressResolver = () => Promise.resolve(['93.184.216.34']);
    const guarded = createGuardedFetch(resolve, () =>
      Promise.resolve(
        new Response(null, {
          status: 301,
          headers: { location: 'https://evil.example/aaa?token=leak#frag' },
        }),
      ),
    );
    await expect(guarded('https://api.example.com/v1')).rejects.toThrow(/https:\/\/evil\.example/);
    await expect(guarded('https://api.example.com/v1')).rejects.not.toThrow(/token=leak/);
  });

  it('passes a 2xx straight through', async () => {
    const resolve: AddressResolver = () => Promise.resolve(['93.184.216.34']);
    const guarded = createGuardedFetch(resolve, () => Promise.resolve(ok()));
    expect((await guarded('https://api.example.com/v1')).status).toBe(200);
  });

  it('does not treat a 4xx or 5xx as a redirect', async () => {
    // A provider's own 401 must reach D-006 normalization, not be swallowed
    // here as a transport refusal.
    const resolve: AddressResolver = () => Promise.resolve(['93.184.216.34']);
    for (const status of [400, 401, 429, 500]) {
      const guarded = createGuardedFetch(resolve, () =>
        Promise.resolve(new Response('{}', { status })),
      );
      expect((await guarded('https://api.example.com/v1')).status).toBe(status);
    }
  });

  it('validates a Request object’s URL, not only a string', async () => {
    const resolve: AddressResolver = () => Promise.resolve(['169.254.169.254']);
    const guarded = createGuardedFetch(resolve, () => Promise.resolve(ok()));
    await expect(guarded(new Request('https://api.example.com/v1'))).rejects.toThrow(
      EndpointRefusedError,
    );
  });
});
