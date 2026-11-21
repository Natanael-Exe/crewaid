#!/usr/bin/env node
/**
 * M1-FE-12 live shell probe.
 *
 * Run against a fresh build with:
 *   electron . --remote-debugging-port=9232
 *   node scripts/shell-probe.mjs 9232
 *
 * The probe intentionally drives the real renderer through CDP. It is
 * disposable verification tooling, not application code.
 */

const PORT = process.argv[2] ?? '9232';
const { fileURLToPath } = await import('node:url');
const path = await import('node:path');
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_PREFIX = `file://${APP_DIR}/dist/renderer/`;
const STORAGE_KEY = 'crewaid.pane-layout.v1';

let targets;
try {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  targets = await response.json();
} catch {
  console.error(`FAIL: no CDP target answered on port ${PORT}`);
  process.exit(2);
}

const pages = targets.filter((target) => target.type === 'page' && target.title === 'Crewaid');
if (pages.length !== 1) {
  console.error(`FAIL: expected exactly one Crewaid page, found ${pages.length}`);
  process.exit(2);
}

const page = pages[0];
if (!page.url.startsWith(EXPECTED_PREFIX)) {
  console.error(`FAIL: wrong renderer build answered: ${page.url}`);
  process.exit(2);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
};

await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

await call('Runtime.enable');
await call('Page.enable');

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function waitForShell() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ready = await evaluate("Boolean(document.querySelector('[data-pane-shell]'))");
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('shell did not mount');
}

async function snapshot() {
  return evaluate(`(() => {
    const pane = (selector) => document.querySelector(selector)?.getBoundingClientRect().width ?? null;
    const selectedHeading = document.querySelector('main h1')?.textContent ?? null;
    const selectedOption = document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? null;
    const search = document.querySelector('input[aria-label="Search bots"]');
    return {
      shellWidth: pane('[data-pane-shell]'),
      sidebarWidth: pane('[data-pane="sidebar"]'),
      railWidth: pane('[data-pane="rail"]'),
      transcriptWidth: pane('main'),
      collapsedRailWidth: pane('[data-pane="rail-collapsed"]'),
      sashCount: document.querySelectorAll('[data-pane-sash]').length,
      connectionStatus: document.querySelector('[data-connection-status]')?.getAttribute('data-connection-status') ?? null,
      markdownRenderers: document.querySelectorAll('[data-markdown-renderer="streaming"]').length,
      markdownCodeBlocks: document.querySelectorAll('[data-markdown-block="code"]').length,
      markdownHighlights: document.querySelectorAll('[data-markdown-code] [class^="hljs-"]').length,
      markdownRawFence: [...document.querySelectorAll('[data-markdown-renderer="streaming"]')].some((node) =>
        node.textContent?.includes(String.fromCharCode(96, 96, 96)) === true,
      ),
      markdownUnsafeElements: document.querySelectorAll(
        '[data-markdown-renderer="streaming"] script, [data-markdown-renderer="streaming"] img',
      ).length,
      separators: [...document.querySelectorAll('[data-pane-sash]')].map((node) => ({
        side: node.getAttribute('data-pane-sash'),
        role: node.getAttribute('role'),
        min: node.getAttribute('aria-valuemin'),
        max: node.getAttribute('aria-valuemax'),
      })),
      storage: localStorage.getItem('${STORAGE_KEY}'),
      searchFocused: document.activeElement === search,
      selectedHeading,
      selectedOption,
    };
  })()`);
}

async function dispatch(expression) {
  await evaluate(expression);
  await new Promise((resolve) => setTimeout(resolve, 80));
}

async function drag(side, start, end) {
  await dispatch(`(() => {
    const sash = document.querySelector('[data-pane-sash="${side}"]');
    if (!sash) throw new Error('missing ${side} sash');
    sash.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, clientX: ${start}
    }));
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, cancelable: true, clientX: ${end}
    }));
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, clientX: ${end}
    }));
  })()`);
}

async function key(key, modifiers = {}) {
  await dispatch(`(() => {
    const sash = document.querySelector('[data-pane-sash="${modifiers.side ?? ''}"]');
    const target = sash ?? document.body;
    if (${modifiers.focusSearch ? 'true' : 'false'}) {
      document.querySelector('input[aria-label="Search bots"]')?.focus();
    }
    target.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: '${key}',
      metaKey: ${Boolean(modifiers.metaKey)}, ctrlKey: ${Boolean(modifiers.ctrlKey)},
      shiftKey: ${Boolean(modifiers.shiftKey)}, altKey: ${Boolean(modifiers.altKey)}
    }));
  })()`);
}

await waitForShell();
await evaluate(`localStorage.removeItem('${STORAGE_KEY}'); location.reload(); true`);
await new Promise((resolve) => setTimeout(resolve, 350));
await waitForShell();

const initial = await snapshot();
await drag('left', 0, 45);
const afterSidebarDrag = await snapshot();
await drag('right', 0, -100);
const afterRailDrag = await snapshot();

await key('Home', { side: 'left' });
const afterSidebarHome = await snapshot();
await key('End', { side: 'left' });
const afterSidebarEnd = await snapshot();
await key('Home', { side: 'right' });
const afterRailHome = await snapshot();
await key('End', { side: 'right' });
const afterRailEnd = await snapshot();

