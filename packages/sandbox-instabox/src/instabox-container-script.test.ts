import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildEnsureContainerCommand } from './instabox-container-script.js';

/**
 * Runs the real `ensureContainer` shell program against a stand-in `docker`
 * that keeps its state in files: what the container runs, which images are on
 * the VM, and what the registry's tag points at. The decisions that matter
 * (pull or not, replace or keep) are made by the script itself, so this is
 * where they are proven.
 */
const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
set -u
S="$FAKE_STATE"
key() { printf '%s' "$1" | tr '/:@' '___'; }
echo "$*" >> "$S/calls"
case "$1" in
  inspect)
    [ -f "$S/container_state" ] || exit 1
    case "$3" in
      '{{.State.Status}}') cat "$S/container_state" ;;
      '{{.Image}}') cat "$S/container_image_id" ;;
      '{{.Config.Image}}') cat "$S/container_image_ref" ;;
      *) exit 1 ;;
    esac ;;
  image)
    case "$2" in
      prune) exit 0 ;;
      inspect)
        for ref in "$@"; do :; done # the last argument
        [ -f "$S/images/$(key "$ref")" ] || exit 1
        [ "$3" = "-f" ] && cat "$S/images/$(key "$ref")"
        exit 0 ;;
    esac ;;
  pull)
    for ref in "$@"; do :; done # the last argument
    if [ -f "$S/pull_fails" ]; then echo "registry unreachable" >&2; exit 1; fi
    cp "$S/registry/$(key "$ref")" "$S/images/$(key "$ref")" ;;
  start) echo running > "$S/container_state" ;;
  stop) echo exited > "$S/container_state" ;;
  rm) rm -f "$S/container_state" "$S/container_image_id" "$S/container_image_ref" ;;
  run)
    for ref in "$@"; do :; done # the last argument
    echo running > "$S/container_state"
    cat "$S/images/$(key "$ref")" > "$S/container_image_id"
    printf '%s' "$ref" > "$S/container_image_ref" ;;
