import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

import { SANDBOX_PORTS } from '@crewaid/sandbox-core';
import { DockerSandboxProvider } from '@crewaid/sandbox-docker';
import { ServerMessage, scanServerMessage } from '@crewaid/screen-stream';
import { RfbUpstream } from '@crewaid/screen-stream';
import type { ServerMessageMeta } from '@crewaid/screen-stream';

/**
 * M2-BE-06 against the real x11vnc in the §5 image.
 *
 * The unit suites prove the scanner agrees with hand-built bytes. This proves
 * it agrees with x11vnc, which is the half that can actually be wrong: Tight's
 * compact lengths, its palette row padding, and the 3-byte TPIXEL are all
 * things a hand-written fixture will confirm and a real encoder will not,
 * because only the real one chooses jpeg for a photo, fill for a flat panel
 * and a palette for text — in the same stream, in an order nobody picked.
 *
 * A desync here is silent by construction: the proxy forwards bytes, so an
 * off-by-one produces a corrupt picture on a client, not an error on the
 * server. The assertion that matters is therefore "every byte received was
 * accounted for by a complete message".
 *
 * @skip-reason: needs a Docker daemon and a built crewaid/sandbox image; set
 * CREWAID_DOCKER_TESTS=1 to run (Natanael). Declared in turbo.json globalEnv so
 * Turbo's strict env mode cannot strip the gate and turn this into a dormant
 * guard (D-017).
 */
const DOCKER_TESTS = process.env['CREWAID_DOCKER_TESTS'];
const IMAGE = process.env['SANDBOX_IMAGE'] ?? 'crewaid/sandbox:dev';
const NETWORK = 'crewaid-screen-it-net';
// D-200: this suite's own network, so the supervisor it reaches Docker through
// is configured for it rather than refusing it.
const supervisor =
  process.env['CREWAID_DOCKER_TESTS'] === '1'
    ? await (
        await import('@crewaid/sandbox-supervisor')
      ).useTestSupervisor({ SANDBOX_NETWORK: NETWORK })
    : null;
afterAll(async () => supervisor?.close());

const run = promisify(execFile);
/** One boot of a full XFCE desktop, plus room for a cold image on a slow host. */
const BOOT_MS = 90_000;

describe.skipIf(DOCKER_TESTS === undefined || DOCKER_TESTS === '')(
  'RfbUpstream against real x11vnc',
  () => {
    const provider = new DockerSandboxProvider({ image: IMAGE, network: NETWORK });
    const sessionId = `screen-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let upstream: RfbUpstream | undefined;

    afterAll(async () => {
      upstream?.close();
      const session = await provider.attachSession({ sessionId });
      if (session !== null) await session.destroy();
    }, 60_000);

    it(
      'handshakes, streams complete Tight messages, and never desynchronises',
      async () => {
        const session = await provider.createSession({ sessionId, identity: sessionId });
        const endpoint = await session.getPortEndpoint({ port: SANDBOX_PORTS.rfb });
        const { hostname, port } = new URL(endpoint.url);

        const messages: { message: Buffer; meta: ServerMessageMeta }[] = [];
        let failure: Error | null = null;

        upstream = new RfbUpstream({ host: hostname, port: Number(port), quality: 6 });
        upstream.onMessage((message, meta) => messages.push({ message, meta }));
        upstream.onClose((reason) => {
          failure = reason;
        });

        const geometry = await new Promise<{ widthPx: number; heightPx: number }>(
          (resolve, reject) => {
            upstream?.onReady(resolve);
            setTimeout(() => reject(new Error('RFB handshake did not complete')), 30_000);
          },
        );

        // The machine framebuffer includes the image's eight-pixel margin
        // around the advertised seat geometry (D-046).
        expect(geometry).toEqual({ widthPx: 1288, heightPx: 808 });

        upstream.requestFullRepaint();

        // Give the desktop something to redraw so the stream carries more than
        // one static frame — a single update would not exercise the encoder's
        // mode switching, which is where the scanner earns its keep.
        const containerId = session.containerId;
        for (let i = 0; i < 6; i += 1) {
          await run('docker', [
            'exec',
            containerId,
            'sh',
            '-c',
            `DISPLAY=:1 xdotool mousemove ${120 + i * 90} ${120 + i * 55} click 1`,
          ]).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        await new Promise((resolve) => setTimeout(resolve, 1_500));

        expect(failure).toBeNull();
        expect(messages.length).toBeGreaterThan(0);

        // The first update answers the non-incremental request: a subscriber
        // may only be attached on one of these.
        expect(messages[0]?.meta.fullRepaint).toBe(true);

        // Every forwarded buffer must be exactly one complete server message.
        // Re-scanning is the check: a boundary that was right when it was cut
        // is still right, and a length that over-read would leave a tail.
        for (const { message } of messages) {
          expect(scanServerMessage(message)).toBe(message.length);
        }

        const updates = messages.filter(
          ({ message }) => message.readUInt8(0) === ServerMessage.framebufferUpdate,
        );
        expect(updates.length).toBeGreaterThan(0);
        const rectangles = updates.reduce((sum, { message }) => sum + message.readUInt16BE(2), 0);
        const bytes = messages.reduce((sum, { message }) => sum + message.length, 0);
        // Not a threshold to tune — just proof this ran against a live encoder
        // rather than an empty stream that would pass every assertion above.
        expect(rectangles).toBeGreaterThan(0);
        console.log(
          `[M2-BE-06] ${messages.length} messages, ${rectangles} rectangles, ${bytes} bytes`,
        );
      },
      BOOT_MS,
    );
  },
);
