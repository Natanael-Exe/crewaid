#!/usr/bin/env node
/**
 * Renderer smoke probe (M1 verification tool).
 *
 * Launch the app with remote debugging enabled, then run this:
 *
 *   electron . --remote-debugging-port=9223
 *   node scripts/renderer-smoke.mjs 9223
 *
 * Connects to the CDP endpoint, finds the Crewaid page, and evaluates DOM
 * assertions in the live renderer. Exit 0 = shell verified; exit 1 otherwise.
 * D-013 philosophy: prove it, do not assume it.
 *
 * WRONG-BUILD GUARD:
 * The probe hard-fails (exit 2) unless the answering window's file:// URL
 * points into THIS tree's apps/desktop/dist/renderer. Reason: if an Electron
 * from another checkout is already bound to the debug port, a new instance
 * silently fails to bind and the probe would verify the wrong build — a
 * verification tool that trusts whichever window answers can green-light the
 * wrong code. It also refuses ambiguous targets (more than one Crewaid page).
 */

const PORT = process.argv[2] ?? '9223';
const { fileURLToPath, pathToFileURL } = await import('node:url');
const path = await import('node:path');

/** The renderer build this checkout produces — the ONLY build this probe may verify. */
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_PREFIX = pathToFileURL(path.join(APP_DIR, 'dist', 'renderer', path.sep)).href;

let targets;
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  targets = await res.json();
} catch {
  console.error(
    `FAIL: nothing answered on port ${PORT}. Either the app is not running with ` +
      '--remote-debugging-port, or ANOTHER Electron already holds that port and this ' +
      'instance silently failed to bind (the exact wrong-build scenario this probe guards against). ' +
      'Kill stale instances and re-run.',
  );
  process.exit(2);
}
const pages = targets.filter((t) => t.type === 'page' && t.title === 'Crewaid');

if (pages.length === 0) {
  console.error(
    `FAIL: no "Crewaid" page target answered on port ${PORT}. ` +
      'Is the app running with --remote-debugging-port?',
  );
  process.exit(1);
}

if (pages.length > 1) {
  console.error(
    `FAIL: ${pages.length} "Crewaid" page targets answered on port ${PORT} — ambiguous.\n` +
      'Kill stale Electron instances and re-run isolated. URLs:\n' +
      pages.map((p) => `  ${p.url}`).join('\n'),
  );
  process.exit(2);
}

const page = pages[0];
if (!page.url.startsWith(EXPECTED_PREFIX)) {
  console.error(
    'FAIL: WRONG BUILD answered the probe. Refusing to verify (D-013).\n' +
      `  answering window: ${page.url}\n` +
      `  expected build:   ${EXPECTED_PREFIX}\n` +
      "Another checkout's Electron is probably still bound to this port. Kill it and re-run.",
  );
  process.exit(2);
}

