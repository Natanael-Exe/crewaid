import { createHash } from 'node:crypto';

import type {
  RuntimeApi,
  RuntimeImage,
  RuntimeMachine,
  RuntimeSnapshot,
} from './runtime-client.js';
import {
  COMPUTER_LABEL,
  COMPUTER_NAME_PREFIX,
  IMAGE_LABEL,
  IMAGE_REFUSED_LABEL,
  IMAGE_REFUSED_REASON_LABEL,
  ORPHANED_AT_LABEL,
  RESTORE_DISCARD_LABEL,
  UPGRADE_BACKUP_ROLE,
  UPGRADE_COMPUTER_LABEL,
  UPGRADE_READY_LABEL,
  UPGRADE_REPLACEMENT_LABEL,
  UPGRADE_SOURCE_LABEL,
  UPGRADE_STAGE_ROLE,
  sandboxNameFor,
} from './runtime-labels.js';

function backupName(id: string): string {
  return `crewaid-backup-${id}`;
}

function stageHash(sourceId: string, of: string): string {
  return createHash('sha256').update(`${sourceId}:${of}`).digest('hex').slice(0, 24);
}

/** Durable labels bridge the two renames; no process-local pointer owns the computer. */
export class RuntimeImageMigration {
  constructor(
    private readonly api: RuntimeApi,
    private readonly ready: (
      machine: RuntimeMachine,
      computerId: string,
      signal?: AbortSignal,
    ) => Promise<void>,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  async find(computerId: string): Promise<RuntimeMachine | null> {
    const canonical = await this.api.findByName(sandboxNameFor(computerId));
    if (canonical !== null) return canonical;
    const stages = await this.api.list({
      [COMPUTER_LABEL.key]: UPGRADE_STAGE_ROLE,
      [UPGRADE_COMPUTER_LABEL]: computerId,
    });
    const verified: RuntimeMachine[] = [];
    for (const stage of stages) {
      if (stage.labels[UPGRADE_READY_LABEL] !== 'true') continue;
      const sourceId = stage.labels[UPGRADE_SOURCE_LABEL];
      const source = sourceId === undefined ? null : await this.api.get(sourceId);
      if (
        source !== null &&
        source.name === backupName(source.id) &&
        source.labels[COMPUTER_LABEL.key] === UPGRADE_BACKUP_ROLE &&
        source.labels[UPGRADE_COMPUTER_LABEL] === computerId &&
        source.labels[UPGRADE_REPLACEMENT_LABEL] === stage.id &&
        source.state === 'paused'
      )
        verified.push(stage);
    }
    if (verified.length === 1) return verified[0] ?? null;
    const backups = await this.api.list({
      [COMPUTER_LABEL.key]: UPGRADE_BACKUP_ROLE,
      [UPGRADE_COMPUTER_LABEL]: computerId,
    });
    if (backups.length > 0 || verified.length > 1) {
      throw new Error(
        `computer ${computerId}: upgrade recovery is incomplete; saved workspaces were preserved`,
      );
    }
    return null;
  }

  async computers(): Promise<{ computerId: string; machine: RuntimeMachine }[]> {
    const normal = await this.api.list({ [COMPUTER_LABEL.key]: COMPUTER_LABEL.value });
    const byComputer = new Map(
      normal
        .filter((machine) => machine.name?.startsWith(COMPUTER_NAME_PREFIX))
        .map((machine) => [(machine.name ?? '').slice(COMPUTER_NAME_PREFIX.length), machine]),
    );
    for (const stage of await this.api.list({ [COMPUTER_LABEL.key]: UPGRADE_STAGE_ROLE })) {
      const computerId = stage.labels[UPGRADE_COMPUTER_LABEL];
      if (
        computerId === undefined ||
        byComputer.has(computerId) ||
        stage.labels[UPGRADE_READY_LABEL] !== 'true'
      )
        continue;
      const recovered = await this.find(computerId);
      if (recovered !== null) byComputer.set(computerId, recovered);
    }
    return [...byComputer].map(([computerId, machine]) => ({ computerId, machine }));
  }

  async promote(
    stage: RuntimeMachine,
    computerId: string,
    signal?: AbortSignal,
  ): Promise<RuntimeMachine> {
    signal?.throwIfAborted();
    if (
      stage.labels[UPGRADE_READY_LABEL] !== 'true' ||
      stage.labels[UPGRADE_COMPUTER_LABEL] !== computerId
    )
      throw new Error('Unverified upgrade destination');
    await this.ready(stage, computerId, signal);
    signal?.throwIfAborted();
    return this.#publish(stage, computerId);
  }

  async #publish(stage: RuntimeMachine, computerId: string): Promise<RuntimeMachine> {
    const {
      [IMAGE_REFUSED_LABEL]: _refused,
      [IMAGE_REFUSED_REASON_LABEL]: _reason,
      [UPGRADE_REPLACEMENT_LABEL]: _replacement,
      ...labels
    } = stage.labels;
    await this.api.rename(stage.id, sandboxNameFor(computerId), {
      ...labels,
      [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
      [ORPHANED_AT_LABEL]: 'none',
    });
    const promoted = await this.api.get(stage.id);
    if (promoted === null) throw new Error('Verified upgrade destination disappeared');
    return promoted;
  }

  async migrate(
    source: RuntimeMachine,
    target: RuntimeImage,
    computerId: string,
    signal?: AbortSignal,
  ): Promise<RuntimeMachine> {
    try {
      return await this.#replace(
        source,
        computerId,
        {
          name: `crewaid-upgrade-${stageHash(source.id, target.id)}`,
          labels: { ...source.labels, [IMAGE_LABEL]: target.id },
          create: (name, labels) =>
            this.api.create(name, {
              image: target.id,
              vcpu: source.vcpu,
              memoryMiB: source.memoryMiB,
              diskMiB: source.diskMiB,
              labels,
            }),
          fill: (stage) =>
            this.api.copyWorkspace(
              source.id,
              stage.id,
              signal === undefined ? undefined : { abortSignal: signal },
            ),
          discardSource: false,
        },
        signal,
      );
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `computer ${computerId}: image migration failed; its saved workspace is preserved: ${detail}`,
        { cause: error },
      );
    }
  }

  /**
   * Replace the computer's machine with a running copy of a snapshot,
   * through the same journal a migration uses, then delete the old machine.
   * `prepare` runs on the copy after its bridge answers and before it becomes
   * the computer.
   */
  async restore(
    source: RuntimeMachine,
    snapshot: RuntimeSnapshot,
    computerId: string,
    options: {
      readonly prepare: (stage: RuntimeMachine) => Promise<void>;
      readonly pause?: (stage: RuntimeMachine) => Promise<void>;
      readonly signal?: AbortSignal;
    },
  ): Promise<RuntimeMachine> {
    const { signal } = options;
    // The copy runs the image the snapshot was taken on, not the source's.
    const {
      [IMAGE_LABEL]: _image,
      [IMAGE_REFUSED_LABEL]: _refused,
      [IMAGE_REFUSED_REASON_LABEL]: _reason,
      ...kept
    } = source.labels;
    const image = snapshot.labels[IMAGE_LABEL];
    let promoted: RuntimeMachine;
    try {
      promoted = await this.#replace(
        source,
        computerId,
        {
          name: `crewaid-restore-${stageHash(source.id, snapshot.id)}`,
          labels: { ...kept, ...(image === undefined ? {} : { [IMAGE_LABEL]: image }) },
          create: (name, labels) => this.api.createFromSnapshot(name, snapshot.id, labels),
          fill: options.prepare,
          ...(options.pause === undefined ? {} : { beforeRename: options.pause }),
          discardSource: true,
        },
        signal,
      );
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`computer ${computerId}: restoring its snapshot failed: ${detail}`, {
        cause: error,
      });
    }
    // The restore is already committed. A failed cleanup can retry in retention.
    try {
      const backup = await this.api.get(source.id);
      if (
        backup !== null &&
        backup.name === backupName(source.id) &&
        backup.labels[RESTORE_DISCARD_LABEL] === 'true' &&
        backup.state === 'paused'
      ) {
        await this.api.delete(source.id);
      }
    } catch (error: unknown) {
      this.log(`computer ${computerId}: restore backup cleanup will retry: ${String(error)}`);
    }
    return promoted;
  }

  /**
   * Stage a replacement, verify it, then swap it in: the source becomes a
   * paused backup and the stage takes the computer's name. Until the first
   * rename the source is still the computer; after it, the ready stage and
   * the backup are the journal `find` recovers from.
   */
  async #replace(
    source: RuntimeMachine,
    computerId: string,
    spec: {
      readonly name: string;
      readonly labels: Readonly<Record<string, string>>;
      readonly create: (
        name: string,
        labels: Readonly<Record<string, string>>,
      ) => Promise<RuntimeMachine>;
      readonly fill: (stage: RuntimeMachine) => Promise<void>;
      readonly beforeRename?: (stage: RuntimeMachine) => Promise<void>;
      readonly discardSource: boolean;
    },
    signal?: AbortSignal,
  ): Promise<RuntimeMachine> {
    signal?.throwIfAborted();
    const name = spec.name;
    const labels: Record<string, string> = {
      ...spec.labels,
      [COMPUTER_LABEL.key]: UPGRADE_STAGE_ROLE,
      [UPGRADE_COMPUTER_LABEL]: computerId,
      [UPGRADE_SOURCE_LABEL]: source.id,
      [UPGRADE_READY_LABEL]: 'false',
      [ORPHANED_AT_LABEL]: String(Date.now()),
    };
    let stage = await this.api.findByName(name);
    if (stage !== null) {
      if (
        stage.labels[COMPUTER_LABEL.key] !== UPGRADE_STAGE_ROLE ||
        stage.labels[UPGRADE_SOURCE_LABEL] !== source.id ||
        stage.labels[UPGRADE_COMPUTER_LABEL] !== computerId ||
        stage.labels[IMAGE_LABEL] !== labels[IMAGE_LABEL]
      )
        throw new Error('Upgrade staging name is owned by another workspace');
      // The canonical source is still authoritative; recopy rather than use a stale snapshot.
      await this.api.delete(stage.id);
    }
    stage = null;
    try {
      stage = await spec.create(name, labels);
      await this.api.keepWhilePaused(stage.id);
      await this.api.unshareAllPorts(source.id);
      signal?.throwIfAborted();
      await spec.fill(stage);
      await this.ready(stage, computerId, signal);
      signal?.throwIfAborted();
      const verified = { ...stage, labels: { ...labels, [UPGRADE_READY_LABEL]: 'true' } };
      // A stopped restore must be able to pause its copy before changing the
      // canonical name. Leave the source alone if the staged pause fails.
      await spec.beforeRename?.(verified);
      signal?.throwIfAborted();
      await this.api.setLabels(stage.id, verified.labels);
      await this.api.setLabels(source.id, {
        ...source.labels,
        [UPGRADE_REPLACEMENT_LABEL]: stage.id,
      });
      await this.api.pause(source.id);
      signal?.throwIfAborted();
      await this.api.rename(source.id, backupName(source.id), {
        ...source.labels,
        [COMPUTER_LABEL.key]: UPGRADE_BACKUP_ROLE,
        [UPGRADE_COMPUTER_LABEL]: computerId,
        [UPGRADE_REPLACEMENT_LABEL]: stage.id,
        [ORPHANED_AT_LABEL]: String(Date.now()),
        ...(spec.discardSource ? { [RESTORE_DISCARD_LABEL]: 'true' } : {}),
      });
      // Renaming also disables automatic wake; close any grant that raced the first unshare.
      await this.api.unshareAllPorts(source.id);
      await this.api.pause(source.id);
      signal?.throwIfAborted();
      return spec.beforeRename === undefined
        ? await this.promote(verified, computerId, signal)
        : await this.#publish(verified, computerId);
    } catch (error: unknown) {
      // A new lifecycle owner may already be using these resources after lease loss.
      if (signal?.aborted === true) throw error;
      const canonical = await this.api.findByName(sandboxNameFor(computerId));
      if (stage !== null && canonical?.id === source.id) {
        await this.api.delete(stage.id).catch(() => undefined);
      }
      // After the first rename, the ready stage and backup are the recovery journal.
      await this.api.pause(source.id).catch(() => undefined);
      throw error;
    }
  }

  async retainBackups(computerId: string, now: number, retentionMs: number): Promise<void> {
    const canonical = await this.api.findByName(sandboxNameFor(computerId));
    if (canonical === null || canonical.labels[COMPUTER_LABEL.key] !== COMPUTER_LABEL.value) return;
    for (const backup of await this.api.list({
      [COMPUTER_LABEL.key]: UPGRADE_BACKUP_ROLE,
      [UPGRADE_COMPUTER_LABEL]: computerId,
    })) {
      const since = Number(backup.labels[ORPHANED_AT_LABEL]);
      // A restore's backup is discarded at once; an upgrade's waits out retention.
      const discard = backup.labels[RESTORE_DISCARD_LABEL] === 'true';
      if (
        !Number.isFinite(since) ||
        backup.state !== 'paused' ||
        (!discard && now - since < retentionMs)
      )
        continue;
      const replacementId = backup.labels[UPGRADE_REPLACEMENT_LABEL];
      const replacement = replacementId === undefined ? null : await this.api.get(replacementId);
      if (
        replacement?.labels[UPGRADE_SOURCE_LABEL] !== backup.id ||
        replacement.labels[UPGRADE_READY_LABEL] !== 'true'
      )
        continue;
      // Recheck immediately before deleting: a manually woken backup must survive.
      if ((await this.api.get(backup.id))?.state === 'paused') await this.api.delete(backup.id);
    }
  }
}
