/**
 * Customer computers on Runtime (withruntime.com) sandboxes.
 *
 * Satisfies the orchestrator's `SandboxProvider` contract with one Firecracker
 * microVM per computer, using what Runtime already does rather than building
 * it again:
 *
 * - A computer is ONE sandbox, named `crewaid-<id>` and labelled
 * `crewaid=computer`, booted from the image Runtime built from our
 * Dockerfile (`SANDBOX_RUNTIME_IMAGE`). That image's start command is the
 * entrypoint, and its ready check is the bridge's port, so a create
 * answers once the desktop is up.
 * - The sandbox's disk IS the workspace. Every path that removes a runtime
 * under Docker — `stop`, `destroy`, orphan cleanup — PAUSES here, and only
 * retention's `deleted` outcome deletes a sandbox. A pause keeps memory and
 * processes, so a logged-in browser is still logged in after a wake, and a
 * wake takes well under a second.
 * - The workspace's history lives in the sandbox's own labels: when it first
 * started, and when it was first seen orphaned. Labels are read and written
 * through the API, so neither the workspace sweep nor retention ever wakes
 * a paused machine to ask, and the record goes wherever the sandbox goes.
 * - Ports reach the orchestrator as loopback listeners over the SDK's
 * tunnel: one WebSocket authenticated by the API key, carrying TCP to the
 * sandbox's own loopback. No port is opened to the internet, which matters
 * because the bridge has no authentication of its own. Commands and file
 * I/O go through the bridge's `/exec` over that tunnel.
 * - Runtime runs the start command on create and after an image switch
 * ONLY: a restart from disk (after Runtime stopped a sandbox itself)
 * comes up with no desktop, and a desktop that died before a pause is
 * still dead after the wake. Either way the bridge is silent, and the
 * image's own launcher,
 * `crewaid-desktop-up`, runs through Runtime's exec as root (`sudo`, which
 * Runtime gives the sandbox user). It is idempotent, and the entrypoint
 * clears the X lock a previous boot left in `/tmp`.
 * - Runtime's own idle pause is off and a paused sandbox is kept while the
 * account has credit: the orchestrator decides when a computer pauses
 * (WORKSPACE.md §8), and only retention decides when one is deleted.
 * - A computer follows the configured image. `SANDBOX_RUNTIME_IMAGE`
 * may name a tag a release moves, such as `crewaid-sandbox:latest`, and a
 * computer that starts from paused or stopped on an older version is
 * switched to it. Runtime keeps only `/workspace` across a switch, so the
 * image's start command keeps the home there, bound over `/home/bot`, and
 * a computer from before that has its home copied there first.
 */

import {
  ContainerSandboxSession,
  HARNESS_SANDBOX_SPECIFICATION_VERSION,
  HarnessError,
  HarnessSandboxAuthenticationError,
  SANDBOX_PORTS,
  SEAT_CDP_PORTS,
  SEAT_PORTS,
  bridgeExec,
  type ContainerExecSpec,
  type ContainerPortBinding,
  type ContainerProcess,
  type ComputerSnapshotObservation,
  type ComputerSnapshots,
  type ContainerStatus,
  type HarnessV1CreateSessionOptions,
  type HarnessV1ResumeSessionOptions,
  type HarnessV1SandboxProvider,
  type ManagedSandboxObservation,
  type SandboxContainer,
  type SandboxHealth,
  type WorkspaceObservation,
} from '@crewaid/sandbox-core';

import {
  RuntimeApiError,
  SdkRuntimeApi,
  type RuntimeApi,
  type RuntimeImage,
  type RuntimeMachine,
  type RuntimeMachineState,
  type RuntimeSharedPort,
  type RuntimeSnapshot,
  type RuntimeTunnel,
} from './runtime-client.js';

import { RuntimeImageMigration } from './runtime-image-migration.js';
import {
  COMPUTER_LABEL,
  COMPUTER_NAME_PREFIX,
  FIRST_START_LABEL,
  IMAGE_LABEL,
  IMAGE_REFUSED_LABEL,
  IMAGE_REFUSED_REASON_LABEL,
  ORPHANED_AT_LABEL,
  SNAPSHOT_ROLE,
  UPGRADE_COMPUTER_LABEL,
  UPGRADE_STAGE_ROLE,
  pendingSnapshotNameFor,
  sandboxNameFor,
  snapshotNameFor,
} from './runtime-labels.js';
export * from './runtime-labels.js';

/**
 * The start command an image must have for a computer to be switched to it:
 * it binds the home kept in `/workspace` over `/home/bot` before the desktop
 * starts. An image without it would come up on an empty home, so a computer
 * is never switched to one. `scripts/build-image.mjs` gives every image it.
 */
export const RUNTIME_START_COMMAND = '/usr/local/bin/crewaid-runtime-start';

/** What Runtime answers when it will not switch a sandbox; the sandbox stays as it was. */
const SWITCH_REFUSALS: ReadonlySet<string> = new Set([
  'switch_undone',
  'image_on_another_host',
  'disk_too_small',
  'image_unchanged',
  'switch_needs_disk',
]);

/**
 * Run as root before a switch. Chrome is closed first so its profiles are
 * consistent on disk. A home still on the image's disk, which the switch
 * discards, is copied into `/workspace`, which it keeps; one already bound
 * there is left alone. Then the disk is flushed, because the switch copies
 * `/workspace` from the disk while the machine is paused.
 */
const PREPARE_SWITCH = [
  'set -eu',
  'pkill -TERM -u bot -x chrome 2>/dev/null || true',
  'i=0; while pgrep -u bot -x chrome >/dev/null 2>&1 && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i+1)); done',
  'home=/home/bot; kept=/workspace/.crewaid-home',
  'if ! mountpoint -q "$home"; then',
  '  rm -rf "$kept.next"; mkdir -p "$kept.next"',
  '  cp -a "$home/." "$kept.next/"',
  '  chown bot:bot "$kept.next"',
  '  rm -rf "$kept"; mv "$kept.next" "$kept"',
  '  echo copied',
  'fi',
  'sync',
].join('\n');

/**
 * Run as the machine's user on a restored machine: every browser profile it
 * holds, as JSON. A seat directory is a profile; under the legacy `.chrome`
 * layout only a directory with Preferences is one, the rest are Chrome's caches.
 */
