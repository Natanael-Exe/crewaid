import { createHash } from 'node:crypto';
import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  InstaboxApiError,
  SdkInstaboxApi,
  instaboxApiKeyConfigured,
  relayThroughChannel,
  verifyHostKeyFingerprint,
  type OpenRelayChannel,
} from './instabox-client.js';
import {
  assertValidBotProfileId,
  assertValidImageRef,
  buildDockerFirewallDropIn,
  buildEnsureContainerCommand,
  buildFirewallScript,
  buildFirewallUnit,
} from './instabox-container-script.js';

describe('Instabox client helpers and host hardening scripts', () => {
  const originalKey = process.env['INSTABOX_API_KEY'];

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env['INSTABOX_API_KEY'];
    } else {
      process.env['INSTABOX_API_KEY'] = originalKey;
    }
  });

  it('refuses construction when INSTABOX_API_KEY is absent or blank', () => {
    delete process.env['INSTABOX_API_KEY'];
    expect(instaboxApiKeyConfigured()).toBe(false);
    expect(() => new SdkInstaboxApi()).toThrow(InstaboxApiError);

    process.env['INSTABOX_API_KEY'] = '   ';
    expect(instaboxApiKeyConfigured()).toBe(false);
    expect(() => new SdkInstaboxApi()).toThrow('INSTABOX_API_KEY is not set');

    process.env['INSTABOX_API_KEY'] = 'ibk_test_key';
    expect(instaboxApiKeyConfigured()).toBe(true);
    expect(() => new SdkInstaboxApi()).not.toThrow();
  });

  it('pins SSH host keys via SHA-256 fingerprint for raw Buffers and hex digests, failing closed', () => {
    const rawKey = Buffer.from('ssh-ed25519-sample-public-key-wire-bytes');
    const digest = createHash('sha256').update(rawKey).digest();
    const expectedOpenSsh = `SHA256:${digest.toString('base64').replace(/=+$/, '')}`;
    const hex = digest.toString('hex');

    expect(verifyHostKeyFingerprint(rawKey, expectedOpenSsh)).toBe(true);
    expect(verifyHostKeyFingerprint(hex, expectedOpenSsh)).toBe(true);
    expect(verifyHostKeyFingerprint(hex.toUpperCase(), expectedOpenSsh)).toBe(true);

    // Wrong key bytes or altered digest must fail.
    expect(verifyHostKeyFingerprint(Buffer.from('different-key'), expectedOpenSsh)).toBe(false);
    expect(verifyHostKeyFingerprint('0'.repeat(64), expectedOpenSsh)).toBe(false);

    // Malformed fingerprints or unsupported prefixes fail closed.
    expect(verifyHostKeyFingerprint(rawKey, '')).toBe(false);
    expect(verifyHostKeyFingerprint(rawKey, 'MD5:aa:bb')).toBe(false);
    expect(verifyHostKeyFingerprint(rawKey, 'SHA256:not-32-bytes')).toBe(false);
    expect(verifyHostKeyFingerprint('not-hex', expectedOpenSsh)).toBe(false);
  });

  it('validates OCI image references and bot profile IDs against shell and flag injection', () => {
    expect(assertValidImageRef('ghcr.io/natanael-exe/crewaid-sandbox:0.1.4')).toBe(
      'ghcr.io/natanael-exe/crewaid-sandbox:0.1.4',
    );
    expect(
      assertValidImageRef('ghcr.io/natanael-exe/crewaid-sandbox@sha256:' + 'a'.repeat(64)),
    ).toContain('@sha256:');

    for (const bad of [
      '',
      '   ',
      '-v /:/host',
      'ghcr.io/repo:tag; rm -rf /',
      'ghcr.io/repo:tag$(id)',
      'ghcr.io/../../etc/passwd',
      'image with spaces:latest',
    ]) {
      expect(() => assertValidImageRef(bad), bad).toThrow('Invalid sandbox image reference');
    }

    expect(assertValidBotProfileId('bot_alpha-1')).toBe('bot_alpha-1');
    for (const bad of ['', 'Default', '../escape', 'bot;id', 'a'.repeat(65)]) {
      expect(() => assertValidBotProfileId(bad), bad).toThrow('Invalid bot profile');
    }
  });

  it('installs both INPUT host drop and D-155 DOCKER-USER egress rules before docker.service', () => {
    const fw = buildFirewallScript();
    expect(fw).toContain('iptables -C INPUT -i "$BRIDGE" -j CREWAID-IN');
    expect(fw).toContain(
      'iptables -A CREWAID-IN -m conntrack --ctstate RELATED,ESTABLISHED --ctdir REPLY -j ACCEPT',
    );
    expect(fw).toContain('iptables -A CREWAID-IN -j DROP');
    expect(fw).toContain('169.254.0.0/16');
    expect(fw).toContain('172.16.0.0/12');
    expect(fw).toContain('--dports 80,443');
    expect(fw).toContain('iptables -A CREWAID-EGRESS -j DROP');
    expect(fw).toContain('ip6tables -I DOCKER-USER 1 -i "$BRIDGE" -j DROP');

    const unit = buildFirewallUnit();
    expect(unit).toContain('Before=docker.service');
    expect(unit).toContain('WantedBy=multi-user.target');

    // Fail closed: Docker (and so the container) cannot start without the fence.
    const dropIn = buildDockerFirewallDropIn();
    expect(dropIn).toContain('[Unit]');
    expect(dropIn).toContain('Requires=crewaid-firewall.service');
    expect(dropIn).toContain('After=crewaid-firewall.service');
  });

  it('runs crewaid-sandbox hardened with browser seccomp, cgroup limits, offset ports, and disk guard', () => {
    const cmd = buildEnsureContainerCommand();
    expect(cmd).toContain('--network crewaid-net');
    expect(cmd).toContain('-v /data/crewaid-home:/home/bot:rw');
    expect(cmd).toContain('--cap-drop=ALL');
    expect(cmd).toContain('--security-opt no-new-privileges:true');
    expect(cmd).toContain('--security-opt seccomp=/etc/crewaid/seccomp-browser.json');
    expect(cmd).toContain('--memory "${MEM_MIB}m"');
    expect(cmd).toContain('--memory-swap "${MEM_MIB}m"');
    expect(cmd).toContain('--pids-limit 2048');
    expect(cmd).toContain('--shm-size 512m');
    expect(cmd).toContain('-p 127.0.0.1:17070:7070');
    expect(cmd).toContain('-p 127.0.0.1:15900-15916:5900-5916');
    expect(cmd).toContain('-p 127.0.0.1:19301-19316:9301-9316');
    expect(cmd).not.toContain('7071');
    expect(cmd).toContain('df -Pm /');
    expect(cmd).toContain('docker stop -t 15');
  });
});

