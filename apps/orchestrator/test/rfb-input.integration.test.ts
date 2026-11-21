import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

import { SANDBOX_PORTS } from '@crewaid/sandbox-core';
import { DockerSandboxProvider } from '@crewaid/sandbox-docker';
import { RfbUpstream } from '@crewaid/screen-stream';
import { validateClientInput } from '../src/screen/rfb-input.js';

/**
 * M2-BE-07 against the real x11vnc in the §5 image.
 *
 * The unit suites prove the validator agrees with RFC 6143 and that the bytes
 * reach the socket. Neither can tell you whether x11vnc ACTS on them, and that
 * is the half worth checking: a forwarded event that the server silently
 * ignores looks identical, from the orchestrator's side, to one that worked.
 *
 * So the assertions are made from inside the container, on X itself — where
 * the pointer is, and whether the Caps Lock LED is lit. That is the far end of
 * R6's chain (client → orchestrator → x11vnc → X), and nothing between here
 * and there is mocked.
 *
 * @skip-reason: needs a Docker daemon and a built crewaid/sandbox image; set
 * CREWAID_DOCKER_TESTS=1 to run (Natanael). Declared in turbo.json globalEnv so
 * Turbo's strict env mode cannot strip the gate and turn this into a dormant
 * guard (D-017).
 */
const DOCKER_TESTS = process.env['CREWAID_DOCKER_TESTS'];
const IMAGE = process.env['SANDBOX_IMAGE'] ?? 'crewaid/sandbox:dev';
const NETWORK = 'crewaid-input-it-net';
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

/** RFC 6143 §7.5.5. */
function pointerEvent(buttonMask: number, x: number, y: number): Uint8Array {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 5);
  view.setUint8(1, buttonMask);
  view.setUint16(2, x);
  view.setUint16(4, y);
  return bytes;
}

/** RFC 6143 §7.5.4. */
function keyEvent(down: boolean, keysym: number): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 4);
  view.setUint8(1, down ? 1 : 0);
  view.setUint32(4, keysym);
  return bytes;
}

/** X11 keysym for Caps_Lock — chosen because its effect is externally visible. */
const XK_CAPS_LOCK = 0xffe5;

describe.skipIf(DOCKER_TESTS === undefined || DOCKER_TESTS === '')(
  'screen.input against real x11vnc',
  () => {
    const provider = new DockerSandboxProvider({ image: IMAGE, network: NETWORK });
    const sessionId = `input-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let upstream: RfbUpstream | undefined;

    afterAll(async () => {
      upstream?.close();
      const session = await provider.attachSession({ sessionId });
      if (session !== null) await session.destroy();
    }, 60_000);

    it(
      'moves the real pointer and toggles a real modifier (R6, end to end)',
      async () => {
        const session = await provider.createSession({ sessionId, identity: sessionId });
        const endpoint = await session.getPortEndpoint({ port: SANDBOX_PORTS.rfb });
        const { hostname, port } = new URL(endpoint.url);
        const containerId = session.containerId;

        const inX = async (command: string): Promise<string> => {
          const { stdout } = await run('docker', [
            'exec',
            containerId,
            'sh',
            '-c',
            `DISPLAY=:1 ${command}`,
          ]);
          return stdout;
        };

        let failure: Error | null = null;
        upstream = new RfbUpstream({ host: hostname, port: Number(port), quality: 6 });
        upstream.onMessage(() => {});
        upstream.onClose((reason) => {
          failure = reason;
        });
        await new Promise<void>((resolve, reject) => {
          upstream?.onReady(() => resolve());
          setTimeout(() => reject(new Error('RFB handshake did not complete')), 30_000);
        });

        // ── PointerEvent (t5) ───────────────────────────────────────────────
        // Coordinates picked to be nowhere near a default cursor position, so
        // "it was already there" cannot pass this.
        const target = { x: 417, y: 263 };
        const move = pointerEvent(0, target.x, target.y);
        expect(validateClientInput(move).ok).toBe(true);
        expect(upstream.sendInput(move)).toBe(true);

        await waitFor(async () =>
          (await inX('xdotool getmouselocation')).includes(`x:${target.x}`),
        );
        const location = await inX('xdotool getmouselocation');
        expect(location).toContain(`x:${target.x}`);
        expect(location).toContain(`y:${target.y}`);

        // ── KeyEvent (t4) ───────────────────────────────────────────────────
        // Caps Lock because X exposes its LED: a keystroke that reached the
        // server is observable without a focused application to type into.
        const capsLit = async (): Promise<boolean> => /Caps Lock:\s+on/i.test(await inX('xset q'));
        expect(await capsLit()).toBe(false);

        const press = keyEvent(true, XK_CAPS_LOCK);
        const release = keyEvent(false, XK_CAPS_LOCK);
        expect(validateClientInput(press).ok).toBe(true);
        expect(upstream.sendInput(press)).toBe(true);
        expect(upstream.sendInput(release)).toBe(true);

        await waitFor(capsLit);
        expect(await capsLit()).toBe(true);

        // Leave the desktop as it was found, and prove the reverse direction
        // works rather than a one-way latch.
        upstream.sendInput(press);
        upstream.sendInput(release);
        await waitFor(async () => !(await capsLit()));

        // The connection carrying all of this is the SHARED one every viewer
        // reads from. Input that desynchronised it would show up here.
        expect(failure).toBeNull();
        expect(upstream.isStreaming).toBe(true);
        console.log(`[M2-BE-07] pointer at ${target.x},${target.y}; Caps Lock toggled both ways`);
      },
      BOOT_MS,
    );
  },
);

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the desktop to react');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
