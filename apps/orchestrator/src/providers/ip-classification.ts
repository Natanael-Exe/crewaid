import { isIPv4, isIPv6 } from 'node:net';

/**
 * Is this address one the orchestrator may open a socket to?
 *
 * Pure and synchronous, so the whole range table is testable without a
 * network. Everything that decides whether a user-supplied endpoint is
 * reachable comes through here.
 *
 * AN ALLOW-BY-DEFAULT LIST WITH HOLES IS THE WHOLE PROBLEM. This is written
 * as "public unless it matches a known non-public range", and the ranges below
 * are enumerated from IANA's special-purpose registries rather than from the
 * three private blocks everyone remembers — because the address that matters
 * most in practice, 169.254.169.254, is in none of those three.
 */

export type AddressVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

const PUBLIC: AddressVerdict = { ok: true };

function refuse(reason: string): AddressVerdict {
  return { ok: false, reason };
}

/**
 * IPv4 ranges that are not public, as [first octet-wise prefix, bits, reason].
 *
 * Deliberately includes several an author working from memory would leave out:
 * 100.64.0.0/10 (carrier-grade NAT, which is an internal network on many
 * hosting providers), 192.0.0.0/24 (IETF protocol assignments), and the
 * 0.0.0.0/8 "this network" block, which several stacks route to localhost.
 */
