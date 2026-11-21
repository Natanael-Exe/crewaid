// downloads.crewaid.io: the desktop installers and their update feeds (D-153).
//
// A Worker in front of the `crewaid-downloads` R2 bucket rather than a public
// bucket, for two reasons. The release workflow uploads through it with one
// bearer secret, so CI holds no Cloudflare API token — and a token able to
// write R2 is a token able to write every bucket on the account. And it can
// answer "the newest installer" itself, so the landing page links to a URL
// that never changes and needs no server of its own.
//
// Layout, one folder per edition (D-152), flat because every file name carries
// its version:
//   desktop/<edition>/latest-mac.yml, latest.yml, latest-linux.yml  update feeds (electron-updater, generic provider)
//   desktop/<edition>/Crewaid-<v>-mac-arm64.dmg  … and the -x64 .dmg, the .zip, .exe, .deb and .blockmap files they list
//
// Routes:
//   GET  /desktop/<edition>/mac-arm64 | mac-intel | windows | linux   302 to the installer the current feed names
//   GET  /desktop/<edition>/mac              the Apple silicon installer, for links made before the split
//   GET  /desktop/<edition>/<file>           the file; HEAD and Range work (differential updates use Range)
//   GET  /install.sh                         the self-hosted installer (D-155), from selfhost/install.sh
//   PUT  /desktop/<edition>/<file>           upload in one request (up to the zone's 100 MB body limit)
//   POST /desktop/<edition>/<file>?uploads   start a multipart upload -> {uploadId}
//   PUT  …?uploadId=<id>&partNumber=<n>      one part (equal sizes, all but the last) -> {partNumber, etag}
//   POST …?uploadId=<id>                     {parts: [{partNumber, etag}]} -> completes the file
// Every upload route requires `Authorization: Bearer <UPLOAD_SECRET>`.
// A feed (latest*.yml) goes up in one request and is refused (409) when it is
// older than the feed already published, so a re-run of an old release can
// never roll every app's updates back. Publishing a feed also deletes the
// edition's installers older than its KEEP_VERSIONS newest releases.
//
// Multipart because Cloudflare refuses request bodies over 100 MB at the edge,
// before the Worker runs, and a macOS installer is about 125 MB.

const EDITION = '(cloud|selfhosted)';
const LATEST = new RegExp(`^desktop/${EDITION}/(mac|mac-arm64|mac-intel|windows|linux)$`);
const FILE = new RegExp(`^desktop/${EDITION}/[A-Za-z0-9][A-Za-z0-9._-]*$`);
// D-155: the self-hosted installer shim, served at /install.sh and replaced by
// each release. The one file outside desktop/.
const INSTALLER = 'selfhost/install.sh';
const FEED = /\/latest(-mac|-linux)?\.yml$/;
// How many releases each edition's folder keeps; older installers are deleted
// when a newer feed is published.
const KEEP_VERSIONS = 5;
// The version in an installer's name, as electron-builder's artifactName writes
// it: Crewaid[-SelfHosted]-<version>-<os>-<arch>.<ext>[.blockmap].
const ARTIFACT_VERSION =
  /^Crewaid(?:-SelfHosted)?-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(?:mac|win|linux)-/;

/** The feed each platform's installer is listed in, and how to recognise the installer in it. */
const PLATFORMS = {
  mac: { feed: 'latest-mac.yml', installer: /-arm64\.dmg$/ },
  'mac-arm64': { feed: 'latest-mac.yml', installer: /-arm64\.dmg$/ },
  'mac-intel': { feed: 'latest-mac.yml', installer: /-x64\.dmg$/ },
  windows: { feed: 'latest.yml', installer: /\.exe$/ },
  linux: { feed: 'latest-linux.yml', installer: /\.deb$/ },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let key;
    try {
      key = decodeURIComponent(url.pathname.slice(1));
    } catch {
      return text(400, 'Bad path');
    }

    if (request.method === 'PUT' || request.method === 'POST')
      return upload(request, env, key, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text(405, 'Method not allowed', { allow: 'GET, HEAD, PUT, POST' });
    }

    const latest = LATEST.exec(key);
    if (latest) return redirectToLatest(env, url, latest[1], latest[2]);
    if (key === 'install.sh') return serve(request, env, INSTALLER);
    if (!FILE.test(key)) return text(404, 'Not found');
    return serve(request, env, key);
  },
};

