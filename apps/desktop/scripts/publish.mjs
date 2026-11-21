#!/usr/bin/env node
// Publish one edition's packaged release to downloads.crewaid.io (D-153):
//   DOWNLOADS_UPLOAD_SECRET=… node scripts/publish.mjs <cloud|selfhosted> [releaseDir]
//
// Uploads the installers, their zips and blockmaps first and the latest*.yml
// update feeds last, so an app or a download button that reads the feed
// mid-publish is never pointed at a file that is not there yet. Files over
// SINGLE_LIMIT go up in parts: Cloudflare refuses request bodies over 100 MB at
// the edge, and a macOS installer is about 125 MB.
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const MiB = 1024 * 1024;
const BASE = process.env.DOWNLOADS_BASE_URL ?? 'https://downloads.crewaid.io';
const PART = Number(process.env.PUBLISH_PART_MIB ?? '64') * MiB;
const SINGLE_LIMIT = Math.min(PART, 90 * MiB);

const [edition, dir = 'release'] = process.argv.slice(2);
if (edition !== 'cloud' && edition !== 'selfhosted') {
  console.error('usage: node scripts/publish.mjs <cloud|selfhosted> [releaseDir]');
  process.exit(2);
}
const secret = process.env.DOWNLOADS_UPLOAD_SECRET ?? '';
if (secret === '') {
  console.error('DOWNLOADS_UPLOAD_SECRET is required');
  process.exit(2);
}

const names = await readdir(dir).catch((error) => {
  console.error(`publish failed: cannot read ${dir}: ${error.message}`);
  process.exit(1);
});
const payload = names.filter((name) => /\.(dmg|zip|exe|deb|blockmap)$/.test(name)).sort();
const feeds = names.filter((name) => /^latest.*\.yml$/.test(name)).sort();
if (feeds.length === 0) {
  console.error(`no latest*.yml in ${dir}: electron-builder wrote no update feed`);
  process.exit(1);
}

try {
  for (const name of [...payload, ...feeds]) {
    const file = path.join(dir, name);
    const { size } = await stat(file);
    let result;
    try {
      result = size <= SINGLE_LIMIT ? await single(file, name) : await multipart(file, name, size);
    } catch (error) {
      // The Worker refuses a feed older than the published one: this is a
      // re-run of an earlier release, and the newer feed staying is correct.
      if (feeds.includes(name) && error.status === 409) {
        console.warn(`kept the newer feed: ${error.message}`);
        continue;
      }
      throw error;
    }
    console.log(`published desktop/${edition}/${name} (${result.size} bytes)`);
    // Publishing a feed deletes releases older than the ones the Worker keeps.
    for (const key of result.pruned ?? []) console.log(`pruned ${key}`);
    if (result.size !== size) throw new Error(`${name}: uploaded ${result.size} bytes of ${size}`);
  }
} catch (error) {
  console.error(`publish failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function target(name, query = '') {
  return `${BASE}/desktop/${edition}/${encodeURIComponent(name)}${query}`;
}

async function single(file, name) {
  const handle = await open(file);
  try {
    const body = await handle.readFile();
    return await call('PUT', target(name), body);
  } finally {
    await handle.close();
  }
}

/** R2 multipart through the Worker: equal-size parts, read one at a time. */
async function multipart(file, name, size) {
  const { uploadId } = await call('POST', target(name, '?uploads'));
  const id = encodeURIComponent(uploadId);
  const handle = await open(file);
  const parts = [];
  try {
    for (let offset = 0, partNumber = 1; offset < size; offset += PART, partNumber++) {
      const length = Math.min(PART, size - offset);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      const part = await call(
        'PUT',
        target(name, `?uploadId=${id}&partNumber=${partNumber}`),
        buffer,
      );
      parts.push({ partNumber: part.partNumber, etag: part.etag });
    }
  } finally {
    await handle.close();
  }
  return await call(
    'POST',
    target(name, `?uploadId=${id}`),
    JSON.stringify({ parts }),
    'application/json',
  );
}

/** One request, retried: a release is many large uploads over a public network. */
async function call(method, url, body, contentType = 'application/octet-stream') {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${secret}`, 'content-type': contentType },
        ...(body === undefined ? {} : { body }),
      });
      const text = await response.text();
      // A refusal is an answer, not a blip: retrying a 401 or 400 only hides it.
      if (response.status >= 400 && response.status < 500) {
        throw Object.assign(new Error(`${method} ${url} -> ${response.status}: ${text}`), {
          final: true,
          status: response.status,
        });
      }
      if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}: ${text}`);
      return JSON.parse(text);
    } catch (error) {
      if (error.final) throw error;
      last = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw last;
}
