#!/usr/bin/env node
/**
 * Capture a PNG of the running renderer via CDP.
 * Usage: node scripts/renderer-shot.mjs 9223 out.png
 */

const [port = '9223', out = 'renderer.png'] = process.argv.slice(2);

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('FAIL: no page target');
  process.exit(1);
}

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

await call('Page.enable');

const shot = await call('Page.captureScreenshot', { format: 'png' });
if (!shot?.data) {
  console.error('FAIL: captureScreenshot returned', JSON.stringify(shot));
  process.exit(1);
}
const { writeFileSync } = await import('node:fs');
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`saved -> ${out}`);
ws.close();