const LIST_PROFILES = [
  'import json, re',
  'from pathlib import Path',
  "home = Path('/home/bot')",
  "safe = re.compile(r'[A-Za-z0-9_-]{1,64}')",
  'names = set()',
  "for root, needs_prefs in ((home / '.seats', False), (home / '.chrome', True)):",
  '    if not root.is_dir() or root.is_symlink():',
  '        continue',
  '    for entry in root.iterdir():',
  '        if entry.is_symlink() or not entry.is_dir():',
  '            continue',
  "        if needs_prefs and not (entry / 'Preferences').is_file():",
  '            continue',
  '        names.add(entry.name)',
  "print(json.dumps(sorted(n for n in names if n != 'Default' and safe.fullmatch(n))))",
].join('\n');

/** Every port a machine serves; each gets a loopback listener while it runs. */
const MACHINE_PORTS: readonly number[] = [
  SANDBOX_PORTS.rfb,
  SANDBOX_PORTS.cdp,
  SANDBOX_PORTS.bridge,
  ...SEAT_PORTS,
  ...SEAT_CDP_PORTS,
];

/** The image's entrypoint draws this screen; a per-sandbox setting cannot change it. */
const SCREEN = Object.freeze({ widthPx: 1280, heightPx: 800 });

/**
 * How long a screen preview's token admits NEW connections. An open connection
 * outlives it, and one token admits any number of connections until then
 * (both measured on Runtime 2026-10-14), so a token is shared by the grants
 * made while it lasts rather than minted per grant. It opens nothing on its
 * own — the gateway behind it still wants a one-use ticket — and stop deletes
 * the preview, so its length decides how often a grant pays for a new one,
 * not how long a stale link could wake a computer.
 */
export const SCREEN_ACCESS_TTL_SECONDS = 600;

/**
 * The least life a reused screen token must have left: a grant's ticket lasts
 * a minute, and the token must still admit the connection that ticket opens.
 */
const SCREEN_ACCESS_REUSE_MIN_MS = 60_000;

/** What a restore's staged machine is named; see `RuntimeImageMigration.restore`. */
const RESTORE_STAGE_PREFIX = 'crewaid-restore-';

/** How long a sandbox's state is reused. `getPortEndpoint` inspects on every call. */
const STATUS_TTL_MS = 1_000;

/** States a sandbox passes through on its own; waiting on one ends in another. */
const TRANSITIONAL: ReadonlySet<RuntimeMachineState> = new Set([
  'starting',
  'resuming',
  'pausing',
  'stopping',
]);

export interface RuntimeSandboxProviderOptions {
  /** Seam for tests; defaults to the SDK with the key from the environment. */
  readonly api?: RuntimeApi;
  /** The image Runtime built from the sandbox Dockerfile (`SANDBOX_RUNTIME_IMAGE`). */
  readonly image: string;
  readonly vcpu?: number;
  readonly memoryMiB?: number;
  readonly diskMiB?: number;
  /** How long a start has to become usable, launching the desktop included. */
  readonly readyTimeoutMs?: number;
  /** How long to wait for the desktop after launching it before launching again. */
  readonly relaunchMs?: number;
  /** Seam for tests: resolves true when the bridge at `baseUrl` is healthy. */
  readonly bridgeProbe?: (baseUrl: string) => Promise<boolean>;
  /** Where a computer that stays on its image says why; it starts either way. */
  readonly log?: (message: string) => void;
}

export class RuntimeSandboxProvider implements HarnessV1SandboxProvider {
  readonly workspaceOnFirstStart = true;
  readonly specificationVersion = HARNESS_SANDBOX_SPECIFICATION_VERSION;
  readonly providerId = 'crewaid-runtime';

  readonly #api: RuntimeApi;
  readonly #image: string;
  readonly #migration: RuntimeImageMigration;
  readonly #vcpu: number;
  readonly #memoryMiB: number;
  readonly #diskMiB: number;
  readonly #readyTimeoutMs: number;
  readonly #relaunchMs: number;
  readonly #bridgeProbe: (baseUrl: string) => Promise<boolean>;
  readonly #log: (message: string) => void;
  /** One container object per sandbox, so its tunnel is shared. */
  readonly #containers = new Map<string, RuntimeContainer>();