const IPV4_BLOCKS: readonly (readonly [string, number, string])[] = [
  ['0.0.0.0', 8, 'the "this network" block, which some stacks route to localhost'],
  ['10.0.0.0', 8, 'a private network'],
  ['100.64.0.0', 10, 'carrier-grade NAT space, internal on many hosting providers'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local, which is where cloud instance metadata lives'],
  ['172.16.0.0', 12, 'a private network'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation space'],
  ['192.88.99.0', 24, 'deprecated 6to4 relay anycast'],
  ['192.168.0.0', 16, 'a private network'],
  ['198.18.0.0', 15, 'benchmarking space'],
  ['198.51.100.0', 24, 'documentation space'],
  ['203.0.113.0', 24, 'documentation space'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

function ipv4ToInt(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    // Reject leading zeros. `0177.0.0.1` is 127.0.0.1 to `inet_aton` (a
    // leading zero means octal) and 177.0.0.1 to a naive `Number`, and a
    // disagreement between the checker and the connector is the bypass.
    // UNREACHABLE FROM `classifyAddress` TODAY, and kept deliberately.
    // `net.isIPv4` is strict — it already rejects `0177.0.0.1`, `0x7f.0.0.1`
    // and the single-integer form — so that gate is what actually enforces
    // this, and the falsification pass has to remove BOTH to make an
    // ambiguous address pass. This layer exists so that replacing the gate
    // with a looser parse does not silently also remove the rule.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

function ipv4Verdict(address: string): AddressVerdict {
  const value = ipv4ToInt(address);
  if (value === undefined) return refuse('not a parseable IPv4 address');
  for (const [prefix, bits, reason] of IPV4_BLOCKS) {
    const base = ipv4ToInt(prefix);
    /* c8 ignore next -- the table is literal; this is a typo guard. */
    if (base === undefined) continue;
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (base & mask) >>> 0) {
      return refuse(reason);
    }
  }
  if (value === 0xffffffff) return refuse('the broadcast address');
  return PUBLIC;
}

/** Expand an IPv6 address to its sixteen bytes, or undefined if malformed. */
function ipv6Bytes(address: string): Uint8Array | undefined {
  let text = address;
  // A zone index (`fe80::1%eth0`) names a local interface by definition.
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);

  // An IPv4-mapped or IPv4-compatible tail: `::ffff:169.254.169.254`. THE
  // classic bypass — the checker sees an IPv6 address it does not recognise
  // and the stack connects to the IPv4 address inside it.
  const lastColon = text.lastIndexOf(':');
  const tail = lastColon === -1 ? '' : text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const value = ipv4ToInt(tail);
    if (value === undefined) return undefined;
    text =
      text.slice(0, lastColon + 1) +
      [(value >>> 16) & 0xffff, value & 0xffff]
        .map((part) => part.toString(16).padStart(4, '0'))
        .join(':');
  }

  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] === '' ? [] : halves[0]!.split(':');
  const rest = halves.length === 2 ? (halves[1] === '' ? [] : halves[1]!.split(':')) : undefined;

  const groups: string[] =
    rest === undefined
      ? head
      : [...head, ...Array<string>(8 - head.length - rest.length).fill('0'), ...rest];
  if (groups.length !== 8) return undefined;

  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = (value >> 8) & 0xff;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function ipv6Verdict(address: string): AddressVerdict {
  if (address.includes('%')) return refuse('an interface-scoped address');
  const bytes = ipv6Bytes(address);
  if (bytes === undefined) return refuse('not a parseable IPv6 address');

  const allZero = bytes.every((byte) => byte === 0);
  if (allZero) return refuse('the unspecified address');
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
    return refuse('loopback');
  }

  // ::ffff:0:0/96 — IPv4-mapped. Classify by the embedded IPv4 address rather
  // than treating the whole thing as an unrecognised IPv6 address, which is
  // how::ffff:169.254.169.254 reaches instance metadata past a naive check.
  const mappedPrefix =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  // ::a.b.c.d — IPv4-compatible, deprecated but still routed by some stacks.
  const compatPrefix = bytes.slice(0, 12).every((byte) => byte === 0);
  if (mappedPrefix || compatPrefix) {
    const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    const verdict = ipv4Verdict(embedded);
    if (!verdict.ok) return refuse(`an IPv4-in-IPv6 address for ${verdict.reason}`);
    return PUBLIC;
  }

  const first = bytes[0]!;
  const second = bytes[1]!;
  if ((first & 0xfe) === 0xfc) return refuse('a unique-local address');
  if (first === 0xfe && (second & 0xc0) === 0x80) return refuse('link-local');
  if (first === 0xff) return refuse('multicast');
  // 64:ff9b::/96 — NAT64. What comes out the far side is an IPv4 address this
  // check never sees, so the translated destination is unconstrained.
  if (first === 0x00 && second === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return refuse('a NAT64 prefix, which translates to an IPv4 address this check cannot see');
  }
  // 2002::/16 — 6to4. Same family as the IPv4-mapped case above and as NAT64
  // below it: an IPv4 destination wearing an IPv6 address. Unlike NAT64 the
  // embedded address is right there in bytes 2..5, so it is CLASSIFIED rather
  // than refused wholesale — 6to4 to a public address is not the problem, and
  // refusing the prefix outright would be a rule nobody could explain.
  //
  // 2002:7f00:1::1 is 127.0.0.1 and 2002:a9fe:a9fe::1 is 169.254.169.254; both
  // read as ordinary global unicast to a check that stops at the first two
  // bytes. Deprecated by RFC 7526, still routed wherever a 6to4 tunnel is
  // configured, which is not a thing this orchestrator gets to know.
  if (first === 0x20 && second === 0x02) {
    const embedded = `${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`;
    const verdict = ipv4Verdict(embedded);
    if (!verdict.ok) return refuse(`a 6to4 address for ${verdict.reason}`);
    return PUBLIC;
  }
  if (first === 0x20 && second === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return refuse('documentation space');
  }
  return PUBLIC;
}

/** Classify a literal IP address. Hostnames are not accepted here. */
export function classifyAddress(address: string): AddressVerdict {
  if (isIPv4(address)) return ipv4Verdict(address);
  if (isIPv6(address)) return ipv6Verdict(address);
  // `isIPv4`/`isIPv6` are strict, so anything else is either a hostname (the
  // caller's mistake) or a form Node's own parser rejects. Either way it is
  // not something to connect to.
  return refuse('not a literal IP address');
}