// Set non-default values through the real drag handlers, then reload and read
// the persisted values back from the freshly mounted shell.
const persistedSidebarWidth = Math.max(220, afterRailEnd.sidebarWidth - 45);
const persistedRailWidth = Math.max(300, afterRailEnd.railWidth - 30);
await drag('left', 0, persistedSidebarWidth - afterRailEnd.sidebarWidth);
await drag('right', 0, afterRailEnd.railWidth - persistedRailWidth);
const beforeReload = await snapshot();
await call('Page.reload', { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 350));
await waitForShell();
const afterReload = await snapshot();

await key('k', { metaKey: true });
const afterCmdK = await snapshot();
await key('2', { metaKey: true });
const afterCmd2 = await snapshot();
await key('1', { metaKey: true });
const afterCmd1 = await snapshot();

await dispatch(`document.querySelector('button[aria-label="Collapse panel"]')?.click()`);
const afterCollapse = await snapshot();
await dispatch(`document.querySelector('button[aria-label="Expand panel"]')?.click()`);
const afterExpand = await snapshot();

const measuredShellWidth = Math.floor(initial.shellWidth ?? 0);
const expectedSidebarEnd = Math.min(
  360,
  Math.max(220, measuredShellWidth - 480 - 16 - afterRailDrag.railWidth),
);
const expectedRailEnd = Math.min(
  700,
  Math.max(300, measuredShellWidth - 480 - 16 - afterSidebarEnd.sidebarWidth),
);

const connectionStatuses = ['connected', 'connecting', 'reconnecting', 'disconnected'];
const shellSnapshots = [
  initial,
  afterSidebarDrag,
  afterRailDrag,
  afterSidebarHome,
  afterSidebarEnd,
  afterRailHome,
  afterRailEnd,
  beforeReload,
  afterReload,
  afterCmdK,
  afterCmd2,
  afterCmd1,
  afterCollapse,
  afterExpand,
];
const checks = {
  'default sidebar is 275px': initial.sidebarWidth === 275,
  'default rail is 355px': initial.railWidth === 355,
  'two accessible sashes render':
    initial.sashCount === 2 && initial.separators.every((s) => s.role === 'separator'),
  'sashes expose legal clamps':
    initial.separators.some((s) => s.side === 'left' && s.min === '220' && s.max === '360') &&
    initial.separators.some((s) => s.side === 'right' && s.min === '300' && s.max === '700'),
  'connection status badge persists through shell interactions': shellSnapshots.every((state) =>
    connectionStatuses.includes(state.connectionStatus),
  ),
  'markdown renderer stays structured and safe through shell interactions': shellSnapshots.every(
    (state) =>
      state.markdownRenderers >= 1 &&
      state.markdownCodeBlocks >= 1 &&
      state.markdownHighlights >= 1 &&
      state.markdownRawFence === false &&
      state.markdownUnsafeElements === 0,
  ),
  'left pointer drag grows sidebar': afterSidebarDrag.sidebarWidth === 320,
  'right pointer drag grows rail': afterRailDrag.railWidth === 455,
  'left Home clamps to 220px': afterSidebarHome.sidebarWidth === 220,
  'left End clamps at the measured transcript-safe maximum':
    afterSidebarEnd.sidebarWidth === expectedSidebarEnd,
  'right Home clamps to 300px': afterRailHome.railWidth === 300,
  'right End clamps at the measured transcript-safe maximum':
    afterRailEnd.railWidth === expectedRailEnd,
  'transcript never falls below its 480px minimum': [
    initial,
    afterSidebarDrag,
    afterRailDrag,
    afterSidebarHome,
    afterSidebarEnd,
    afterRailHome,
    afterRailEnd,
    beforeReload,
    afterReload,
  ].every((state) => (state.transcriptWidth ?? 0) >= 480),
  'drag writes both pane widths':
    beforeReload.sidebarWidth === persistedSidebarWidth &&
    beforeReload.railWidth === persistedRailWidth &&
    beforeReload.storage !== null,
  'reload restores persisted widths':
    afterReload.sidebarWidth === persistedSidebarWidth &&
    afterReload.railWidth === persistedRailWidth,
  'Cmd+K focuses Search bots': afterCmdK.searchFocused === true,
  'Cmd+2 selects Warden': afterCmd2.selectedOption?.includes('Warden') === true,
  'Cmd+1 selects pinned Quill': afterCmd1.selectedHeading === 'Quill',
  'collapse keeps a 48px restore rail and removes the right sash':
    afterCollapse.collapsedRailWidth === 48 &&
    afterCollapse.railWidth === null &&
    afterCollapse.sashCount === 1,
  'expand restores the persisted rail width and sash':
    afterExpand.railWidth === persistedRailWidth &&
    afterExpand.collapsedRailWidth === null &&
    afterExpand.sashCount === 2,
};

console.log(
  JSON.stringify(
    {
      initial,
      afterSidebarDrag,
      afterRailDrag,
      afterSidebarHome,
      afterSidebarEnd,
      afterRailHome,
      afterRailEnd,
      beforeReload,
      afterReload,
      afterCmdK,
      afterCmd2,
      afterCmd1,
      afterCollapse,
      afterExpand,
    },
    null,
    2,
  ),
);
let failures = 0;
for (const [name, passed] of Object.entries(checks)) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
  if (!passed) failures += 1;
}

socket.close();
process.exit(failures === 0 ? 0 : 1);