  constructor(options: RuntimeSandboxProviderOptions) {
    this.#api = options.api ?? new SdkRuntimeApi();
    this.#image = options.image;
    this.#vcpu = options.vcpu ?? 4;
    this.#memoryMiB = options.memoryMiB ?? 8192;
    this.#diskMiB = options.diskMiB ?? 20_480;
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 180_000;
    this.#relaunchMs = options.relaunchMs ?? 20_000;
    this.#bridgeProbe = options.bridgeProbe ?? probeBridgeOverHttp;
    this.#log = options.log ?? ((message) => console.warn(message));
    this.#migration = new RuntimeImageMigration(
      this.#api,
      async (machine, computerId, signal) => {
        const container = this.#containerFor(machine.id);
        await container.start();
        await this.#awaitUsable(
          this.#sessionOver(computerId, container),
          container,
          computerId,
          signal,
        );
      },
      this.#log,
    );
  }

  // sessions

  createSession = async (
    options?: HarnessV1CreateSessionOptions & {
      requireExistingWorkspace?: boolean;
      /** The profiles to keep should the computer come back from its snapshot. */
      snapshotProfiles?: () => Promise<readonly string[]>;
    },
  ): Promise<ContainerSandboxSession> =>
    this.#mapped(async () => {
      options?.abortSignal?.throwIfAborted();
      const sessionId = options?.sessionId ?? crypto.randomUUID();
      // One resource is both runtime and workspace here, so it can only be
      // keyed one way. The orchestrator passes the same string for both today;
      // if they ever diverge this refuses rather than filing a computer's
      // files under a name nothing looks for.
      if (options?.identity !== undefined && options.identity !== sessionId) {
        throw new HarnessError({
          message:
            `sandbox ${sessionId}: the Runtime provider keys a computer's runtime and ` +
            `workspace by one name, but was asked for identity ${options.identity}.`,
        });
      }
      const existing = await this.#api.findByName(sandboxNameFor(sessionId));
      if (existing !== null) {
        throw new HarnessError({
          message:
            `sandbox ${sessionId} already exists as Runtime sandbox ${existing.id}. ` +
            'Use resumeSession() to reattach.',
        });
      }
      if (options?.requireExistingWorkspace === true) {
        // D-237 amends D-031: a snapshot the person saved is their workspace,
        // not an empty replacement, so a computer whose machine is gone comes
        // back from it.
        const snapshot = await this.#readySnapshot(sessionId);
        if (snapshot !== null) {
          return await this.#recreateFromSnapshot(sessionId, snapshot, options);
        }
        throw new HarnessError({
          message:
            `sandbox ${sessionId}: its workspace is missing. On Runtime the workspace is ` +
            'the sandbox, and none exists; storage is not recreated automatically (D-031).',
        });
      }

      const created = await this.#createMachine(sandboxNameFor(sessionId), {
        [FIRST_START_LABEL]: String(Date.now()),
      });
      const container = this.#containerFor(created.id);
      try {
        const session = this.#sessionOver(sessionId, container);
        await this.#awaitUsable(session, container, sessionId, options?.abortSignal);
        if (options?.onFirstCreate !== undefined) {
          await options.onFirstCreate(session.restricted(), {
            ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
          });
        }
        return session;
      } catch (error) {
        // Nothing escaped to the caller, and a fresh sandbox holds no files yet.
        await container.close();
        this.#containers.delete(created.id);
        if (!options?.abortSignal?.aborted)
          await this.#api.delete(created.id).catch(() => undefined);
        throw error;
      }
    });

  resumeSession = async (
    options: HarnessV1ResumeSessionOptions & { ensureWorkspaceRetention?: boolean },
  ): Promise<ContainerSandboxSession> =>
    this.#mapped(async () => {
      const { sessionId } = options;
      const found = await this.#migration.find(sessionId);
      if (found === null) {
        throw new HarnessError({
          message: `sandbox ${sessionId}: no Runtime sandbox is named ${sandboxNameFor(sessionId)}`,
        });
      }
      // A crash between creation and retention setup leaves a named machine to adopt.
      if (options.ensureWorkspaceRetention) await this.#api.keepWhilePaused(found.id);
      // Older workspaces were provisioned before their first admitted start.
      const labels: Record<string, string> = { ...found.labels, [ORPHANED_AT_LABEL]: 'none' };
      if (parseTime(found.labels[FIRST_START_LABEL]) === null) {
        labels[FIRST_START_LABEL] = String(Date.now());
      }
      if (!sameLabels(labels, found.labels)) await this.#api.setLabels(found.id, labels);

      let machine: RuntimeMachine = { ...found, labels };
      if (machine.labels[COMPUTER_LABEL.key] === UPGRADE_STAGE_ROLE) {
        machine = await this.#migration.promote(machine, sessionId, options.abortSignal);
      }
      const follow =
        found.state !== 'running' && found.labels[COMPUTER_LABEL.key] !== UPGRADE_STAGE_ROLE;
      const target = follow ? await this.#targetImage() : null;
      options.abortSignal?.throwIfAborted();
      let container = this.#containerFor(machine.id);
      try {
        await container.start();
        // Never under a computer already running: a bot may be mid-task on it.
        if (target !== null) {
          machine = await this.#followImage(
            machine,
            container,
            sessionId,
            target,
            options.abortSignal,
          );
          container = this.#containerFor(machine.id);
          await container.start();
        }
        const session = this.#sessionOver(sessionId, container);
        await this.#awaitUsable(session, container, sessionId, options.abortSignal);
        return session;
      } catch (error) {
        if (found.state !== 'running' && !options.abortSignal?.aborted) {
          // A switch may have moved the workspace to another machine. A failed
          // pause is logged, never thrown: the wake's failure is what the
          // caller records, and the orchestrator retries the pause itself.
          try {
            const current = await this.#migration.find(sessionId);
            if (current !== null) await this.#containerFor(current.id).stop();
          } catch (cleanup: unknown) {
            const detail = cleanup instanceof Error ? cleanup.message : String(cleanup);
            this.#log(`sandbox ${sessionId}: could not pause after a failed wake: ${detail}`);
          }
        }
        throw error;
      }
    });

  /** A handle without starting or waiting — for stop, destroy and inspect. */
  attachSession = async (options: { sessionId: string }): Promise<ContainerSandboxSession | null> =>
    this.#mapped(async () => {
      const found = await this.#migration.find(options.sessionId);
      if (found === null) return null;
      return this.#sessionOver(options.sessionId, this.#containerFor(found.id));
    });

  /** Total, like Docker's: every machine-level fault is an answer, only an API failure throws. */
  checkHealth = async (options: { sessionId: string }): Promise<SandboxHealth> =>
    this.#mapped(async () => {
      const found = await this.#migration.find(options.sessionId);
      if (found === null) {
        return unwell(`no Runtime sandbox is named ${sandboxNameFor(options.sessionId)}`);
      }
      if (found.state !== 'running') {
        return unwell(`sandbox ${found.id} is ${found.state}`);
      }
      const bridge = await this.#containerFor(found.id).endpoint(SANDBOX_PORTS.bridge);
      if (!(await this.#bridgeProbe(`http://${bridge.host}:${bridge.port}`))) {
        return unwell(`the agent-bridge in sandbox ${found.id} did not report healthy`);
      }
      return { ok: true };
    });

  /**
   * A private address for a port of a running computer, for a viewer
   * to reach directly. The computer's state is read from Runtime on every
   * call, and access is refused unless it is running: a preview visit would
   * wake a paused one. The share itself is reused while its token lasts (see
   * `RuntimeContainer.shareScreenPort`), so a grant costs this one lookup.
   */
  screenAccess = async (options: {
    sessionId: string;
    port: number;
  }): Promise<{ url: string; expiresAt: number }> =>
    this.#mapped(async () => {
      const found = await this.#migration.find(options.sessionId);
      if (found === null || found.state !== 'running') {
        throw new HarnessError({ message: `sandbox ${options.sessionId} is not running` });
      }
      const shared = await this.#containerFor(found.id).shareScreenPort(options.port);
      const url = new URL(shared.urlWithToken);
      url.protocol = 'wss:';
      return { url: url.toString(), expiresAt: shared.tokenExpiresAt };
    });

  // snapshots

  readonly snapshots: ComputerSnapshots = {
    inspect: (options) =>
      this.#mapped(async (): Promise<ComputerSnapshotObservation> => {
        const { current, pending } = await this.#finishReplacement(options.computerId);
        const stages = await this.#api.list({
          [COMPUTER_LABEL.key]: UPGRADE_STAGE_ROLE,
          [UPGRADE_COMPUTER_LABEL]: options.computerId,
        });
        return {
          snapshot:
            current === null
              ? null
              : {
                  takenAt: current.createdAt,
                  sizeBytes: current.sizeBytes,
                  expiresAt: current.expiresAt,
                },
          saving: snapshotInProgress(pending),
          restoring: stages.some((stage) => (stage.name ?? '').startsWith(RESTORE_STAGE_PREFIX)),
          lastError:
            pending !== null && (pending.state === 'failed' || pending.backupFailed)
              ? (pending.error ?? 'The snapshot could not be saved.')
              : null,
        };
      }),

    take: (options) =>
      this.#mapped(async () => {
        const { computerId } = options;
        const machine = await this.#migration.find(computerId);
        if (machine === null) {
          throw new HarnessError({ message: `computer ${computerId} has no machine to save` });
        }
        const { pending } = await this.#finishReplacement(computerId);
        options.abortSignal?.throwIfAborted();
        if (snapshotInProgress(pending)) {
          throw new HarnessError({ message: `computer ${computerId} is already being saved` });
        }
        // A failed attempt is what `lastError` reports until this one replaces it.
        if (pending !== null) await this.#api.deleteSnapshot(pending.id);
        options.abortSignal?.throwIfAborted();
        const image = machine.labels[IMAGE_LABEL];
        const taken = await this.#api.snapshot(machine.id, {
          name: pendingSnapshotNameFor(computerId),
          ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
          labels: {
            [COMPUTER_LABEL.key]: SNAPSHOT_ROLE,
            [UPGRADE_COMPUTER_LABEL]: computerId,
            ...(image === undefined ? {} : { [IMAGE_LABEL]: image }),
          },
        });
        if (taken.state !== 'ready') {
          throw new HarnessError({
            message: `computer ${computerId}: the snapshot was not saved: ${taken.error ?? taken.state}`,
          });
        }
        options.abortSignal?.throwIfAborted();
        await this.#finishReplacement(computerId);
      }),

    restore: (options) =>
      this.#mapped(async () => {
        const { computerId } = options;
        const snapshot = await this.#readySnapshot(computerId);
        if (snapshot === null) {
          throw new HarnessError({ message: `computer ${computerId} has no snapshot to restore` });
        }
        const source = await this.#migration.find(computerId);
        if (source === null) {
          await this.#recreateFromSnapshot(computerId, snapshot, {
            snapshotProfiles: () => Promise.resolve(options.keepProfiles),
            leavePaused: options.leaveRunning !== true,
            ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
          });
          return;
        }
        await this.#containerFor(source.id).close();
        await this.#migration.restore(source, snapshot, computerId, {
          prepare: (stage) => this.#retireProfilesExcept(stage.id, options.keepProfiles),
          // A running computer takes the restored memory back into service.
          ...(options.leaveRunning === true
            ? {}
            : { pause: (stage) => this.#containerFor(stage.id).stop() }),
          ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
        });
        this.#containers.delete(source.id);
      }),
  };

  /**
   * Finish a replacement a crash interrupted: a ready pending snapshot
   * becomes the computer's one, and the one it replaces is deleted. There is
   * a ready snapshot at every point between these steps.
   */
  async #finishReplacement(
    computerId: string,
  ): Promise<{ current: RuntimeSnapshot | null; pending: RuntimeSnapshot | null }> {
    const name = snapshotNameFor(computerId);
    const pendingName = pendingSnapshotNameFor(computerId);
    const pending = await this.#api.findSnapshot(pendingName);
    const found = await this.#api.findSnapshot(name);
    const current = found?.state === 'ready' ? found : null;
    if (pending?.state !== 'ready' || !pending.backedUp) return { current, pending };

    // A concurrent check may already have promoted this candidate or moved on
    // to another capture. Only delete the canonical ID observed while this
    // candidate was still pending. In particular, never delete the candidate.
    if (found?.id === pending.id) return { current, pending: null };
    if ((await this.#api.findSnapshot(pendingName))?.id !== pending.id) {
      const latest = await this.#api.findSnapshot(name);
      return { current: latest?.state === 'ready' ? latest : null, pending: null };
    }
    if (found !== null) await this.#api.deleteSnapshot(found.id);
    try {
      await this.#api.renameSnapshot(pending.id, name);
    } catch (error: unknown) {
      // A parallel finalizer can promote this ID or a later save can replace it.
      if (!(error instanceof RuntimeApiError) || (error.status !== 404 && error.status !== 409)) {
        throw error;
      }
      const latest = await this.#api.findSnapshot(name);
      if (latest?.state === 'ready') return { current: latest, pending: null };
      // Runtime can keep the old name reserved while it deletes the old copy.
      // The durable pending copy is still usable. The next check retries.
      if (error.status === 404) throw error;
      return { current: pending, pending };
    }
    return { current: { ...pending, name }, pending: null };
  }

  async #deleteSnapshots(computerId: string): Promise<void> {
    for (const name of [snapshotNameFor(computerId), pendingSnapshotNameFor(computerId)]) {
      const snapshot = await this.#api.findSnapshot(name);
      if (snapshot !== null) await this.#api.deleteSnapshot(snapshot.id);
    }
  }

  async #readySnapshot(computerId: string): Promise<RuntimeSnapshot | null> {
    return (await this.#finishReplacement(computerId)).current;
  }

  /** The computer's machine again, made from its snapshot, running and usable. */
  async #recreateFromSnapshot(
    computerId: string,
    snapshot: RuntimeSnapshot,
    options: {
      snapshotProfiles?: () => Promise<readonly string[]>;
      abortSignal?: AbortSignal;
      leavePaused?: boolean;
    },
  ): Promise<ContainerSandboxSession> {
    this.#log(`computer ${computerId}: its machine is missing; recreating it from its snapshot`);
    const image = snapshot.labels[IMAGE_LABEL];
    const labels = {
      [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
      [ORPHANED_AT_LABEL]: 'none',
      [FIRST_START_LABEL]: String(Date.now()),
      ...(image === undefined ? {} : { [IMAGE_LABEL]: image }),
    };
    const stageName = `crewaid-recreate-${computerId}`;
    const canonicalName = sandboxNameFor(computerId);
    const stale = await this.#api.findByName(stageName);
    options.abortSignal?.throwIfAborted();
    if (stale !== null) {
      if (
        stale.labels[COMPUTER_LABEL.key] !== UPGRADE_STAGE_ROLE ||
        stale.labels[UPGRADE_COMPUTER_LABEL] !== computerId
      )
        throw new Error('Snapshot staging name is owned by another workspace');
      await this.#containerFor(stale.id).close();
      this.#containers.delete(stale.id);
      await this.#api.delete(stale.id);
    }
    options.abortSignal?.throwIfAborted();
    const created = await this.#api.createFromSnapshot(stageName, snapshot.id, {
      ...labels,
      [COMPUTER_LABEL.key]: UPGRADE_STAGE_ROLE,
      [UPGRADE_COMPUTER_LABEL]: computerId,
      [ORPHANED_AT_LABEL]: String(Date.now()),
    });
    const container = this.#containerFor(created.id);
    try {
      const session = this.#sessionOver(computerId, container);
      await container.start();
      await this.#awaitUsable(session, container, computerId, options.abortSignal);
      if (options.snapshotProfiles !== undefined) {
        await this.#retireProfilesExcept(created.id, await options.snapshotProfiles());
      }
      options.abortSignal?.throwIfAborted();
      await this.#api.keepWhilePaused(created.id);
      if (options.leavePaused === true) await container.stop();
      options.abortSignal?.throwIfAborted();
      // Publish only once retired profiles and readiness have been checked.
      await this.#api.rename(created.id, canonicalName, labels);
      return session;
    } catch (error) {
      await container.close();
      this.#containers.delete(created.id);
      // An ambiguous rename may already have published the prepared machine.
      if (!options.abortSignal?.aborted) {
        const current = await this.#api.get(created.id).catch(() => null);
        if (current?.name === stageName) await this.#api.delete(created.id).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * A snapshot predates every profile retired since it was taken, so a
   * restored machine would hand a deleted bot's logins back. Each profile not
   * kept gets the same tombstone `retireBotProfile` writes.
   */
  async #retireProfilesExcept(machineId: string, keep: readonly string[]): Promise<void> {
    const listed = await this.#api.exec(machineId, ['python3', '-I', '-c', LIST_PROFILES], {
      timeoutMs: 30_000,
    });
    if (listed.exitCode !== 0) {
      throw new Error(`could not list the restored machine's profiles: ${listed.stderr.trim()}`);
    }
    const parsed: unknown = JSON.parse(listed.stdout);
    if (!Array.isArray(parsed) || !parsed.every((name) => typeof name === 'string')) {
      throw new Error("the restored machine's profile list was malformed");
    }
    const kept = new Set(keep);
    for (const profile of parsed) {
      if (kept.has(profile)) continue;
      const result = await this.#api.exec(
        machineId,
        ['python3', '/opt/agent-bridge/profiles.py', 'retire', profile],
        { timeoutMs: 10_000 },
      );
      if (result.exitCode !== 0) throw new Error(`could not retire profile ${profile}`);
    }
  }

  // inventory and reconciliation

  listManagedSessions = async (): Promise<readonly ManagedSandboxObservation[]> =>
    this.#mapped(async () =>
      (await this.#computers()).map(({ computerId, machine }) => ({
        containerId: machine.id,
        sessionId: computerId,
        botId: computerId,
        running: machine.state === 'running',
        workspace: { ok: true, volumeName: machine.id },
      })),
    );

  /**
   * Orphan cleanup PAUSES. Under Docker this removes a container and keeps
   * its volume; here the sandbox is the volume, so deleting it would delete a
   * computer's files on a path whose whole promise is that it never does.
   */
  removeManagedSession = async (options: { containerId: string }): Promise<void> =>
    this.#mapped(async () => {
      const machine = await this.#api.get(options.containerId);
      if (machine === null) return;
      if (!isComputer(machine)) {
        throw new HarnessError({
          message: `Runtime sandbox ${options.containerId} is not a Crewaid computer`,
        });
      }
      await this.#containerFor(machine.id).stop();
    });

  // workspaces

  /** Creates the computer's sandbox and pauses it: the workspace exists, nothing runs. */
  provisionWorkspace = async (options: { botId: string }): Promise<void> =>
    this.#mapped(async () => {
      const name = sandboxNameFor(options.botId);
      if ((await this.#migration.find(options.botId)) !== null) return;
      const created = await this.#createMachine(name, {});
      await this.#api.pause(created.id);
    });

  inspectWorkspace = async (options: { botId: string }): Promise<WorkspaceObservation> =>
    this.#mapped(async () => {
      const found = await this.#migration.find(options.botId);
      if (found !== null) return { exists: true, ok: true, volumeName: found.id };
      // With its machine gone, a ready snapshot is the saved workspace,
      // and the next start recreates the machine from it.
      const snapshot = await this.#readySnapshot(options.botId);
      return snapshot === null
        ? { exists: false }
        : { exists: true, ok: true, volumeName: snapshot.id };
    });

  /** Has this workspace ever run under the orchestrator? Read from its labels, never from the machine. */
  inspectWorkspaceHistory = async (options: {
    botId: string;
  }): Promise<{ referenced: boolean; runtimeCreatedAt: number | null }> =>
    this.#mapped(async () => {
      const found = await this.#migration.find(options.botId);
      if (found === null) throw new Error('Workspace is missing; refusing to recreate storage');
      const runtimeCreatedAt = parseTime(found.labels[FIRST_START_LABEL]);
      // A running sandbox is the runtime referencing this workspace.
      return {
        referenced: found.state === 'running' && runtimeCreatedAt !== null,
        runtimeCreatedAt,
      };
    });

  listWorkspaces = async (): Promise<readonly { botId: string }[]> =>
    this.#mapped(async () => {
      const [machines, snapshots] = await Promise.all([
        this.#computers(),
        this.#api.listSnapshots(),
      ]);
      const ids = new Set(machines.map(({ computerId }) => computerId));
      for (const snapshot of snapshots) {
        const labeled = snapshot.labels[UPGRADE_COMPUTER_LABEL];
        const computerId =
          labeled ?? /^crewaid-snapshot-([a-z0-9]+)(?:-next)?$/i.exec(snapshot.name ?? '')?.[1];
        if (
          computerId !== undefined &&
          (snapshot.name === snapshotNameFor(computerId) ||
            snapshot.name === pendingSnapshotNameFor(computerId))
        ) {
          ids.add(computerId);
          if (snapshot.name === pendingSnapshotNameFor(computerId) && snapshot.backedUp) {
            // Finish the swap even after the user has closed Settings.
            await this.#finishReplacement(computerId).catch((error: unknown) => {
              this.#log(`computer ${computerId}: snapshot swap will retry: ${String(error)}`);
            });
          }
        }
      }
      return [...ids].map((botId) => ({ botId }));
    });

  /**
   * The retention sweep's question, answered from the API alone: the orphan
   * clock is a label on the sandbox (D-039 keeps it with the workspace, and
   * here the sandbox is the workspace), so no sweep ever wakes a machine.
   */
  retainWorkspace = async (options: {
    botId: string;
    orphaned: boolean;
    now: number;
    retentionMs: number;
  }): Promise<'absent' | 'in-use' | 'retained' | 'deleted'> =>
    this.#mapped(async () => {
      const found = await this.#migration.find(options.botId);
      if (found === null) {
        // A computer deleted after its machine was lost has only its snapshot
        // left, and no machine to keep a retention clock on.
        if (options.orphaned) await this.#deleteSnapshots(options.botId);
        return 'absent';
      }
      await this.#migration.retainBackups(options.botId, options.now, options.retentionMs);
      const first = parseTime(found.labels[ORPHANED_AT_LABEL]);
      if (!options.orphaned) {
        // A computer restored after being orphaned must lose its old clock.
        if (first !== null) {
          await this.#api.setLabels(found.id, { ...found.labels, [ORPHANED_AT_LABEL]: 'none' });
        }
        return 'retained';
      }
      if (found.state === 'running') return 'in-use';
      if (first === null) {
        await this.#api.setLabels(found.id, {
          ...found.labels,
          [ORPHANED_AT_LABEL]: String(options.now),
        });
        return options.retentionMs <= 0 ? this.#deleteOrphan(found.id, options.botId) : 'retained';
      }
      if (options.now - first < options.retentionMs) return 'retained';
      return this.#deleteOrphan(found.id, options.botId);
    });

  /**
   * Write a bot's profile tombstone, while the desktop may be down. Runtime's
   * exec runs as the image's `bot` (uid 1000), the user the tombstone must
   * belong to; it wakes a paused sandbox, so a paused one is paused again.
   */
  retireBotProfile = async (options: { computerId: string; botId: string }): Promise<void> =>
    this.#mapped(async () => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.botId) || options.botId === 'Default') {
        throw new Error('Invalid bot profile');
      }
      const found = await this.#migration.find(options.computerId);
      if (found === null) throw new Error('Workspace is missing; cannot retire profile');
      try {
        const result = await this.#api.exec(
          found.id,
          ['python3', '/opt/agent-bridge/profiles.py', 'retire', options.botId],
          { timeoutMs: 10_000 },
        );
        if (result.exitCode !== 0) throw new Error('Could not persist profile retirement');
      } finally {
        if (found.state === 'paused') await this.#api.pause(found.id).catch(() => undefined);
      }
    });

  // plumbing

  #containerFor(machineId: string): RuntimeContainer {
    let container = this.#containers.get(machineId);
    if (container === undefined) {
      container = new RuntimeContainer(this.#api, machineId);
      this.#containers.set(machineId, container);
    }
    return container;
  }

  #sessionOver(sessionId: string, container: RuntimeContainer): ContainerSandboxSession {
    return new ContainerSandboxSession({
      sessionId,
      container,
      containerId: container.id,
      screen: SCREEN,
    });
  }

  /**
   * A new computer's sandbox, kept while paused for as long as the account
   * has credit: Runtime's default would delete a paused workspace on its own
   * clock, and only retention may decide that here.
   */
  async #createMachine(name: string, labels: Record<string, string>): Promise<RuntimeMachine> {
    // By the version the reference names now, so the label says exactly what
    // runs even when the reference is a tag a release later moves.
    const image = await this.#targetImage();
    const created = await this.#api.create(name, {
      image: image.id,
      vcpu: this.#vcpu,
      memoryMiB: this.#memoryMiB,
      diskMiB: this.#diskMiB,
      labels: {
        [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
        [ORPHANED_AT_LABEL]: 'none',
        [IMAGE_LABEL]: image.id,
        ...labels,
      },
    });
    try {
      await this.#api.keepWhilePaused(created.id);
    } catch (error) {
      // A computer Runtime might delete behind retention's back is not one to
      // hand out; this one holds no files yet.
      await this.#api.delete(created.id).catch(() => undefined);
      if (error instanceof RuntimeApiError && error.code === 'retention_unavailable') {
        // An account without credit keeps a paused sandbox seven days, then
        // deletes it with its files: a user away for a week would lose their
        // computer's workspace with nothing in the orchestrator deciding so.
        throw new HarnessError({
          message:
            'Runtime keeps a paused sandbox only seven days on an account without credit, ' +
            "then deletes it with the computer's files. Add credit to the Runtime account " +
            'so a paused computer is kept until retention deletes it (D-217).',
          cause: error,
        });
      }
      throw error;
    }
    return created;
  }

  async #targetImage(): Promise<RuntimeImage> {
    const image = await this.#api.resolveImage(this.#image);
    if (image === null) {
      throw new HarnessError({
        message:
          `Runtime has no image ${this.#image} (SANDBOX_RUNTIME_IMAGE). Put it there with ` +
          '`pnpm --filter @crewaid/sandbox-runtime build-image`, or let a release do it.',
      });
    }
    return image;
  }

  /**
   * Move a computer onto the configured image when it runs an older one.
   * Runs on a start from paused or stopped, with the machine up.
   *
   * Everything that stops the move leaves the computer as it was and starts
   * it on its current image: the start a person asked for matters more than
   * the update. Only an API fault outside the switch itself fails the start.
   */
  async #followImage(
    source: RuntimeMachine,
    container: RuntimeContainer,
    sessionId: string,
    target: RuntimeImage,
    abortSignal?: AbortSignal,
  ): Promise<RuntimeMachine> {
    const machineId = source.id;
    const labels = source.labels;
    if (labels[IMAGE_LABEL] === target.id) return source;
    if (target.startArgv?.[0] !== RUNTIME_START_COMMAND) {
      this.#log(
        `computer ${sessionId} stays on its image: ${this.#image} does not start with ${RUNTIME_START_COMMAND}, so a switch would leave its home behind`,
      );
      return source;
    }
    const refused = labels[IMAGE_REFUSED_LABEL] === target.id;
    const reason = labels[IMAGE_REFUSED_REASON_LABEL];
    if (refused && reason !== undefined && reason !== 'image_on_another_host') return source;
    await container.close();
    if (refused && reason === 'image_on_another_host') {
      return this.#migration.migrate(source, target, sessionId, abortSignal);
    }
    // A legacy refusal saved only the image id: retry once to classify it.
    const prepared = await this.#api.exec(machineId, ['sudo', '-n', 'sh', '-c', PREPARE_SWITCH], {
      timeoutMs: 300_000,
    });
    if (prepared.exitCode !== 0) {
      this.#log(
        `computer ${sessionId} stays on its image: preparing the switch failed (exit ${prepared.exitCode ?? 'none'}): ${prepared.stderr.trim().slice(0, 300)}`,
      );
      return source;
    }
    abortSignal?.throwIfAborted();
    try {
      await this.#api.switchImage(machineId, target.id);
    } catch (error: unknown) {
      if (!(error instanceof RuntimeApiError) || !SWITCH_REFUSALS.has(error.code)) throw error;
      this.#log(
        `computer ${sessionId} stays on its image: Runtime refused the switch to ${target.id} (${error.code}: ${error.message})`,
      );
      const refusedLabels = {
        ...labels,
        [IMAGE_REFUSED_LABEL]: target.id,
        [IMAGE_REFUSED_REASON_LABEL]: error.code,
      };
      await this.#api.setLabels(machineId, refusedLabels);
      if (prepared.stdout.includes('copied')) {
        await this.#api.exec(machineId, ['sudo', '-n', 'rm', '-rf', '/workspace/.crewaid-home'], {
          timeoutMs: 120_000,
        });
      }
      if (error.code === 'image_on_another_host') {
        return this.#migration.migrate(
          { ...source, labels: refusedLabels },
          target,
          sessionId,
          abortSignal,
        );
      }
      return source;
    }
    const {
      [IMAGE_REFUSED_LABEL]: _refused,
      [IMAGE_REFUSED_REASON_LABEL]: _reason,
      ...kept
    } = labels;
    const updated = { ...kept, [IMAGE_LABEL]: target.id };
    await this.#api.setLabels(machineId, updated);
    return { ...source, labels: updated };
  }

  async #deleteOrphan(
    machineId: string,
    computerId: string,
  ): Promise<'absent' | 'in-use' | 'deleted'> {
    // Asked again just before the delete: a computer started since the
    // sweep's first read is in use, whatever its clock says.
    const current = await this.#api.get(machineId);
    if (current === null) return 'absent';
    if (current.state === 'running') return 'in-use';
    await this.#containerFor(machineId).close();
    this.#containers.delete(machineId);
    await this.#api.delete(machineId);
    // Nothing of a deleted computer stays billed.
    await this.#deleteSnapshots(computerId);
    return 'deleted';
  }

  /** Every sandbox that is one of this provider's computers. */
  #computers(): Promise<{ computerId: string; machine: RuntimeMachine }[]> {
    return this.#migration.computers();
  }

  /**
   * Wait for the bridge. After a create the start command has already
   * brought it up, and after a wake the processes are back as they were, so
   * the first probe usually answers. When it does not, nothing on this host
   * will start the desktop — Runtime runs the start command on create only —
   * so the launcher runs through Runtime's exec, again every `relaunchMs`
   * since it is idempotent, and the wait continues against one deadline.
   */
  async #awaitUsable(
    session: ContainerSandboxSession,
    container: RuntimeContainer,
    sessionId: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.#readyTimeoutMs;
    const { url } = await session.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
    let lastLaunch = Number.NEGATIVE_INFINITY;
    for (;;) {
      abortSignal?.throwIfAborted();
      if (await this.#bridgeProbe(url)) return;
      if (Date.now() - lastLaunch >= this.#relaunchMs) {
        lastLaunch = Date.now();
        const result = await this.#api.exec(
          container.id,
          ['sudo', '-n', '/usr/local/bin/crewaid-desktop-up'],
          { timeoutMs: 15_000 },
        );
        if (result.exitCode !== 0) {
          throw new HarnessError({
            message:
              `sandbox ${sessionId}: the desktop launcher failed (exit ${result.exitCode ?? 'none'}): ` +
              result.stderr.trim().slice(0, 300),
          });
        }
      }
      if (Date.now() > deadline) {
        throw new HarnessError({
          message:
            `sandbox ${sessionId}: the agent-bridge did not report healthy within ` +
            `${this.#readyTimeoutMs}ms. /tmp/crewaid-entrypoint.log inside the machine names ` +
            'the component the entrypoint was waiting on.',
        });
      }
      await delay(250);
    }
  }

  async #mapped<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      if (HarnessError.isInstance(error)) throw error;
      if (error instanceof RuntimeApiError && error.unauthorized) {
        throw new HarnessSandboxAuthenticationError({
          message:
            'Runtime refused the API key. Check that it is set and that it can manage ' +
            'sandboxes on the account.',
          sandboxProviderId: this.providerId,
          cause: error,
        });
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new HarnessError({ message: `runtime: ${detail}`, cause: error });
    }
  }
}

