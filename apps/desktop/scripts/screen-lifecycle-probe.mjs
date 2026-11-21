#!/usr/bin/env node
// Real Docker + Electron regression probe. Requires DATABASE_URL and a built
// crewaid/sandbox:dev image. Run after pnpm build:
// pnpm --filter @crewaid/desktop screen:probe
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import executablePath from 'electron';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const desktop = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(desktop, '../..');
const dir = await mkdtemp(path.join(tmpdir(), 'crewaid-screen-probe-'));
await mkdir(path.join(dir, 'artifacts'));
const token = randomBytes(32).toString('hex');
const server = spawn(
  process.execPath,
  [path.join(root, 'apps/orchestrator/scripts/e2e-server.mjs')],
  {
    cwd: root,
    env: { ...process.env, ORCH_API_TOKEN: token, ARTIFACT_DIR: path.join(dir, 'artifacts') },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let app;
let ready;
let logs = '';
const exited = new Promise((resolve) => server.once('exit', resolve));
server.stderr.on('data', (b) => {
  logs += b;
});
/** Poll a predicate rather than sleeping: the sandbox's timings are its own. */
const waitFor = async (predicate, what, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = await predicate();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() >= deadline) throw new Error('timed out waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const api = async (route, method = 'GET') => {
  const response = await fetch(ready.baseUrl + '/api/v1' + route, {
    method,
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.equal(response.ok, true, await response.clone().text());
  return response.json();
};
try {
  ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout')), 30000);
    server.stdout.on('data', (b) => {
      logs += b;
      const line = logs.split('\n').find((l) => l.startsWith('M1_QA_05_READY '));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line.slice('M1_QA_05_READY '.length)));
      }
    });
    server.once('error', reject);
    server.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Server exited before ready'));
    });
  });
  app = await electron.launch({
    executablePath,
    args: ['--user-data-dir=' + path.join(dir, 'profile'), '.'],
    cwd: desktop,
    env: { ...process.env, ELECTRON_START_URL: '' },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  // A decoder that lost its zlib dictionaries fails in the console and
  // nowhere else: the canvas simply stops changing, which every pixel
  // assertion below would read as an idle desktop.
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.evaluate(
    ({ baseUrl, token }) =>
      window.crewaid.token.set({
        orchestratorBaseUrl: baseUrl,
        orchestratorToken: token,
      }),
    { baseUrl: ready.baseUrl, token },
  );
  await page.addInitScript(() => {
    window.__screenSockets = [];
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.sent = [];
        this.input = [];
        this.frames = 0;
        this.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') this.frames += 1;
        });
        window.__screenSockets.push(this);
      }
      send(value) {
        if (typeof value === 'string') {
          this.sent.push(JSON.parse(value));
        } else {
          const bytes = ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : new Uint8Array(value);
          const botIdLength = bytes[0];
          this.input.push([...bytes.subarray(1 + botIdLength)]);
        }
        return super.send(value);
      }
    };
  });
  await page.reload();
  await page.locator('[data-connection-status="connected"]').waitFor();
  await page.locator('[data-screen-state="stopped"]').waitFor();
  assert.equal((await api('/bots/' + ready.botId + '/sandbox/start', 'POST')).state, 'RUNNING');
  await page.locator('[data-screen-state="live"] canvas').waitFor();
  const waitForPixels = async () => {
    await page.waitForFunction(() => {
      const canvas = document.querySelector('[data-screen-state="live"] canvas');
      if (!canvas || canvas.width !== 1280 || canvas.height !== 800) return false;
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      let visible = 0;
      let samples = 0;
      for (let i = 0; i < pixels.length; i += 400) {
        samples += 1;
        if (pixels[i + 3] === 255) painted += 1;
        if (pixels[i] > 30 || pixels[i + 1] > 30 || pixels[i + 2] > 30) visible += 1;
      }
      // A cursor blink alone must not pass as a full repaint after clearing.
      return painted / samples > 0.95 && visible / samples > 0.1;
    });
  };
  await waitForPixels();
  console.log('PASS: first startup displays pixels without reload');
  // noVNC's Keyboard listener cancels keydown when grabbed. A view-only
  // canvas must leave it alone, even after it has received focus.
  assert.equal(
    await page.locator('canvas').evaluate((canvas) => {
      canvas.focus();
      return canvas.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'a',
          code: 'KeyA',
          bubbles: true,
          cancelable: true,
        }),
      );
    }),
    true,
    'view-only canvas must not consume keyboard events',
  );
  console.log('PASS: canvas does not capture keyboard events');
  await page.screenshot({ path: path.join(dir, 'rail.png') });

  // ── M2-FE-02 / D-037: expanding is a restyle, not a second viewer ────────
  //
  // The claim under test is the one no unit test in this repo can reach: the
  // rail thumbnail and the full-screen viewer are ONE noVNC instance whose
  // subscription changes quality underneath it. If expanding rebuilt the
  // viewer, the canvas identity below would change; if the surviving decoder
  // could not read the updated Tight stream, the cleared canvas would never
  // repaint and the console would carry an inflate failure.
  const canvasIdentity = async () =>
    page.locator('[data-screen-state="live"] canvas').elementHandle();
  const blankTheCanvas = () =>
    page.locator('[data-screen-state="live"] canvas').evaluate((canvas) => {
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    });
  const lastSubscribeQuality = () =>
    page.evaluate(
      () =>
        window.__screenSockets
          .at(-1)
          .sent.filter((frame) => frame.type === 'screen.subscribe')
          .at(-1)?.payload.quality,
    );

  const railCanvas = await canvasIdentity();
  const errorsBeforeExpand = consoleErrors.length;
  assert.equal(await lastSubscribeQuality(), 3, 'the rail thumbnail subscribes at quality 3');
  // Asserted BEFORE the expand, because everything after it is meant to send:
  // the rail is view-only, so not one byte of input may have left yet.
  assert.equal(
    await page.evaluate(() => window.__screenSockets.at(-1).input.length),
    0,
    'the rail is view-only and must not have sent input',
  );

  await blankTheCanvas();
  await page.getByRole('button', { name: 'View full screen' }).click();
  await page.locator('[data-screen-surface="fullscreen"]').waitFor();
  assert.equal(
    await page.evaluate(
      (previous) => previous === document.querySelector('[data-screen-state="live"] canvas'),
      railCanvas,
    ),
    true,
    'expanding must keep the same canvas — a new one means the viewer was rebuilt',
  );
  await page.waitForFunction(() =>
    window.__screenSockets
      .at(-1)
      .sent.some((frame) => frame.type === 'screen.subscribe' && frame.payload.quality === 9),
  );
  // The quality update must repaint through the existing decoder.
  await waitForPixels();
  // The picture takes focus, not the close button (M2-FE-03). noVNC grabs
  // keydown on its own canvas and creates it with tabIndex -1, so anything
  // else focused means every keystroke is silently dropped until the operator
  // thinks to click the desktop first.
  assert.equal(
    await page
      .locator('[data-screen-state="live"] canvas')
      .evaluate((canvas) => canvas === document.activeElement),
    true,
    'opening focuses the picture, so typing reaches the desktop straight away',
  );
  await page.keyboard.press('Tab');
  assert.equal(
    await page
      .locator('[data-screen-state="live"] canvas')
      .evaluate((canvas) => canvas === document.activeElement),
    true,
    'Tab belongs to the remote desktop while the viewer is open, not to the shell',
  );
  const geometry = await page.locator('canvas').evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height,
    renderedWidth: canvas.getBoundingClientRect().width,
    renderedHeight: canvas.getBoundingClientRect().height,
  }));
  assert.equal(geometry.width, 1280);
  assert.equal(geometry.height, 800);
  assert.ok(Math.abs(geometry.renderedWidth / geometry.renderedHeight - 1.6) < 0.01);
  await page.screenshot({ path: path.join(dir, 'fullscreen.png') });
  console.log('PASS: expanding keeps one viewer and raises the quality to 9');

  // noVNC receives keyup on its canvas, not on the local close control.
  const beforeFocusLoss = await page.evaluate(() => window.__screenSockets.at(-1).input.length);
  await page.keyboard.down('Shift');
  await page.getByRole('button', { name: 'Close full screen' }).focus();
  await page.keyboard.up('Shift');
  assert.ok(
    await page.evaluate(
      (start) =>
        window.__screenSockets
          .at(-1)
          .input.slice(start)
          .some(
            (message) =>
              message[0] === 4 &&
              message[1] === 0 &&
              new DataView(Uint8Array.from(message).buffer).getUint32(4) === 0xffe1,
          ),
      beforeFocusLoss,
    ),
    'moving focus off the canvas must release held Shift',
  );
  await page.locator('canvas').focus();
  console.log('PASS: moving focus to local chrome releases held keys');

  // Native blur is only an observable transition when the Electron window is
  // focused first. On macOS an automated window can have DOM focus while its
  // BrowserWindow is still behind the terminal that launched it; calling
  // blur() in that state is a no-op and tests the probe rather than the app.
  const browserWindow = await app.browserWindow(page);
  await app.evaluate(({ app }) => app.focus({ steal: true }));
  await browserWindow.evaluate((window) => window.focus());
  await new Promise((resolve) => setTimeout(resolve, 250));
  const canDriveNativeBlur = await browserWindow.evaluate((window) => window.isFocused());
  const beforeWindowBlur = await page.evaluate(() => window.__screenSockets.at(-1).input.length);
  await page.keyboard.down('Shift');
  const canvasBox = await page.locator('canvas').boundingBox();
  await page.mouse.move(canvasBox.x + 10, canvasBox.y + 10);
  await page.mouse.down();
  const beforeBlurRelease = await page.evaluate(() => window.__screenSockets.at(-1).input.length);
  if (canDriveNativeBlur) {
    await browserWindow.evaluate((window) => window.blur());
  } else {
    // Headless/automation hosts can deny Electron foreground activation even
    // with `app.focus({ steal: true })`; in that state BrowserWindow.blur() is
    // a no-op. Drive the same DOM event Chromium emits so the release handler
    // remains covered instead of reporting a false product failure.
    await page.evaluate(() => window.dispatchEvent(new FocusEvent('blur')));
  }
  await page.waitForFunction(
    (start) =>
      window.__screenSockets
        .at(-1)
        .input.slice(start)
        .some((message) => message[0] === 5 && message[1] === 0),
    beforeBlurRelease,
  );
  const blurInput = await page.evaluate(
    (start) => window.__screenSockets.at(-1).input.slice(start),
    beforeWindowBlur,
  );
  assert.equal(blurInput.at(-2)[0], 5, 'window blur releases the pointer before its modifier');
  assert.equal(blurInput.at(-2)[1], 0);
  assert.equal(blurInput.at(-1)[0], 4);
  assert.equal(blurInput.at(-1)[1], 0);
  assert.equal(
    await page.locator('#noVNC_mouse_capture_elem').isVisible(),
    false,
    'an interrupted drag must remove the full-window capture overlay',
  );
  await browserWindow.evaluate((window) => window.focus());
  if (!canDriveNativeBlur) {
    await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.locator('canvas').focus();
  console.log(
    `PASS: window blur releases a drag and its modifier in order (${canDriveNativeBlur ? 'native focus' : 'synthetic DOM focus fallback; native focus not verified'})`,
  );

  // ── M2-FE-03: input reaches the real desktop, and stops when told ────────
  //
  // None of this is reachable anywhere else. The unit suite renders with
  // renderToStaticMarkup and cannot even import noVNC, so whether a click on a
  // SCALED canvas lands where the operator aimed, and whether a key held
  // across a collapse is ever released, are only ever answered here.
  const containerId = execFileSync(
    'docker',
    ['ps', '-q', '--filter', 'label=crewaid.sessionId=' + ready.botId],
    { encoding: 'utf8' },
  ).trim();
  assert.notEqual(containerId, '', 'the screen probe container must still be running');
  const inContainer = (...argv) =>
    execFileSync('docker', ['exec', containerId, ...argv], { encoding: 'utf8' });
  const existsInContainer = (file) => {
    try {
      inContainer('test', '-f', file);
      return true;
    } catch {
      return false;
    }
  };
  const decodeInput = () =>
    page.evaluate(() =>
      window.__screenSockets.at(-1).input.map((message) => ({
        type: message[0],
        down: message[1],
        keysym: message[0] === 4 ? new DataView(Uint8Array.from(message).buffer).getUint32(4) : 0,
      })),
    );

  // TWO terminals, at TWO known positions, in TWO directories, and
  // `touch proof.txt` typed with no path in it. The second window takes focus
  // as it maps, so both the focus moving and the file landing in `a` are
  // consequences of the pointer event below and of nothing else — which is the
  // difference between proving the click arrived and proving merely that
  // something, somewhere, was typed. §5's acceptance criterion is this round
  // trip; M2-QA-05 is where it becomes the milestone's own test.
  const TERMINALS = [
    { dir: 'a', x: 40, y: 80 },
    { dir: 'b', x: 700, y: 430 },
  ];
  inContainer('mkdir', '-p', '/home/bot/a', '/home/bot/b');
  for (const [index, terminal] of TERMINALS.entries()) {
    execFileSync('docker', [
      'exec',
      '-d',
      containerId,
      'xfce4-terminal',
      '--disable-server',
      '--geometry=50x14+' + terminal.x + '+' + terminal.y,
      '--working-directory=/home/bot/' + terminal.dir,
    ]);
    // Detached processes can map in either order. Wait for each window before
    // launching the next so terminal b, not a, deterministically gets focus.
    await waitFor(
      () =>
        Number(inContainer('sh', '-c', 'wmctrl -lx | grep -ci xfce4-terminal || true').trim()) ===
        index + 1,
      'terminal ' + terminal.dir + ' to map inside the sandbox',
    );
  }
  // `wmctrl -l` lists MAPPED, managed windows. Waiting on the process instead
  // (pgrep) is what made this flaky: xfce4-terminal exists for most of a second
  // before its window is on screen, and a click sent into that gap lands on
  // whatever was underneath.
  await waitFor(
    () => inContainer('sh', '-c', 'wmctrl -lx | grep -ci xfce4-terminal || true').trim() === '2',
    'both terminals to map inside the sandbox',
  );
  // Which window the sandbox itself considers focused — read from the sandbox,
  // not inferred from our side of the wire.
  const focusedWindowX = () => {
    const shell = inContainer('sh', '-c', 'xdotool getwindowfocus getwindowgeometry --shell');
    const x = /^X=(-?\d+)$/m.exec(shell);
    return x === null ? Number.NaN : Number(x[1]);
  };
  const RIGHT_OF_BOTH = 400;
  await waitFor(
    () => focusedWindowX() > RIGHT_OF_BOTH,
    'the second terminal to take focus as it maps',
  );

  // Remote pixels, converted through the same scale factor the operator's
  // click goes through. R8's client-side scaling is what makes this arithmetic
  // ours to do: the framebuffer stays 1280x800 whatever size the window is.
  const aimAt = (x, y) => ({
    position: {
      x: (x * geometry.renderedWidth) / geometry.width,
      y: (y * geometry.renderedHeight) / geometry.height,
    },
  });
  await page.locator('canvas').click(aimAt(240, 200));
  await waitFor(
    () => focusedWindowX() < RIGHT_OF_BOTH,
    'the click to move focus to the first terminal',
  );
  console.log('PASS: a click on the scaled canvas lands where the operator aimed');

  await page.keyboard.type('touch proof.txt');
  await page.keyboard.press('Enter');
  await page.screenshot({ path: path.join(dir, 'after-input.png') });
  await waitFor(
    () => existsInContainer('/home/bot/a/proof.txt'),
    'typing in the viewer to create /home/bot/a/proof.txt',
  );
  assert.equal(
    existsInContainer('/home/bot/b/proof.txt'),
    false,
    'the keystrokes reached a terminal the click never selected',
  );
  const sent = await decodeInput();
  assert.ok(
    sent.some((message) => message.type === 5) && sent.some((message) => message.type === 4),
    'both a PointerEvent and a KeyEvent must have gone out',
  );
  console.log('PASS: typing in the viewer lands in the real sandbox');

  // A key still held when capture ends. noVNC generates the release itself and
  // then throws it away — `set viewOnly` flips `_viewOnly` before `ungrab()`,
  // and `sendKey` returns early on it — so without the viewer's own release the
  // sandbox holds Shift down for the rest of the container's life, and every
  // click the agent makes afterwards is a shift-click.
  const XK_SHIFT_L = 0xffe1;
  await page.keyboard.down('Shift');
  await page.waitForFunction(
    (keysym) =>
      window.__screenSockets
        .at(-1)
        .input.some(
          (message) =>
            message[0] === 4 &&
            message[1] !== 0 &&
            new DataView(Uint8Array.from(message).buffer).getUint32(4) === keysym,
        ),
    XK_SHIFT_L,
  );

  await blankTheCanvas();
  await page.keyboard.press('Escape');
  await page.locator('[data-screen-surface="rail"]').waitFor();
  assert.equal(
    await page.evaluate(
      (previous) => previous === document.querySelector('[data-screen-state="live"] canvas'),
      railCanvas,
    ),
    true,
    'collapsing must keep the same canvas too',
  );
  await page.waitForFunction(
    () =>
      window.__screenSockets
        .at(-1)
        .sent.filter((frame) => frame.type === 'screen.subscribe')
        .at(-1)?.payload.quality === 3,
  );
  await waitForPixels();
  assert.deepEqual(
    consoleErrors.slice(errorsBeforeExpand),
    [],
    'the surviving decoder must read quality updates without complaint',
  );
  console.log('PASS: Escape collapses back to the rail and drops the quality to 3');
  await page.keyboard.up('Shift');
  const afterCollapse = await decodeInput();
  assert.ok(
    afterCollapse.some(
      (message) => message.type === 4 && message.down === 0 && message.keysym === XK_SHIFT_L,
    ),
    'collapsing must release the key the operator was still holding',
  );
  assert.equal(
    await page.evaluate(() =>
      window.__screenSockets.at(-1).input.some((message) => {
        if (message[0] !== 4) return false;
        return new DataView(Uint8Array.from(message).buffer).getUint32(4) === 0xff1b;
      }),
    ),
    false,
    'the local collapse shortcut must not be sent to the sandbox',
  );
  assert.equal(
    await page
      .getByRole('button', { name: 'View full screen' })
      .evaluate((button) => button === document.activeElement),
    true,
    'collapsing restores focus to the expand control',
  );
  await page.getByRole('button', { name: 'View full screen' }).click();
  await page.getByRole('button', { name: 'Close full screen' }).click();
  await page.locator('[data-screen-surface="rail"]').waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        window.__screenSockets.at(-1).sent.filter((frame) => frame.type === 'screen.unsubscribe')
          .length,
    ),
    0,
    'presentation changes must not unsubscribe',
  );
  console.log('PASS: close button collapses without replacing the subscription');

  await page.evaluate(() => window.__screenSockets[0].close());
  await page.waitForFunction(() => {
    const sockets = window.__screenSockets;
    const current = sockets.at(-1);
    return (
      sockets.length > 1 &&
      current.readyState === 1 &&
      current.sent.some((frame) => frame.type === 'screen.subscribe') &&
      current.frames > 0
    );
  });
  await waitForPixels();
  console.log('PASS: reconnect subscribes and renders fresh frames');
  // Fail the first WebSocket attempt while REST loads the already-running
  // bot. The mounted viewer must subscribe when the retry connects.
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    let first = true;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        if (first) {
          first = false;
          throw new Error('probe: initial connection unavailable');
        }
        super(...args);
      }
    };
  });
  await page.reload();
  await page.waitForFunction(() =>
    window.__screenSockets.some(
      (socket) =>
        socket.readyState === 1 &&
        socket.sent.some((frame) => frame.type === 'screen.subscribe') &&
        socket.frames > 0,
    ),
  );
  await waitForPixels();
  console.log('PASS: viewer recovers when initial connection fails');
  console.log('Screenshots and server log: ' + dir);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await app?.close();
  if (ready) {
    // Only remove the container created for this isolated test bot.
    const ids = execFileSync(
      'docker',
      ['ps', '-aq', '--filter', 'label=crewaid.sessionId=' + ready.botId],
      { encoding: 'utf8' },
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length) execFileSync('docker', ['rm', '-f', ...ids]);
  }
  server.kill('SIGTERM');
  await exited; // e2e-server drops its private schema before exiting.
  await writeFile(path.join(dir, 'server.log'), logs);
  await rm(path.join(dir, 'profile'), { recursive: true, force: true });
}
