#!/usr/bin/env node
/**
 * Composer interaction probe (M1-FE-07 + M1-FE-10).
 * Requires the app running with --remote-debugging-port. Verifies the
 * send/stop state machine through REAL DOM interaction:
 *   1. idle + empty draft → mic rendered, disabled
 *   2. type text          → send arrow replaces mic
 *   3. click send         → mode active → stop button
 *   4. click stop         → back to idle → mic (disabled) again
 * M1-FE-10 also exercises the model catalog picker through the real renderer:
 * loading → ready, provider:model identity/capability chips, keyboard selection,
 * per-bot persistence across reload, and error → retry.
 * Exit 0 iff all checks hold.
 */

const PORT = process.argv[2] ?? '9236';
const { fileURLToPath } = await import('node:url');
const path = await import('node:path');
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_PREFIX = `file://${APP_DIR}/dist/renderer/`;

const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const pages = targets.filter((t) => t.type === 'page' && t.title === 'Crewaid');
if (pages.length !== 1) {
  console.error(`FAIL: expected exactly 1 Crewaid page, got ${pages.length}`);
  process.exit(2);
}
if (!pages[0].url.startsWith(EXPECTED_PREFIX)) {
  console.error('FAIL: WRONG BUILD answered the probe. Refusing to verify (D-013).');
  process.exit(2);
}

const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
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

const MODEL_CATALOG = {
  models: [
    {
      id: 'anthropic:claude-haiku-4-5',
      provider: 'anthropic',
      label: 'Claude Haiku 4.5',
      capabilities: { tools: true, vision: true, reasoning: false },
      contextWindow: 200000,
    },
    {
      id: 'openrouter:deepseek/deepseek-v4-pro-0813',
      provider: 'openrouter',
      label: 'DeepSeek V4 Pro 0813 (OpenRouter)',
      capabilities: { tools: true, vision: false, reasoning: true },
      contextWindow: 1048576,
    },
  ],
};

function catalogFetchScript({ delayMs = 0, reject = false } = {}) {
  const payload = JSON.stringify(MODEL_CATALOG);
  const responseStatement = reject
    ? "return Promise.reject(new Error('catalog socket detail must stay normalized'));"
    : `return new Promise((resolve) => setTimeout(() => resolve(new Response(${JSON.stringify(payload)}, { status: 200, headers: { 'content-type': 'application/json' } })), ${delayMs}));`;
  return `(() => {
    window.fetch = (input) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      if (!url.endsWith('/api/v1/models')) return Promise.reject(new Error('unexpected smoke fetch'));
      ${responseStatement}
    };
  })()`;
}

async function installCatalogFetch(options) {
  await call('Runtime.evaluate', { expression: catalogFetchScript(options) });
}

async function waitForModelState(state) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await evaluate(
      `document.querySelector('[data-model-picker]')?.getAttribute('data-model-picker-state')`,
    );
    if (current === state) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`model picker did not reach ${state}`);
}

async function composerState() {
  const { result } = await call('Runtime.evaluate', {
    expression: `(() => ({
      mic: (() => { const b = document.querySelector('button[aria-label^="Voice"]'); return b ? { disabled: b.disabled } : null; })(),
      send: !!document.querySelector('button[aria-label="Send message"]'),
      stop: !!document.querySelector('button[aria-label="Stop generating"]'),
      value: document.querySelector('textarea[aria-label^="Message"]')?.value ?? null,
    }))()`,
    returnByValue: true,
  });
  return result.value;
}

async function modelPickerState() {
  return evaluate(`(() => {
    const picker = document.querySelector('[data-model-picker]');
    const input = picker?.querySelector('input[aria-label="Model"]');
    const retry = picker?.querySelector('button[aria-label="Retry loading models"]');
    const listbox = document.querySelector('[role="listbox"][aria-label="Available models"]');
    return {
      state: picker?.getAttribute('data-model-picker-state') ?? null,
      selected: picker?.getAttribute('data-model-picker-selected') ?? null,
      unavailable: picker?.getAttribute('data-model-picker-unavailable') ?? null,
      catalog: picker?.getAttribute('data-model-picker-catalog') ?? '',
      inputDisabled: input?.disabled ?? null,
      inputPlaceholder: input?.placeholder ?? null,
      retryPresent: retry !== null,
      listboxPresent: listbox !== null,
      sections: listbox ? [...listbox.querySelectorAll('section')].map((section) => section.getAttribute('aria-label')) : [],
      options: listbox ? [...listbox.querySelectorAll('[role="option"]')].map((option) => ({
        id: option.getAttribute('data-key'),
        text: option.textContent?.trim() ?? '',
        selected: option.getAttribute('aria-selected'),
      })) : [],
      capabilityChips: listbox ? [...listbox.querySelectorAll('[data-slot="chip"]')].map((chip) => chip.textContent?.trim()) : [],
      storage: localStorage.getItem('crewaid.model-picker.v1'),
    };
  })()`);
}

// NOTE: this probe intentionally flips the app out of its seed streaming
// state by clicking stop — that IS the interaction under test.

