import { HarnessError } from '@crewaid/sandbox-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeRuntime } from './fake-runtime-api.js';
import {
  COMPUTER_LABEL,
  IMAGE_LABEL,
  ORPHANED_AT_LABEL,
  RESTORE_DISCARD_LABEL,
  RUNTIME_START_COMMAND,
  RuntimeSandboxProvider,
  UPGRADE_BACKUP_ROLE,
  UPGRADE_COMPUTER_LABEL,
  UPGRADE_READY_LABEL,
  UPGRADE_REPLACEMENT_LABEL,
  UPGRADE_SOURCE_LABEL,
  pendingSnapshotNameFor,
  sandboxNameFor,
  snapshotNameFor,
} from './runtime-sandbox-provider.js';

const CURRENT_IMAGE = 'img-current';
const DAY = 24 * 60 * 60_000;

let fake: FakeRuntime;
/** Profiles the fake machine reports holding, as LIST_PROFILES would print them. */
let profilesOnMachine: string[];

function provider(): RuntimeSandboxProvider {
  return new RuntimeSandboxProvider({
    api: fake,
    image: 'crewaid-sandbox:test',
    readyTimeoutMs: 2_000,
    relaunchMs: 300,
    bridgeProbe: () => Promise.resolve(true),
    log: () => undefined,
  });
}

