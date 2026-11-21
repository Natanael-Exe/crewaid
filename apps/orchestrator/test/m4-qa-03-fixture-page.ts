/**
 * M4-QA-03/04 — the locally served fixture page, and the server that serves it
 * from inside the sandbox.
 *
 * ── WHY SERVED, AND WHY FROM INSIDE THE CONTAINER ───────────────────────────
 *
 * §6/M4's required tests both say "fixture page": "record against a LOCALLY
 * SERVED fixture page" and "run the skill against the fixture at 1280 px and
 * at 900 px". Served matters for more than realism. A `data:` document — what
 * the M4-BE-06 suite used, because the container's fresh tab is
 * `chrome://newtab/` and enforces Trusted Types — has an opaque origin, no
 * navigable URL, and no second document to navigate TO, so it can exercise
 * neither `Page.frameNavigated`/`Network.loadingFinished` (M4-BE-04) nor the
 * `waitForLoadState` the acceptance criteria name. A real origin is also what
 * makes the selector ladder's uniqueness claims mean what they mean at replay.
 *
 * The server runs INSIDE the sandbox, started through the session's own
 * process API and listening on loopback. Three reasons, in order of weight:
 * the page is then genuinely local to the browser that loads it, so nothing
 * about the test depends on container→host routing; §7.3's egress policy on
 * `agent-net` is left exactly as it is, rather than a test needing a hole in
 * it; and the fixture is reachable identically on a developer's Docker
 * Desktop and on a Linux CI runner, where a host-served page would need a
 * different address on each.
 *
 * ── WHAT THE PAGE IS BUILT TO PROVE ─────────────────────────────────────────
 *
 * `#buy` moves a long way between the two required widths — the rail is a flex
 * row above 1000 px and a block stack below it, so at 1280 the button sits in
 * the last of four columns near the right edge, and at 900 it sits near the
 * left edge, three card-heights down. That is the layout shift QA-04 is about:
 * a coordinate recorded at one width names nothing at the other, while
 * `[data-testid="buy"]` names the same element at both. Nothing here is
 * responsive for its own sake — the numbers are chosen so the shift is far
 * larger than any rounding or window-origin uncertainty.
 *
 * The page also reports what happened to it, on itself: a click on `#buy`
 * appends `#receipt`, so a skill can WAIT for a consequence rather than for a
 * duration, and a test can tell "the click landed" from "the click was
 * dispatched". `window.__qa` counts the same events for the readback path.
 */

/** Where the fixture server listens, inside the container. */
export const FIXTURE_PORT = 7171;

/** The origin the sandbox's own Chrome reaches it at. */
export const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;

/** Absolute paths the server owns inside the sandbox. */
export const FIXTURE_SERVER_PATH = '/home/bot/qa-fixture-server.mjs';
export const FIXTURE_SERVER_LOG = '/home/bot/qa-fixture-server.log';

/**
 * The width at which the rail stops being a row. Both required viewport widths
 * are deliberately on opposite sides of it: 1280 > 1000 > 900.
 */
export const FIXTURE_BREAKPOINT_PX = 1000;

/** §6/M4's two required viewport widths, literal. */
export const QA04_WIDE_PX = 1280;
export const QA04_NARROW_PX = 900;

/**
 * The fixture document.
 *
 * Deliberately plain HTML and CSS with no build step: it is served as a
 * string, and a reader checking whether the layout really shifts should be
 * able to see that from this file alone.
 */
