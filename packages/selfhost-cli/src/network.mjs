import { networkInterfaces } from 'node:os';
import net from 'node:net';

/** This machine's first non-internal IPv4 address: what a LAN install advertises. */
export function lanAddress(interfaces = networkInterfaces()) {
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

/** Whether a TCP port can be bound on this machine right now. */
export function portIsFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function toInt(address) {
  return address.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

function range(cidr) {
  const [address, bits] = cidr.split('/');
  const size = 2 ** (32 - Number(bits));
  const start = Math.floor(toInt(address) / size) * size;
  return [start, start + size - 1];
}

export function overlaps(a, b) {
  const [a0, a1] = range(a);
  const [b0, b1] = range(b);
  return a0 <= b1 && b0 <= a1;
}

/**
 * A /24 for the computers' network that no existing Docker network uses.
 * 10.231.0.0/24 by default (outside Docker's own 172.17–31 and 192.168 pools);
 * the next free 10.231.x.0/24 when a machine already has it.
 */
export function pickSandboxSubnet(taken) {
  for (let third = 0; third < 256; third++) {
    const candidate = `10.231.${third}.0/24`;
    if (!taken.some((cidr) => overlaps(candidate, cidr))) {
      return { subnet: candidate, orchestrator: `10.231.${third}.2` };
    }
  }
  throw new Error('No free 10.231.x.0/24 range for the computers’ network.');
}