function computer(id: string, state: 'paused' | 'running' = 'paused') {
  return fake.addMachine(sandboxNameFor(id), {
    state,
    labels: {
      [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
      [ORPHANED_AT_LABEL]: 'none',
      [IMAGE_LABEL]: CURRENT_IMAGE,
    },
    imageId: CURRENT_IMAGE,
  });
}

function snapshotsNamed(name: string) {
  return [...fake.snapshots.values()].filter((snapshot) => snapshot.name === name);
}

function retired(): string[] {
  return fake.execs
    .filter((call) => call.argv[1] === '/opt/agent-bridge/profiles.py')
    .map((call) => call.argv[3] ?? '');
}

beforeEach(() => {
  fake = new FakeRuntime();
  fake.images.set('crewaid-sandbox:test', {
    id: CURRENT_IMAGE,
    startArgv: [RUNTIME_START_COMMAND],
  });
  profilesOnMachine = [];
  fake.execHandler = (call) =>
    call.argv[1] === '-I'
      ? { exitCode: 0, stdout: JSON.stringify(profilesOnMachine), stderr: '' }
      : { exitCode: 0, stdout: '', stderr: '' };
});

afterEach(async () => {
  await fake.close();
});

describe('RuntimeSandboxProvider — snapshots (D-237)', () => {
  it('saves a paused computer without waking it, under the canonical name', async () => {
    const machine = computer('cmp1');
    await provider().snapshots.take({ computerId: 'cmp1' });

    expect(fake.calls).not.toContain('wake');
    expect(fake.machines.get(machine.id)?.state).toBe('paused');
    const [saved] = snapshotsNamed(snapshotNameFor('cmp1'));
    expect(saved?.state).toBe('ready');
    expect(saved?.labels).toMatchObject({
      [COMPUTER_LABEL.key]: 'snapshot',
      [UPGRADE_COMPUTER_LABEL]: 'cmp1',
      [IMAGE_LABEL]: CURRENT_IMAGE,
    });
    expect(snapshotsNamed(pendingSnapshotNameFor('cmp1'))).toEqual([]);
  });

  it('replaces the snapshot rather than adding a second one', async () => {
    computer('cmp1');
    const p = provider();
    await p.snapshots.take({ computerId: 'cmp1' });
    const first = snapshotsNamed(snapshotNameFor('cmp1'))[0]?.id;
    await p.snapshots.take({ computerId: 'cmp1' });

    expect(fake.snapshots.size).toBe(1);
    expect(snapshotsNamed(snapshotNameFor('cmp1'))[0]?.id).not.toBe(first);
  });

  it('finishes a replacement interrupted after the capture', async () => {
    const machine = computer('cmp1');
    const p = provider();
    await p.snapshots.take({ computerId: 'cmp1' });
    // As if the orchestrator died between the capture and the rename.
    await fake.snapshot(machine.id, { name: pendingSnapshotNameFor('cmp1'), labels: {} });
    const pendingId = snapshotsNamed(pendingSnapshotNameFor('cmp1'))[0]?.id;

    const status = await p.snapshots.inspect({ computerId: 'cmp1' });

    expect(status.snapshot).not.toBeNull();
    expect(fake.snapshots.size).toBe(1);
    expect(snapshotsNamed(snapshotNameFor('cmp1'))[0]?.id).toBe(pendingId);
  });

  it('keeps the previous snapshot until Runtime verifies the off-host copy', async () => {
    computer('cmp1');
    const p = provider();
    await p.snapshots.take({ computerId: 'cmp1' });
    const [previous] = snapshotsNamed(snapshotNameFor('cmp1'));

    fake.snapshotBackedUp = false;
    await p.snapshots.take({ computerId: 'cmp1' });
    expect(await p.snapshots.inspect({ computerId: 'cmp1' })).toMatchObject({
      snapshot: { takenAt: previous?.createdAt },
      saving: true,
    });
    expect(fake.snapshots.size).toBe(2);
    const [pending] = snapshotsNamed(pendingSnapshotNameFor('cmp1'));
    if (pending === undefined) throw new Error('Expected a pending capture');
    pending.backedUp = true;

    await p.listWorkspaces();
    expect((await p.snapshots.inspect({ computerId: 'cmp1' })).saving).toBe(false);
    expect(snapshotsNamed(snapshotNameFor('cmp1'))[0]?.id).toBe(pending.id);
    expect(fake.snapshots.size).toBe(1);
  });

  it('keeps the new snapshot when a concurrent inspection has already promoted it', async () => {
    const machine = computer('cmp1');
    const p = provider();
    await p.snapshots.take({ computerId: 'cmp1' });
    const pendingName = pendingSnapshotNameFor('cmp1');
    const pending = await fake.snapshot(machine.id, { name: pendingName, labels: {} });
    const findSnapshot = fake.findSnapshot;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reading!: () => void;
    const readingPending = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let observed = false;
    fake.findSnapshot = async (name) => {
      const value = await findSnapshot(name);
      if (name === pendingName && !observed) {
        observed = true;
        reading();
        await gate;
      }
      return value;
    };

    const slow = p.snapshots.inspect({ computerId: 'cmp1' });
    await readingPending;
    try {
      await provider().snapshots.inspect({ computerId: 'cmp1' });
    } finally {
      release();
    }
    expect((await slow).snapshot).not.toBeNull();
    expect(snapshotsNamed(snapshotNameFor('cmp1'))[0]?.id).toBe(pending.id);
    expect(fake.snapshots.size).toBe(1);
  });

  it('reports a failed capture and keeps the snapshot it did not replace', async () => {
    computer('cmp1');
    const p = provider();
    await p.snapshots.take({ computerId: 'cmp1' });
    fake.snapshotOutcome = 'failed';

    await expect(p.snapshots.take({ computerId: 'cmp1' })).rejects.toThrow(/not saved/);
    const status = await p.snapshots.inspect({ computerId: 'cmp1' });
    expect(status.snapshot).not.toBeNull();
    expect(status.lastError).toBe('capture failed');

    fake.snapshotOutcome = 'ready';
    await p.snapshots.take({ computerId: 'cmp1' });
    expect((await p.snapshots.inspect({ computerId: 'cmp1' })).lastError).toBeNull();
    expect(fake.snapshots.size).toBe(1);
  });

  it('restores the snapshot onto a new machine, deletes the old one, and leaves it paused', async () => {
    const machine = computer('cmp1');
    machine.files.set('/home/bot/notes.txt', 'saved');
    const p = provider();
    await p.snapshots.take({ computerId: 'cmp1' });
    machine.files.set('/home/bot/notes.txt', 'changed since');
    profilesOnMachine = ['bot-a', 'bot-gone', 'company-google'];

    await p.snapshots.restore({ computerId: 'cmp1', keepProfiles: ['bot-a', 'company-google'] });

    expect(fake.machines.has(machine.id)).toBe(false);
    const restored = [...fake.machines.values()];
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ name: sandboxNameFor('cmp1'), state: 'paused' });
    expect(restored[0]?.labels[COMPUTER_LABEL.key]).toBe(COMPUTER_LABEL.value);
    expect(restored[0]?.files.get('/home/bot/notes.txt')).toBe('saved');
    expect(retired()).toEqual(['bot-gone']);
    // The snapshot outlives the restore: it can be restored again.
    expect(snapshotsNamed(snapshotNameFor('cmp1'))).toHaveLength(1);
  });

  it('preserves the original machine if the restored copy cannot pause', async () => {
    const machine = computer('cmp1');
    const p = provider();
    await p.snapshots.take({ computerId: 'cmp1' });
    const pause = fake.pause;
    fake.pause = (id) =>
      id === machine.id ? pause(id) : Promise.reject(new Error('stage pause refused'));

    await expect(p.snapshots.restore({ computerId: 'cmp1', keepProfiles: [] })).rejects.toThrow(
      /stage pause refused/,
    );
    expect(await fake.findByName(sandboxNameFor('cmp1'))).toMatchObject({ id: machine.id });
    expect(fake.machines.size).toBe(1);
  });

  it('keeps a running computer on the restored image until a later pause and wake', async () => {
    const p = provider();
    computer('cmp1');
    await p.snapshots.take({ computerId: 'cmp1' });
    fake.images.set('crewaid-sandbox:test', { id: 'img-new', startArgv: [RUNTIME_START_COMMAND] });

    await p.snapshots.restore({ computerId: 'cmp1', keepProfiles: [], leaveRunning: true });
    await p.resumeSession({ sessionId: 'cmp1' });

    const [restored] = fake.machines.values();
    expect(restored).toMatchObject({ state: 'running', imageId: CURRENT_IMAGE });
    expect(fake.switches).toEqual([]);
  });

  it('restores a missing machine and leaves it paused', async () => {
    const machine = computer('cmp1');
    const p = provider();
    await p.snapshots.take({ computerId: 'cmp1' });
    await fake.delete(machine.id);
    profilesOnMachine = ['bot-gone'];

    await p.snapshots.restore({ computerId: 'cmp1', keepProfiles: [] });
    expect([...fake.machines.values()]).toMatchObject([
      { name: sandboxNameFor('cmp1'), state: 'paused' },
    ]);
    expect(retired()).toEqual(['bot-gone']);
  });

  it('refuses to restore a computer that has no snapshot, leaving it as it was', async () => {
    const machine = computer('cmp1');
    await expect(
      provider().snapshots.restore({ computerId: 'cmp1', keepProfiles: [] }),
    ).rejects.toThrow(HarnessError);
    expect(fake.machines.get(machine.id)?.name).toBe(sandboxNameFor('cmp1'));
  });

  it('recreates a missing machine from its snapshot instead of refusing (amends D-031)', async () => {
    const machine = computer('cmp1');
    const p = provider();
    await p.snapshots.take({ computerId: 'cmp1' });
    await fake.delete(machine.id);
    profilesOnMachine = ['bot-a', 'bot-gone'];
    // The orchestrator asks this before it will start the computer at all.
    expect(await p.inspectWorkspace({ botId: 'cmp1' })).toMatchObject({ exists: true, ok: true });

    const session = await p.createSession({
      sessionId: 'cmp1',
      identity: 'cmp1',
      requireExistingWorkspace: true,
      snapshotProfiles: () => Promise.resolve(['bot-a']),
    });

    expect(session.containerId).not.toBe(machine.id);
    const recreated = [...fake.machines.values()];
    expect(recreated.map((m) => [m.name, m.state])).toEqual([[sandboxNameFor('cmp1'), 'running']]);
    expect(recreated[0]?.keptWhilePaused).toBe(true);
    expect(retired()).toEqual(['bot-gone']);
  });

  it('publishes a recreated machine only after profile retirement succeeds', async () => {
    const machine = computer('cmp1');
    const p = provider();
    await p.snapshots.take({ computerId: 'cmp1' });
    await fake.delete(machine.id);
    profilesOnMachine = ['bot-gone'];
    const exec = fake.execHandler;
    fake.execHandler = (call) => {
      if (call.argv[1] === '/opt/agent-bridge/profiles.py') {
        expect([...fake.machines.values()].map(({ name }) => name)).not.toContain(
          sandboxNameFor('cmp1'),
        );
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      return exec(call);
    };

    await expect(
      p.createSession({
        sessionId: 'cmp1',
        requireExistingWorkspace: true,
        snapshotProfiles: () => Promise.resolve([]),
      }),
    ).rejects.toThrow(/could not retire profile/);
    expect(await p.attachSession({ sessionId: 'cmp1' })).toBeNull();
    expect((await p.snapshots.inspect({ computerId: 'cmp1' })).snapshot).not.toBeNull();
  });

  it('still refuses a missing machine when there is no snapshot', async () => {
    expect(await provider().inspectWorkspace({ botId: 'cmp1' })).toEqual({ exists: false });
    await expect(
      provider().createSession({
        sessionId: 'cmp1',
        identity: 'cmp1',
        requireExistingWorkspace: true,
      }),
    ).rejects.toThrow(/workspace is missing/);
    expect(fake.machines.size).toBe(0);
  });

  it('deletes a computer’s snapshots when retention deletes the computer', async () => {
    computer('cmp1');
    const p = provider();
    await p.snapshots.take({ computerId: 'cmp1' });

    const outcome = await p.retainWorkspace({
      botId: 'cmp1',
      orphaned: true,
      now: Date.now(),
      retentionMs: 0,
    });

    expect(outcome).toBe('deleted');
    expect(fake.snapshots.size).toBe(0);
  });

  it('deletes the snapshot of a deleted computer whose machine was already gone', async () => {
    const machine = computer('cmp1');
    const p = provider();
    await p.snapshots.take({ computerId: 'cmp1' });
    await fake.delete(machine.id);

    expect(await p.listWorkspaces()).toEqual([{ botId: 'cmp1' }]);
    expect(
      await p.retainWorkspace({ botId: 'cmp1', orphaned: true, now: Date.now(), retentionMs: DAY }),
    ).toBe('absent');
    expect(fake.snapshots.size).toBe(0);
  });

  it('discards a restore’s backup at once if the orchestrator died before deleting it', async () => {
    const backup = fake.addMachine('crewaid-backup-old', {
      labels: {
        [COMPUTER_LABEL.key]: UPGRADE_BACKUP_ROLE,
        [UPGRADE_COMPUTER_LABEL]: 'cmp1',
        [ORPHANED_AT_LABEL]: String(Date.now()),
        [RESTORE_DISCARD_LABEL]: 'true',
      },
    });
    backup.name = `crewaid-backup-${backup.id}`;
    const promoted = computer('cmp1');
    promoted.labels = {
      ...promoted.labels,
      [UPGRADE_SOURCE_LABEL]: backup.id,
      [UPGRADE_READY_LABEL]: 'true',
    };
    backup.labels[UPGRADE_REPLACEMENT_LABEL] = promoted.id;

    await provider().retainWorkspace({
      botId: 'cmp1',
      orphaned: false,
      now: Date.now(),
      retentionMs: 30 * DAY,
    });

    expect(fake.machines.has(backup.id)).toBe(false);
    expect(fake.machines.has(promoted.id)).toBe(true);
  });
});