console.log(`verifying build under test: ${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

function call(method, params) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};

await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

const expression = `(() => {
  const root = document.querySelector('#root');
  return {
    title: document.title,
    rootPresent: !!root,
    rootChildren: root ? root.children.length : 0,
    sidebars: document.querySelectorAll('aside').length,
    bubbles: document.querySelectorAll('section [class*="rounded-"]').length,
    composerPlaceholder: document.querySelector('input[aria-label^="Message"], textarea[aria-label^="Message"]')
      ?.placeholder ?? null,
    // Composer right button is mode-dependent:
    //   active → stop (enabled), idle+draft → send (enabled),
    //   idle+empty → voice mic (disabled when voice is unavailable).
    // The mic must exist and be disabled whenever no send/stop button shows.
    voiceDisabled: (() => {
      const mic = document.querySelector('button[aria-label^="Voice"]');
      return mic === null ? null : mic.disabled;
    })(),
    sendOrStopPresent: !!document.querySelector('button[aria-label="Send message"], button[aria-label="Stop generating"]'),
    connectionStatus: document.querySelector('[data-connection-status]')?.getAttribute('data-connection-status') ?? null,
    connectionLabel: document.querySelector('[data-connection-status]')?.textContent?.trim() ?? null,
    markdownRenderers: document.querySelectorAll('[data-markdown-renderer="streaming"]').length,
    markdownCodeBlocks: document.querySelectorAll('[data-markdown-block="code"]').length,
    markdownHighlights: document.querySelectorAll('[data-markdown-code] [class^="hljs-"]').length,
    markdownRawFence: [...document.querySelectorAll('[data-markdown-renderer="streaming"]')].some((node) =>
      node.textContent?.includes(String.fromCharCode(96, 96, 96)) === true,
    ),
    markdownUnsafeElements: document.querySelectorAll(
      '[data-markdown-renderer="streaming"] script, [data-markdown-renderer="streaming"] img',
    ).length,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    theme: document.documentElement.dataset.theme ?? null,
    themeBackground: (() => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--background)';
      document.body.append(probe);
      const background = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return background;
    })(),
    // M1-FE-03
    sidebarSearch: !!document.querySelector('input[aria-label="Search bots"]'),
    botRows: document.querySelectorAll('[role="listbox"] [role="option"], ul[role="listbox"] li, [role="listbox"] > *').length,
    statusDots: document.querySelectorAll('span[aria-label]').length,
    pinnedCard: document.querySelectorAll('aside:first-of-type [class~="rounded-card"]').length,
    // M1-FE-04
    systemEvents: [...document.querySelectorAll('div')].filter((d) =>
      d.textContent === 'Renamed to Chief of staff' && d.children.length === 0).length,
    streamingTail: [...document.querySelectorAll('div')].some((d) =>
      d.textContent?.startsWith('Draft 1 (the nudge)')),
    // M1-FE-08: the seed USER message carries a claimed attachment → a
    // download card must render inside its bubble (name sits in a span).
    attachmentCard: [...document.querySelectorAll('span')].some((s) =>
      s.textContent === 'hartley-roi-one-pager.md'),
    authenticatedDownloadLink: !!document.querySelector('a[href*="/attachments/"][download]'),
    // Hand-rolled check: react-aria/HeroUI buttons carry data-rac. The RAC
    // DropZone internal keyboard drop button also matches the button tag but
    // is react-aria-managed — excluded by its aria-label prefix.
    noHandRolledButtons: [...document.querySelectorAll('button')]
      .filter((b) => !(b.getAttribute('aria-label') ?? '').startsWith('Drop files'))
      .filter((b) => !b.matches('[data-slot="chip"]'))
      .every((b) => b.hasAttribute('data-rac')),
    // PO acceptance note: chips are HeroUI Chip (data-slot="chip"), not
    // hand-rolled badges. The download action is a Chip rendered as a button;
    // it fetches through ApiClient before a blob URL reaches the download
    // manager, so the authenticated request keeps its bearer (D-025).
    chipCount: document.querySelectorAll('[data-slot="chip"]').length,
    downloadIsChipButton: (() => {
      const button = [...document.querySelectorAll('button[data-slot="chip"]')].find((node) =>
        node.textContent?.includes('Download'));
      return button !== undefined;
    })(),
  };
})()`;

const result = await call('Runtime.evaluate', { expression, returnByValue: true });
const dom = result.result.value;

console.log(JSON.stringify(dom, null, 2));

const checks = {
  'page title is Crewaid': dom.title === 'Crewaid',
  'React mounted into #root': dom.rootPresent && dom.rootChildren > 0,
  'three-pane shell (2 asides: sidebar + rail)': dom.sidebars === 2,
  'transcript bubbles rendered': dom.bubbles > 0,
  'composer placeholder bound to bot name': (dom.composerPlaceholder ?? '').startsWith('Message '),
  // M1-FE-07: in the seed the bot IS streaming → the right button is STOP.
  // The disabled mic only shows when idle with an empty draft. The ruling
  // "render disabled" means: whenever the mic renders, it is disabled.
  'composer shows stop while streaming': dom.sendOrStopPresent === true,
  'connection status badge is mounted':
    ['connected', 'connecting', 'reconnecting', 'disconnected'].includes(dom.connectionStatus) &&
    (dom.connectionLabel ?? '').length > 0,
  'text parts use the streaming markdown renderer': dom.markdownRenderers >= 1,
  'streaming markdown renders a code block': dom.markdownCodeBlocks >= 1,
  'streaming markdown highlights known code': dom.markdownHighlights >= 1,
  'streaming markdown never exposes raw fence markers': dom.markdownRawFence === false,
  'streaming markdown has no active HTML elements': dom.markdownUnsafeElements === 0,
  'voice mic disabled whenever rendered (or absent while stop shows)':
    dom.voiceDisabled === true || dom.voiceDisabled === null,
  'light theme uses the Crewaid background token':
    dom.theme === 'crewaid' && dom.themeBackground.length > 0 && dom.bodyBg === dom.themeBackground,
  // M1-FE-03
  'sidebar search input present': dom.sidebarSearch === true,
  'bot rows rendered in listbox': dom.botRows >= 5,
  'pinned bot card present': dom.pinnedCard >= 1,
  // M1-FE-04
  'SYSTEM event renders as centered text': dom.systemEvents === 1,
  'streaming tail renders in normal flow': dom.streamingTail === true,
  // M1-FE-08
  'seed attachment renders as a download card': dom.attachmentCard === true,
  'authenticated download is never handed to a link': dom.authenticatedDownloadLink === false,
  'no hand-rolled <button> remains (HeroUI Button / react-aria only)':
    dom.noHandRolledButtons === true,
  // PO chip acceptance note
  'download action is a HeroUI Chip button (accent/primary)':
    dom.downloadIsChipButton === true && dom.chipCount >= 2,
};

let failed = 0;
for (const [name, ok] of Object.entries(checks)) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}

ws.close();
process.exit(failed === 0 ? 0 : 1);