const checks = [];
function record(name, ok) {
  checks.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

// 1. seed state: streaming → stop button
let s = await composerState();
record('1. seed: stop visible (bot streaming)', s.stop && !s.send && s.mic === null);

// M1-FE-10: the live app initially has no orchestrator in this smoke process,
// so the production catalog request reaches its normalized error state. Replace
// only window.fetch in this page, then use the real Retry button to exercise the
// production loader and picker UI.
await waitForModelState('error');
let models = await modelPickerState();
record(
  '5. catalog error is disabled and offers a neutral retry',
  models.state === 'error' && models.inputDisabled === true && models.retryPresent === true,
);

await installCatalogFetch({ delayMs: 80 });
await call('Runtime.evaluate', {
  expression: `document.querySelector('button[aria-label="Retry loading models"]')?.click()`,
});
await new Promise((resolve) => setTimeout(resolve, 15));
models = await modelPickerState();
record(
  '6. catalog exposes an honest loading state',
  models.state === 'loading' && models.selected === null,
);
await waitForModelState('ready');
models = await modelPickerState();
record(
  '7. ready catalog preserves provider:model ids and capability metadata',
  models.state === 'ready' &&
    models.catalog.includes('Anthropic') &&
    models.catalog.includes('anthropic:claude-haiku-4-5') &&
    models.catalog.includes('OpenRouter') &&
    models.catalog.includes('openrouter:deepseek/deepseek-v4-pro-0813') &&
    models.catalog.includes('Tools') &&
    models.catalog.includes('Vision') &&
    models.catalog.includes('Reasoning'),
);

// Open the actual HeroUI Autocomplete and select the second option with the
// keyboard. The option must be selected from the validated collection, not by
// writing a model id into component state.
await call('Runtime.evaluate', {
  expression: `document.querySelector('[data-model-picker] input[aria-label="Model"]')?.click()`,
});
await new Promise((resolve) => setTimeout(resolve, 120));
models = await modelPickerState();
record(
  '8. keyboard-opened picker renders provider sections, options, and capability Chips',
  models.listboxPresent &&
    models.sections.includes('Anthropic') &&
    models.sections.includes('OpenRouter') &&
    models.options.length === 2 &&
    models.options.some((option) => option.id === 'anthropic:claude-haiku-4-5') &&
    models.options.some((option) => option.id === 'openrouter:deepseek/deepseek-v4-pro-0813') &&
    models.capabilityChips.includes('Tools') &&
    models.capabilityChips.includes('Vision') &&
    models.capabilityChips.includes('Reasoning'),
);
await call('Runtime.evaluate', {
  expression: `document.querySelector('[data-model-picker] input[aria-label="Model"]')?.focus()`,
});
for (const key of ['ArrowDown', 'Enter']) {
  const code = key;
  const windowsVirtualKeyCode = key === 'ArrowDown' ? 40 : 13;
  await call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
  });
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
  });
}
await new Promise((resolve) => setTimeout(resolve, 150));
models = await modelPickerState();
record(
  '9. ArrowDown + Enter selects only an available model and persists it per bot',
  models.selected === 'openrouter:deepseek/deepseek-v4-pro-0813' &&
    models.storage?.includes('openrouter:deepseek/deepseek-v4-pro-0813') === true &&
    models.unavailable === 'false',
);

// Install the same valid catalog before a full reload, then verify the persisted
// id is restored by a fresh ModelPicker instance.
await call('Page.addScriptToEvaluateOnNewDocument', { source: catalogFetchScript() });
await call('Page.reload', { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 250));
await waitForModelState('ready');
models = await modelPickerState();
record(
  '10. fresh mount restores the persisted selection',
  models.selected === 'openrouter:deepseek/deepseek-v4-pro-0813',
);

// Error → retry on a bot switch. The picker does not render a Retry button
// while ready; switching bots is the real lifecycle boundary that re-fetches
// the same catalog for a different bot.
await installCatalogFetch({ reject: true });
await call('Runtime.evaluate', {
  expression: `document.querySelector('[role="listbox"][aria-label="Bots"] [data-key="bot_warden_01"]')?.click()`,
});
await waitForModelState('error');
models = await modelPickerState();
record(
  '11. a failed catalog load returns to the disabled normalized error state',
  models.state === 'error' && models.inputDisabled === true && models.retryPresent === true,
);
await installCatalogFetch();
await call('Runtime.evaluate', {
  expression: `document.querySelector('[data-model-picker] button[aria-label="Retry loading models"]')?.click()`,
});
await waitForModelState('ready');
models = await modelPickerState();
record(
  '12. Retry recovers to the validated catalog',
  models.state === 'ready' && models.selected === 'anthropic:claude-haiku-4-5',
);
await call('Runtime.evaluate', {
  expression: `document.querySelector('button[aria-label="Open Quill"]')?.click()`,
});
await waitForModelState('ready');
models = await modelPickerState();
record(
  '13. returning to the original bot restores its persisted model',
  models.selected === 'openrouter:deepseek/deepseek-v4-pro-0813',
);

// 2. click stop → idle+empty → disabled mic
await call('Runtime.evaluate', {
  expression: `document.querySelector('button[aria-label="Stop generating"]').click()`,
});
await new Promise((r) => setTimeout(r, 150));
s = await composerState();
record('2. after stop: disabled mic, no send/stop', s.mic?.disabled === true && !s.send && !s.stop);

// 3. type a draft → send arrow appears
await call('Runtime.evaluate', {
  expression: `(() => {
    const ta = document.querySelector('textarea[aria-label^="Message"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'probe draft text');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`,
});
await new Promise((r) => setTimeout(r, 150));
s = await composerState();
record(
  '3. with draft: send visible, mic gone, value set',
  s.send && s.mic === null && s.value === 'probe draft text',
);

// 4. click send → active → stop again
await call('Runtime.evaluate', {
  expression: `document.querySelector('button[aria-label="Send message"]').click()`,
});
await new Promise((r) => setTimeout(r, 150));
s = await composerState();
record('4. after send: stop visible, draft cleared', s.stop && !s.send && s.value === '');

// restore the seed streaming view for any screenshot taken afterwards:
// (stop was already clicked in step 4's send; click stop to return to idle)
await call('Runtime.evaluate', {
  expression: `document.querySelector('button[aria-label="Stop generating"]')?.click()`,
});

const failed = checks.filter(([, ok]) => !ok).length;
ws.close();
process.exit(failed === 0 ? 0 : 1);