describe('relayThroughChannel', () => {
  /** One loopback server whose every connection goes through `relayThroughChannel`. */
  async function relayServer(open: OpenRelayChannel): Promise<{ port: number; server: Server }> {
    const server = createServer((local) => relayThroughChannel(local, open, () => false));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, server };
  }

  function closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  /** Connects, optionally writes, and resolves with every byte read before the socket closed. */
  /**
   * One client connection through the relay: what came back before it closed.
   *
   * `resetIsClose`: when the relay drops a connection whose request bytes it has
   * not read yet (it pauses the socket until a channel opens), Linux closes it
   * with a reset rather than a FIN, so the client sees ECONNRESET. macOS, and a
   * run where Node had already pulled those bytes in, close cleanly instead.
   * Either way that one connection is closed, which is what such a case asserts.
   */
  function exchange(
    port: number,
    payload?: string,
    { resetIsClose = false }: { resetIsClose?: boolean } = {},
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let received = '';
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
        if (payload !== undefined && received === payload) socket.end();
      });
      socket.on('error', (error: NodeJS.ErrnoException) => {
        if (resetIsClose && error.code === 'ECONNRESET') resolve(received);
        else reject(error);
      });
      socket.on('close', () => resolve(received));
      if (payload !== undefined) socket.write(payload);
    });
  }

  it('closes only the one connection when the VM refuses the channel (nothing listening there)', async () => {
    // The shape that used to crash the orchestrator: ssh2 refuses `direct-tcpip`
    // because the container port inside the VM is not listening.
    const { port, server } = await relayServer((callback) => {
      setTimeout(
        () => callback(new Error('(SSH) Channel open failure: Connection refused'), undefined),
        10,
      );
    });
    try {
      await expect(
        exchange(port, 'GET /health HTTP/1.1\r\n\r\n', { resetIsClose: true }),
      ).resolves.toBe('');
      // The listener still serves later connections.
      await expect(exchange(port)).resolves.toBe('');
    } finally {
      await closeServer(server);
    }
  });

  it('carries bytes written before the channel opens, both ways', async () => {
    const { port, server } = await relayServer((callback) => {
      // An echo channel that opens only after the client has already written.
      setTimeout(() => callback(undefined, new PassThrough()), 20);
    });
    try {
      await expect(exchange(port, 'RFB 003.008\n')).resolves.toBe('RFB 003.008\n');
    } finally {
      await closeServer(server);
    }
  });

  it('survives a channel that fails mid-stream and a client that resets before the channel opens', async () => {
    const channels: PassThrough[] = [];
    const { port, server } = await relayServer((callback) => {
      const channel = new PassThrough();
      channels.push(channel);
      setTimeout(() => callback(undefined, channel), 20);
    });
    try {
      const failing = exchange(port);
      await vi.waitFor(() => expect(channels).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 40));
      channels[0]?.destroy(new Error('channel reset by the SSH gateway'));
      await expect(failing).resolves.toBe('');

      const reset = connect(port, '127.0.0.1');
      reset.on('error', () => undefined);
      await new Promise<void>((resolve) => reset.once('connect', () => resolve()));
      reset.resetAndDestroy();
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      await closeServer(server);
    }
  });
});
