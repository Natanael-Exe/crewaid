import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

import { SANDBOX_PORTS } from '@crewaid/sandbox-core';
import { DockerSandboxProvider } from '@crewaid/sandbox-docker';
import { MIN_QUALITY, RfbUpstream, ServerMessage } from '@crewaid/screen-stream';

/**
 * M2-BE-08 — the §4.3 acceptance criterion, measured rather than argued.
 *
 * "With the panel closed, orchestrator CPU attributable to that sandbox's RFB
 * connection stays under 2% over 60 s idle" (§7.4). The word doing the work is
 * *idle*: it means nobody is WATCHING, not that nothing is happening. A bot
 * with the panel closed is still clicking through a page, so x11vnc still has
 * a changing 1280x800 desktop to hand over.
 *
 * With the panel closed, the pixel stream is gone — the last viewer leaving
 * closes it — and what the orchestrator still holds is the seat's input
 * connection, which never asks for an update. So the criterion is now a
 * stronger one: over the window that connection receives NO picture at all.
 *
 * The desktop is deliberately made busy for the whole run, and a pumping
 * connection measures it first. A static screen would pass this test with any
 * implementation at all, which is the same as not running it.
 *
 * @skip-reason: needs a Docker daemon and a built crewaid/sandbox image; set
 * CREWAID_DOCKER_TESTS=1 to run (Natanael). Declared in turbo.json globalEnv so
 * Turbo's strict env mode cannot strip the gate and turn this into a dormant
 * guard (D-017).
 */
const DOCKER_TESTS = process.env['CREWAID_DOCKER_TESTS'];
const IMAGE = process.env['SANDBOX_IMAGE'] ?? 'crewaid/sandbox:dev';
const NETWORK = 'crewaid-keepalive-it-net';
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

/** §7.4's budget, as microseconds of CPU over the measured window. */
const IDLE_WINDOW_MS = 60_000;
const CPU_BUDGET_FRACTION = 0.02;
const CPU_BUDGET_US = IDLE_WINDOW_MS * 1_000 * CPU_BUDGET_FRACTION;

/** Long enough to see the difference, short enough not to double the runtime. */
const FULL_RATE_WINDOW_MS = 10_000;
const BOOT_MS = 240_000;

describe.skipIf(DOCKER_TESTS === undefined || DOCKER_TESTS === '')(
  'screen keepalive against a busy real desktop',
  () => {
    const provider = new DockerSandboxProvider({ image: IMAGE, network: NETWORK });
    const sessionId = `keepalive-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let upstream: RfbUpstream | undefined;

    afterAll(async () => {
      upstream?.close();
      const session = await provider.attachSession({ sessionId });
      if (session !== null) await session.destroy();
    }, 60_000);

    it(
      'reads no picture and holds under 2% CPU with the panel closed on a busy desktop',
      async () => {
        const session = await provider.createSession({ sessionId, identity: sessionId });
        const endpoint = await session.getPortEndpoint({ port: SANDBOX_PORTS.rfb });
        const { hostname, port } = new URL(endpoint.url);
        const containerId = session.containerId;

        // A maximised terminal scrolling ~20 lines a second: continuous, real
        // damage across most of the framebuffer. Deliberately slept rather
        // than spun — a busy loop takes CPU away from x11vnc's own scan and
        // makes the desktop look LESS active, which is the opposite of what
        // this needs.
        await run('docker', [
          'exec',
          '-d',
          containerId,
          'sh',
          '-c',
          'DISPLAY=:1 xfce4-terminal --maximize --command ' +
            '"sh -c \'while true; do date; sleep 0.05; done\'"',
        ]);
        await new Promise((resolve) => setTimeout(resolve, 6_000));

        let failure: Error | null = null;
        const connect = async (
          quality: number,
        ): Promise<{ upstream: RfbUpstream; updates: () => number }> => {
          let updates = 0;
          const opened = new RfbUpstream({ host: hostname, port: Number(port), quality });
          opened.onMessage((message) => {
            if (message.readUInt8(0) === ServerMessage.framebufferUpdate) updates += 1;
          });
          opened.onClose((reason) => {
            failure ??= reason;
          });
          await new Promise<void>((resolve, reject) => {
            opened.onReady(() => resolve());
            setTimeout(() => reject(new Error('RFB handshake did not complete')), 30_000);
          });
          return { upstream: opened, updates: () => updates };
        };

        // ── Baseline: what a panel that IS open reads ───────────────────────
        const watched = await connect(6);
        upstream = watched.upstream;
        watched.upstream.resume(0);
        const fullRateCpu = await measure(FULL_RATE_WINDOW_MS);
        const fullRateUpdates = watched.updates();
        watched.upstream.close();
        upstream = undefined;

        // A floor, not a target: if the desktop produced nothing, everything
        // below would pass for the wrong reason. Deliberately far under what
        // this actually measures (~20 updates/s on a 2026 laptop) so a slower
        // or busier host does not turn a real pass into a red build.
        expect(fullRateUpdates).toBeGreaterThan(5);

        // ── The criterion: the panel is closed ──────────────────────────────
        // What stays is the input connection, opened the way `ScreenService`
        // opens it and never pumped.
        const input = await connect(MIN_QUALITY);
        upstream = input.upstream;
        expect(input.upstream.isStreaming).toBe(true);
        const idleCpu = await measure(IDLE_WINDOW_MS);
        const idleUpdates = input.updates();
        const idlePercent = (idleCpu / (IDLE_WINDOW_MS * 1_000)) * 100;
        // Straight to stdout, not console.log: this is the number §7.4 asks
        // for, and the reporter does not always surface a passing test's
        // console output — a measurement nobody can read is not evidence.
        process.stdout.write(
          `\n[M2-BE-08] watched: ${(fullRateUpdates / (FULL_RATE_WINDOW_MS / 1_000)).toFixed(1)} updates/s, ` +
            `${((fullRateCpu / (FULL_RATE_WINDOW_MS * 1_000)) * 100).toFixed(2)}% CPU | ` +
            `panel closed: ${idleUpdates} updates, ${idlePercent.toFixed(2)}% CPU over ` +
            `${IDLE_WINDOW_MS / 1_000}s\n`,
        );

        expect(failure).toBeNull();
        // Not a rate: none. Asking nothing is answered with nothing, however
        // busy the desktop is.
        expect(idleUpdates).toBe(0);
        // §7.4's budget.
        expect(idleCpu).toBeLessThan(CPU_BUDGET_US);
        // Still a live connection at the end, so the zero is a connection that
        // asked for nothing and not one that died at the start of the window.
        expect(input.upstream.isStreaming).toBe(true);
        expect(input.upstream.sendInput(new Uint8Array([5, 0, 0, 1, 0, 1]))).toBe(true);
      },
      BOOT_MS,
    );
  },
);

/**
 * CPU this process burned over `windowMs`, in microseconds.
 *
 * `process.cpuUsage` is the whole process, which is the right measure here:
 * during the window the test does nothing but sleep, so everything it counts
 * is the RFB connection — "CPU attributable to that sandbox's RFB connection",
 * as §7.4 puts it.
 */
async function measure(windowMs: number): Promise<number> {
  const before = process.cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  const delta = process.cpuUsage(before);
  return delta.user + delta.system;
}