/**
 * Send the visitor to the installer the edition's current feed names.
 *
 * Read from the feed rather than from a "latest" copy of the installer, so the
 * download button and the in-app updater can never disagree about which
 * version is current: they read the same file.
 */
async function redirectToLatest(env, url, edition, platform) {
  const { feed, installer } = PLATFORMS[platform];
  const object = await env.DOWNLOADS.get(`desktop/${edition}/${feed}`);
  if (object === null) return text(404, 'No release has been published yet.');
  const files = feedFiles(await object.text());
  // A feed published before the per-chip split lists one universal .dmg.
  const file =
    files.find((name) => installer.test(name)) ??
    (platform.startsWith('mac') ? files.find((name) => /\.dmg$/.test(name)) : undefined);
  if (file === undefined)
    return text(404, 'The current release has no installer for this platform.');
  return new Response(null, {
    status: 302,
    headers: {
      location: new URL(`/desktop/${edition}/${encodeURIComponent(file)}`, url).toString(),
      // The target moves with every release; a cached redirect would keep
      // handing out the old one.
      'cache-control': 'no-store',
    },
  });
}

/**
 * The file names an electron-builder feed lists (`files[].url`, plus `path`).
 * Line-based rather than a YAML parser: the format is electron-builder's own,
 * flat, and only these keys are read.
 */