esac
`;

// `timeout` is GNU coreutils (present in the VM); a pass-through keeps the test portable.
const FAKE_TIMEOUT = '#!/usr/bin/env bash\nshift\nexec "$@"\n';

const OLD = 'ghcr.io/natanael-exe/crewaid-sandbox:0.1.4';
const LATEST = 'ghcr.io/natanael-exe/crewaid-sandbox:latest';

interface World {
  readonly container?: { state: 'running' | 'exited'; imageId: string; ref: string };
  readonly local?: Record<string, string>;
  readonly registry?: Record<string, string>;
  readonly pullFails?: boolean;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const key = (ref: string): string => ref.replace(/[/:@]/g, '_');

function run(world: World, image: string, mode: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'crewaid-ensure-'));
  dirs.push(root);
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  for (const dir of [bin, state, path.join(state, 'images'), path.join(state, 'registry')]) {
    spawnSync('mkdir', ['-p', dir]);
  }
  writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER);
  writeFileSync(path.join(bin, 'timeout'), FAKE_TIMEOUT);
  chmodSync(path.join(bin, 'docker'), 0o755);
  chmodSync(path.join(bin, 'timeout'), 0o755);
  if (world.container !== undefined) {
    writeFileSync(path.join(state, 'container_state'), world.container.state);
    writeFileSync(path.join(state, 'container_image_id'), world.container.imageId);
    writeFileSync(path.join(state, 'container_image_ref'), world.container.ref);
  }
  for (const [ref, id] of Object.entries(world.local ?? {})) {
    writeFileSync(path.join(state, 'images', key(ref)), id);
  }
  for (const [ref, id] of Object.entries(world.registry ?? {})) {
    writeFileSync(path.join(state, 'registry', key(ref)), id);
  }
  if (world.pullFails === true) writeFileSync(path.join(state, 'pull_fails'), '');

  const result = spawnSync('bash', ['-c', buildEnsureContainerCommand()], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      FAKE_STATE: state,
      CREWAID_IMAGE: image,
      CREWAID_CONTAINER_MEM_MIB: '6656',
      CREWAID_ENSURE_MODE: mode,
    },
  });
  const calls = existsSync(path.join(state, 'calls'))
    ? readFileSync(path.join(state, 'calls'), 'utf8').trim().split('\n')
    : [];
  const marker = /CREWAID_ENSURE_JSON=(\{.*\})/.exec(result.stdout)?.[1];
  return {
    status: result.status,
    stderr: result.stderr,
    outcome: marker === undefined ? null : (JSON.parse(marker) as Record<string, unknown>),
    pulled: calls.some((c) => c.startsWith('pull')),
    replaced: calls.some((c) => c.startsWith('run')),
    started: calls.some((c) => c.startsWith('start')),
  };
}

describe('ensureContainer shell program', () => {
  it('follow: a moved tag (same name, new image) replaces the container', () => {
    const r = run(
      {
        container: { state: 'running', imageId: 'sha256:r1', ref: LATEST },
        local: { [LATEST]: 'sha256:r1' },
        registry: { [LATEST]: 'sha256:r2' },
      },
      LATEST,
      'follow',
    );
    expect(r.status).toBe(0);
    expect(r.pulled).toBe(true);
    expect(r.replaced).toBe(true);
    expect(r.outcome).toEqual({ imageId: 'sha256:r2', recreated: true, skippedUpgrade: '' });
  });

  it('follow: an unchanged tag keeps the live container', () => {
    const r = run(
      {
        container: { state: 'running', imageId: 'sha256:r1', ref: LATEST },
        local: { [LATEST]: 'sha256:r1' },
        registry: { [LATEST]: 'sha256:r1' },
      },
      LATEST,
      'follow',
    );
    expect(r.status).toBe(0);
    expect(r.pulled).toBe(true);
    expect(r.replaced).toBe(false);
    expect(r.outcome).toEqual({ imageId: 'sha256:r1', recreated: false, skippedUpgrade: '' });
  });

  it('follow: an unreachable registry keeps and starts the current container', () => {
    const r = run(
      {
        container: { state: 'exited', imageId: 'sha256:r1', ref: LATEST },
        local: { [LATEST]: 'sha256:r1' },
        pullFails: true,
      },
      LATEST,
      'follow',
    );
    expect(r.status).toBe(0);
    expect(r.replaced).toBe(false);
    expect(r.started).toBe(true);
    expect(r.stderr).toContain('keeping the current image');
    expect(r.outcome).toEqual({ imageId: 'sha256:r1', recreated: false, skippedUpgrade: 'pull' });
  });

  it('keep: never pulls or replaces, even when another image is configured', () => {
    const r = run(
      {
        container: { state: 'exited', imageId: 'sha256:old', ref: OLD },
        local: { [OLD]: 'sha256:old' },
        registry: { [LATEST]: 'sha256:new' },
      },
      LATEST,
      'keep',
    );
    expect(r.status).toBe(0);
    expect(r.pulled).toBe(false);
    expect(r.replaced).toBe(false);
    expect(r.started).toBe(true);
    expect(r.outcome).toEqual({ imageId: 'sha256:old', recreated: false, skippedUpgrade: '' });
  });

  it('ensure: keeps a container started from the configured name without pulling', () => {
    const r = run(
      {
        container: { state: 'running', imageId: 'sha256:r1', ref: LATEST },
        local: { [LATEST]: 'sha256:r1' },
        registry: { [LATEST]: 'sha256:r2' },
      },
      LATEST,
      'ensure',
    );
    expect(r.pulled).toBe(false);
    expect(r.replaced).toBe(false);
  });

  it('ensure: a first create whose pull fails reports the failure', () => {
    const r = run({ pullFails: true }, LATEST, 'ensure');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('registry unreachable');
    expect(r.replaced).toBe(false);
  });
});