export const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Crewaid QA fixture</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.4 system-ui, sans-serif; }
  header { padding: 16px 20px; background: #1d2433; color: #fff; }
  .rail { display: flex; gap: 20px; padding: 20px; }
  .card { flex: 1 1 0; min-width: 0; height: 130px; padding: 16px; background: #eef1f6; border: 1px solid #c7cede; }
  .card button { width: 100%; height: 56px; font-size: 16px; }
  form { padding: 0 20px 20px; }
  #query { width: 320px; height: 40px; font-size: 16px; padding: 0 10px; }
  #receipt { margin: 0 20px 20px; padding: 12px; background: #e6f6ea; border: 1px solid #8fc79f; }
  /* The shift QA-04 measures: a row above the breakpoint, a stack below it. */
  @media (max-width: ${FIXTURE_BREAKPOINT_PX}px) {
    .rail { display: block; }
    .card { margin-bottom: 20px; }
  }
</style>
</head>
<body>
<header id="masthead">Crewaid QA fixture</header>
<div class="rail" id="rail">
  <div class="card"><div>Basic</div></div>
  <div class="card"><div>Standard</div></div>
  <div class="card"><div>Plus</div></div>
  <div class="card" id="last-card">
    <div>Ultimate</div>
    <button id="buy" data-testid="buy" type="button">Buy now</button>
  </div>
</div>
<form id="search" action="/next" method="get">
  <input id="query" data-testid="query" name="q" type="text" aria-label="Search term">
</form>
<script>
  window.__qa = { buy: 0, query: '' };
  // Calibration, for the suites that must place a DESKTOP click on this page:
  // a click event knows both where it landed in the page (clientX/clientY) and
  // where it landed on the screen (screenX/screenY), and the ratio between
  // them is devicePixelRatio. One dispatched click therefore locates the
  // viewport in the framebuffer — read from the page, so the calibration need
  // not be part of any recording (M4-QA-03).
  window.addEventListener('click', function (event) {
    window.__cal = {
      clientX: event.clientX, clientY: event.clientY,
      screenX: event.screenX, screenY: event.screenY,
      dpr: window.devicePixelRatio,
    };
  }, true);
  document.getElementById('buy').addEventListener('click', function () {
    window.__qa.buy += 1;
    if (document.getElementById('receipt') === null) {
      var receipt = document.createElement('div');
      receipt.id = 'receipt';
      receipt.setAttribute('data-testid', 'receipt');
      receipt.textContent = 'Ordered';
      document.body.appendChild(receipt);
    }
  });
  document.getElementById('query').addEventListener('input', function (event) {
    window.__qa.query = event.target.value;
  });
</script>
</body>
</html>`;

/** The document `/next` serves, so a navigation has somewhere real to land. */
export const FIXTURE_NEXT_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Crewaid QA fixture — next</title></head>
<body style="margin:0">
<h1 id="next-heading" data-testid="next-heading">Results</h1>
</body>
</html>`;

/**
 * The server, as the source that is written into the sandbox and run there.
 *
 * Node builtins only, because that is all the image has (M3-PK-01: no npm, no
 * `node_modules`). It binds loopback rather than `0.0.0.0` — the fixture is
 * for the browser in this container and for nothing else, and a sandbox
 * listening on a routable address is the kind of thing §7.3 exists to
 * prevent.
 *
 * `Cache-Control: no-store` on every response: QA-04 loads the same URL at two
 * viewport widths, and a cached document that never re-ran its script would
 * make the second load a different thing from the first in a way nobody
 * reading the test would suspect.
 */
export function fixtureServerSource(): string {
  return `import { createServer } from 'node:http';

const PAGE = ${JSON.stringify(FIXTURE_HTML)};
const NEXT = ${JSON.stringify(FIXTURE_NEXT_HTML)};

const server = createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0];
  const body = path === '/next' ? NEXT : path === '/' || path === '/index.html' ? PAGE : null;
  if (body === null) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
});

server.listen(${FIXTURE_PORT}, '127.0.0.1', () => {
  console.log('qa fixture listening on ${FIXTURE_ORIGIN}');
});
`;
}

/**
 * The shell command that starts it detached from this exec.
 *
 * Output goes to a file rather than the exec's pipes: nothing here drains
 * them, and a server whose stdout buffer filled would stop answering — a
 * failure that would read as a flaky page load rather than as a test-harness
 * mistake.
 */
export function fixtureServerCommand(): string {
  return `nohup node ${FIXTURE_SERVER_PATH} > ${FIXTURE_SERVER_LOG} 2>&1 &`;
}