function feedFiles(yaml) {
  const names = [];
  for (const line of yaml.split('\n')) {
    const match = /^\s*(?:-\s*)?(?:url|path):\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

async function serve(request, env, key) {
  const head = request.method === 'HEAD';
  const object = head
    ? await env.DOWNLOADS.head(key)
    : await env.DOWNLOADS.get(key, { range: request.headers, onlyIf: request.headers });
  if (object === null) return text(404, 'Not found');

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  // Feeds and the installer change with every release and must be re-read;
  // everything else is named by version and never changes once uploaded.
  headers.set(
    'cache-control',
    FEED.test(key) || key === INSTALLER ? 'no-cache' : 'public, max-age=31536000, immutable',
  );

  if (head) {
    headers.set('content-length', String(object.size));
    return new Response(null, { status: 200, headers });
  }
  // A failed precondition (If-None-Match and friends) leaves no body.
  if (!('body' in object)) return new Response(null, { status: 304, headers });

  const range = rangeOf(object);
  if (range === null) {
    headers.set('content-length', String(object.size));
    return new Response(object.body, { status: 200, headers });
  }
  headers.set('content-range', `bytes ${range.start}-${range.end}/${object.size}`);
  headers.set('content-length', String(range.end - range.start + 1));
  return new Response(object.body, { status: 206, headers });
}

/** The byte span R2 served, normalised from its three shapes, or null for the whole file. */
function rangeOf(object) {
  const range = object.range;
  if (range === undefined) return null;
  // R2 reports every field of the range, the unused ones as undefined, so the
  // shape is told apart by which fields are numbers rather than which exist.
  if (typeof range.suffix === 'number') {
    const start = Math.max(0, object.size - range.suffix);
    return { start, end: object.size - 1 };
  }
  const start = typeof range.offset === 'number' ? range.offset : 0;
  const length = typeof range.length === 'number' ? range.length : object.size - start;
  if (start === 0 && length === object.size) return null;
  return { start, end: start + length - 1 };
}

async function upload(request, env, key, url) {
  if (!(await authorized(request, env))) return text(401, 'Unauthorized');
  if (!FILE.test(key) && key !== INSTALLER) {
    return text(400, `Uploads go to desktop/<cloud|selfhosted>/<file> or ${INSTALLER}`);
  }
  const params = url.searchParams;
  const httpMetadata = { contentType: contentTypeOf(key) };

  if (FEED.test(key)) {
    if (request.method !== 'PUT' || params.has('uploads') || params.has('uploadId')) {
      return text(400, 'A feed is uploaded in one PUT');
    }
    return putFeed(request, env, key, httpMetadata);
  }

  if (request.method === 'POST' && params.has('uploads')) {
    const multipart = await env.DOWNLOADS.createMultipartUpload(key, { httpMetadata });
    return Response.json({ uploadId: multipart.uploadId });
  }

  const uploadId = params.get('uploadId');
  if (uploadId !== null) {
    const multipart = env.DOWNLOADS.resumeMultipartUpload(key, uploadId);
    if (request.method === 'PUT') {
      const partNumber = Number(params.get('partNumber'));
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
        return text(400, 'partNumber must be 1–10000');
      }
      if (request.body === null) return text(400, 'Empty part');
      return Response.json(await multipart.uploadPart(partNumber, request.body));
    }
    const body = await request.json().catch(() => null);
    if (body === null || !Array.isArray(body.parts) || body.parts.length === 0) {
      return text(400, 'Completing needs {parts: [{partNumber, etag}]}');
    }
    const object = await multipart.complete(body.parts);
    return Response.json({ key: object.key, size: object.size });
  }

  if (request.method !== 'PUT') return text(400, 'POST needs ?uploads or ?uploadId');
  if (request.body === null) return text(400, 'Empty body');
  const object = await env.DOWNLOADS.put(key, request.body, { httpMetadata });
  return Response.json({ key: object.key, size: object.size });
}

/**
 * Publish a feed unless a newer one is already there.
 *
 * Conditional on the stored feed's etag, so a feed replaced between the read
 * and the write is not overwritten either: the release workflow publishes one
 * tag at a time, and this holds even if something else does not.
 */
async function putFeed(request, env, key, httpMetadata) {
  const body = await request.text();
  const incoming = feedVersion(body);
  if (incoming === null) return text(400, 'A feed needs a semver `version:` line');

  const current = await env.DOWNLOADS.get(key);
  let onlyIf;
  if (current !== null) {
    const published = feedVersion(await current.text());
    if (published !== null && compareVersions(incoming, published) < 0) {
      return text(409, `${key} is already at ${published.raw}; refusing the older ${incoming.raw}`);
    }
    onlyIf = { etagMatches: current.etag };
  }
  const object = await env.DOWNLOADS.put(key, body, {
    httpMetadata,
    ...(onlyIf ? { onlyIf } : {}),
  });
  if (object === null) return text(409, `${key} changed while publishing; run the publish again`);
  const pruned = await prune(env, key.slice(0, key.lastIndexOf('/') + 1));
  return Response.json({ key: object.key, size: object.size, pruned });
}

/**
 * Delete every installer, zip and blockmap in an edition's folder that is not
 * one of its KEEP_VERSIONS newest versions, so the bucket does not grow by a
 * release's worth of files forever.
 *
 * Run after a feed is published because that is when a version becomes
 * current, and only then: a feed older than the one it replaces is refused, so
 * the release being published is the newest and is always kept. Feeds and
 * anything whose name carries no version are left alone.
 */
async function prune(env, prefix) {
  const files = [];
  let cursor;
  do {
    const page = await env.DOWNLOADS.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) {
      const version = ARTIFACT_VERSION.exec(object.key.slice(prefix.length));
      if (version) files.push({ key: object.key, version: parseVersion(version[1]) });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const versions = [];
  for (const { version } of files) {
    if (version !== null && !versions.some((v) => v.raw === version.raw)) versions.push(version);
  }
  versions.sort((a, b) => compareVersions(b, a));
  const kept = new Set(versions.slice(0, KEEP_VERSIONS).map((v) => v.raw));
  const doomed = files
    .filter(({ version }) => version !== null && !kept.has(version.raw))
    .map(({ key }) => key);
  // R2 deletes up to 1000 keys per call.
  for (let i = 0; i < doomed.length; i += 1000)
    await env.DOWNLOADS.delete(doomed.slice(i, i + 1000));
  return doomed;
}

function feedVersion(yaml) {
  const line = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(yaml);
  return line === null ? null : parseVersion(line[1]);
}

function parseVersion(raw) {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(raw);
  if (parts === null) return null;
  return {
    raw,
    core: [Number(parts[1]), Number(parts[2]), Number(parts[3])],
    pre: parts[4] === undefined ? [] : parts[4].split('.'),
  };
}

/** Semver precedence: core numbers, then a release outranks its prereleases. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Constant-time, over digests so the two sides are always the same length. */
async function authorized(request, env) {
  const secret = env.UPLOAD_SECRET;
  if (typeof secret !== 'string' || secret === '') return false;
  const header = request.headers.get('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function contentTypeOf(key) {
  if (key.endsWith('.yml')) return 'text/yaml; charset=utf-8';
  if (key.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (key.endsWith('.zip')) return 'application/zip';
  if (key.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (key.endsWith('.deb')) return 'application/vnd.debian.binary-package';
  if (key.endsWith('.sh')) return 'text/x-shellscript; charset=utf-8';
  return 'application/octet-stream';
}

function text(status, body, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}