/**
 * One Runtime sandbox as the narrow container port.
 *
 * `stop` and `remove` both pause — see the provider's header for why neither
 * may delete — and both close the tunnel first, because a connection opened
 * to a paused sandbox wakes it, and a listener left open would wake a machine
 * nobody asked to wake.
 */
class RuntimeContainer implements SandboxContainer {
  readonly id: string;
  readonly #api: RuntimeApi;
  #tunnel: Promise<RuntimeTunnel> | null = null;
  #forwards = new Map<number, Promise<ContainerPortBinding>>();
  #status: { value: RuntimeMachine | null; at: number } | null = null;
  /** Preview creation must finish before stop removes previews and pauses. */
  #screenOperations: Promise<void> = Promise.resolve();
  /** The live private share of each port, forgotten with the previews on stop. */
  #screenShares = new Map<number, RuntimeSharedPort>();

  constructor(api: RuntimeApi, machineId: string) {
    this.#api = api;
    this.id = machineId;
  }

  async start(): Promise<void> {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const machine = await this.#machine(true);
      if (machine === null) throw new Error(`sandbox ${this.id} no longer exists`);
      if (machine.state === 'running') return;
      if (Date.now() > deadline) {
        throw new Error(`sandbox ${this.id} did not start; it is still ${machine.state}`);
      }
      if (machine.state === 'paused') await this.#api.wake(this.id);
      else if (machine.state === 'stopped') await this.#api.restart(this.id);
      else if (TRANSITIONAL.has(machine.state)) await delay(250);
      else throw new Error(`sandbox ${this.id} is ${machine.state}`);
    }
  }

  stop(): Promise<void> {
    return this.#withScreenOperation(async () => {
      // Forgotten whether or not the unshare below succeeds: a share is only
      // reused while nothing has stopped the computer since it was made.
      this.#screenShares = new Map();
      await this.close();
      const machine = await this.#machine(true);
      if (machine !== null) {
        // Runtime wakes a paused sandbox when its preview is visited, so a
        // stopped computer keeps no shared port for a stale screen link to wake
        // it through. Pausing matters more than this does: if the
        // unshare fails, the token a link carries stops admitting within
        // SCREEN_ACCESS_TTL_SECONDS of its grant anyway.
        await this.#api.unshareAllPorts(this.id).catch(() => undefined);
      }
      if (
        machine?.state === 'running' ||
        machine?.state === 'starting' ||
        machine?.state === 'resuming'
      ) {
        await this.#api.pause(this.id);
      }
      const deadline = Date.now() + 120_000;
      for (;;) {
        const current = await this.#machine(true);
        if (current === null || current.state === 'paused' || current.state === 'stopped') break;
        if (Date.now() >= deadline || !TRANSITIONAL.has(current.state)) {
          throw new Error(`sandbox ${this.id} did not pause; it is ${current.state}`);
        }
        await delay(250);
      }
      this.#status = null;
    });
  }

  /**
   * The port's private share: the one already made while its token has a
   * ticket's life left, else a new one. Reusing it takes three Runtime round
   * trips — this recheck, the SDK's lookup and the create — off the path from
   * a click on a bot to its picture.
   */
  shareScreenPort(port: number): Promise<RuntimeSharedPort> {
    return this.#withScreenOperation(async () => {
      // A share still held means no stop has run since it was made: stop
      // clears them inside this same queue. The caller has just read the
      // machine as running from Runtime, so nothing further is asked here.
      const held = this.#screenShares.get(port);
      if (held !== undefined && held.tokenExpiresAt - Date.now() >= SCREEN_ACCESS_REUSE_MIN_MS) {
        return held;
      }
      // Recheck INSIDE the queue: a stop may have completed while this grant
      // waited, or while the provider was looking up the computer by name.
      const machine = await this.#machine(true);
      if (machine === null || machine.state !== 'running') {
        throw new HarnessError({ message: `sandbox ${this.id} is not running` });
      }
      const shared = await this.#api.sharePort(this.id, port, SCREEN_ACCESS_TTL_SECONDS);
      this.#screenShares.set(port, shared);
      return shared;
    });
  }

  #withScreenOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#screenOperations.then(operation);
    this.#screenOperations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Pauses, never deletes: this sandbox is the computer's workspace. */
  async remove(): Promise<void> {
    await this.stop();
  }

  async inspect(): Promise<ContainerStatus> {
    const machine = await this.#machine(false);
    const running = machine?.state === 'running';
    return {
      running,
      exitCode: null,
      portBindings: running ? await this.#allBindings() : {},
      mounts: [],
      labels: machine?.name == null ? {} : { name: machine.name },
    };
  }

  async spawn(spec: ContainerExecSpec): Promise<ContainerProcess> {
    return bridgeExec(await this.endpoint(SANDBOX_PORTS.bridge), spec);
  }

  /** A loopback listener for `port` inside the sandbox, opened once and shared. */
  endpoint(port: number): Promise<ContainerPortBinding> {
    let forward = this.#forwards.get(port);
    if (forward === undefined) {
      const opened = this.#openTunnel().then((tunnel) => tunnel.forward(port));
      forward = opened;
      this.#forwards.set(port, opened);
      // A failed forward is retried on the next call, not cached forever.
      opened.catch(() => {
        if (this.#forwards.get(port) === opened) this.#forwards.delete(port);
      });
    }
    return forward;
  }

  async close(): Promise<void> {
    const tunnel = this.#tunnel;
    this.#tunnel = null;
    this.#forwards = new Map();
    if (tunnel !== null) await (await tunnel.catch(() => null))?.close();
  }

  #openTunnel(): Promise<RuntimeTunnel> {
    if (this.#tunnel === null) {
      const opened = this.#api.openTunnel(this.id);
      this.#tunnel = opened;
      opened.then(
        (tunnel) =>
          // A tunnel the sandbox ended (it paused, or went away) takes its
          // listeners with it; the next endpoint opens a fresh one.
          void tunnel.closed.then(() => {
            if (this.#tunnel === opened) {
              this.#tunnel = null;
              this.#forwards = new Map();
            }
          }),
        () => {
          if (this.#tunnel === opened) this.#tunnel = null;
        },
      );
    }
    return this.#tunnel;
  }

  async #allBindings(): Promise<Readonly<Record<number, ContainerPortBinding>>> {
    const entries = await Promise.all(
      MACHINE_PORTS.map(async (port) => [port, await this.endpoint(port)] as const),
    );
    return Object.fromEntries(entries);
  }

  async #machine(fresh: boolean): Promise<RuntimeMachine | null> {
    if (!fresh && this.#status !== null && Date.now() - this.#status.at < STATUS_TTL_MS) {
      return this.#status.value;
    }
    const value = await this.#api.get(this.id);
    this.#status = { value, at: Date.now() };
    return value;
  }
}

function isComputer(machine: RuntimeMachine): boolean {
  return (
    (machine.name ?? '').startsWith(COMPUTER_NAME_PREFIX) &&
    machine.labels[COMPUTER_LABEL.key] === COMPUTER_LABEL.value
  );
}

/** An epoch-ms label value, or null for `none`, absent, or anything malformed. */
function parseTime(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,16}$/.test(value)) return null;
  return Number(value);
}

function sameLabels(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function unwell(reason: string): SandboxHealth {
  return { ok: false, reason };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeBridgeOverHttp(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function snapshotInProgress(snapshot: RuntimeSnapshot | null): boolean {
  return snapshot?.state === 'capturing' || (snapshot?.state === 'ready' && !snapshot.backupFailed);
}
