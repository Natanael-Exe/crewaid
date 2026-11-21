import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeRuntime, type FakeMachine } from './fake-runtime-api.js';
import { RuntimeImageMigration } from './runtime-image-migration.js';
import { RuntimeSandboxProvider, RUNTIME_START_COMMAND } from './runtime-sandbox-provider.js';
import {
  COMPUTER_LABEL,
  FIRST_START_LABEL,
  IMAGE_LABEL,
  IMAGE_REFUSED_LABEL,
  IMAGE_REFUSED_REASON_LABEL,
  ORPHANED_AT_LABEL,
  UPGRADE_BACKUP_ROLE,
  UPGRADE_COMPUTER_LABEL,
  UPGRADE_READY_LABEL,
  UPGRADE_SOURCE_LABEL,
  UPGRADE_STAGE_ROLE,
  sandboxNameFor,
} from './runtime-labels.js';

const image = { id: 'new-image', startArgv: [RUNTIME_START_COMMAND] };
let api: FakeRuntime;
let source: FakeMachine;
const ready = vi.fn<() => Promise<void>>();
const migration = () => new RuntimeImageMigration(api, ready);
const provider = () =>
  new RuntimeSandboxProvider({
    api,
    image: 'crewaid-sandbox:latest',
    bridgeProbe: () => Promise.resolve(true),
    log: () => undefined,
  });

beforeEach(() => {
  api = new FakeRuntime();
  api.images.set('crewaid-sandbox:latest', image);
  source = api.addMachine(sandboxNameFor('computer-1'), {
    imageId: 'old-image',
    labels: {
      [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
      [IMAGE_LABEL]: 'old-image',
      [FIRST_START_LABEL]: '123456',
      [ORPHANED_AT_LABEL]: 'none',
    },
  });
  source.vcpu = 2;
  source.memoryMiB = 4096;
  source.files.set('/home/bot/.chrome/Profile/Cookies', 'signed-in-profile');
  source.files.set('/workspace/project/work.txt', 'saved-work');
  ready.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await api.close();
});

describe('upgrades across Runtime servers', () => {
  it('preserves the logical computer, home, workspace, first-start history and machine size', async () => {
    const result = await migration().migrate(source, image, 'computer-1');
    const destination = api.machines.get(result.id);
    expect(result.id).not.toBe(source.id);
    expect(result.name).toBe(sandboxNameFor('computer-1'));
    expect(destination?.files).toEqual(source.files);
    expect(result).toMatchObject({ vcpu: 2, memoryMiB: 4096, diskMiB: 20480 });
    expect(result.labels).toMatchObject({
      [IMAGE_LABEL]: image.id,
      [FIRST_START_LABEL]: '123456',
      [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
    });
    expect(source.state).toBe('paused');
    expect(source.labels[COMPUTER_LABEL.key]).toBe(UPGRADE_BACKUP_ROLE);
    expect(api.machines.has(source.id)).toBe(true);
    expect(ready).toHaveBeenCalledTimes(2);
    expect((await migration().computers()).map((row) => row.machine.id)).toEqual([result.id]);
  });

  it.each(['new refusal', 'legacy refusal', 'saved host refusal'])(
    'upgrades after a %s through the provider',
    async (kind) => {
      api.refuseSwitchWith = 'image_on_another_host';
      if (kind !== 'new refusal') source.labels[IMAGE_REFUSED_LABEL] = image.id;
      if (kind === 'saved host refusal')
        source.labels[IMAGE_REFUSED_REASON_LABEL] = 'image_on_another_host';
      const session = await provider().resumeSession({ sessionId: 'computer-1' });
      expect(session.id).toBe('computer-1');
      expect(session.containerId).not.toBe(source.id);
      expect(api.copies).toHaveLength(1);
      expect(api.machines.get(session.containerId)?.files).toEqual(source.files);
      const again = await provider().resumeSession({ sessionId: 'computer-1' });
      expect(again.containerId).toBe(session.containerId);
      expect(api.copies).toHaveLength(1);
    },
  );

  it('does not rename or delete the source when the transfer fails', async () => {
    api.failCopy = true;
    await expect(migration().migrate(source, image, 'computer-1')).rejects.toThrow(
      'archive was truncated',
    );
    expect(source.name).toBe(sandboxNameFor('computer-1'));
    expect(source.files.get('/home/bot/.chrome/Profile/Cookies')).toBe('signed-in-profile');
    expect(api.machines.size).toBe(1);
    expect(ready).not.toHaveBeenCalled();
  });

  it('keeps the source authoritative when the restored desktop never becomes ready', async () => {
    ready.mockRejectedValue(new Error('bridge failed'));
    await expect(migration().migrate(source, image, 'computer-1')).rejects.toThrow('bridge failed');
    expect(await migration().find('computer-1')).toMatchObject({ id: source.id });
    expect(api.machines.size).toBe(1);
  });

  it('recovers after a process dies between the source and destination renames', async () => {
    const rename = api.rename;
    vi.spyOn(api, 'rename').mockImplementation(async (id, name, labels) => {
      if (name === sandboxNameFor('computer-1')) throw new Error('controller disconnected');
      return rename(id, name, labels);
    });
    await expect(migration().migrate(source, image, 'computer-1')).rejects.toThrow(
      'controller disconnected',
    );
    expect(await api.findByName(sandboxNameFor('computer-1'))).toBeNull();
    expect(await migration().find('computer-1')).toMatchObject({
      labels: { [UPGRADE_READY_LABEL]: 'true' },
    });
    expect(await provider().inspectWorkspace({ botId: 'computer-1' })).toMatchObject({
      exists: true,
      ok: true,
    });
    expect(await provider().listManagedSessions()).toHaveLength(1);
    vi.restoreAllMocks();
    const resumed = await provider().resumeSession({ sessionId: 'computer-1' });
    expect(resumed.containerId).not.toBe(source.id);
    expect((await api.get(resumed.containerId))?.name).toBe(sandboxNameFor('computer-1'));
    expect(api.copies).toHaveLength(1);
  });

  it('recovers an acknowledged rename whose response was lost without copying again', async () => {
    const rename = api.rename;
    vi.spyOn(api, 'rename').mockImplementation(async (id, name, labels) => {
      await rename(id, name, labels);
      if (name === sandboxNameFor('computer-1')) throw new Error('response lost');
    });
    await expect(migration().migrate(source, image, 'computer-1')).rejects.toThrow('response lost');
    vi.restoreAllMocks();
    const resumed = await provider().resumeSession({ sessionId: 'computer-1' });
    expect(api.machines.get(resumed.containerId)?.files).toEqual(source.files);
    expect(api.copies).toHaveLength(1);
  });

  it('never adopts an unverified destination or replaces a saved workspace with an empty one', async () => {
    source.name = `crewaid-backup-${source.id}`;
    source.labels = {
      ...source.labels,
      [COMPUTER_LABEL.key]: UPGRADE_BACKUP_ROLE,
      [UPGRADE_COMPUTER_LABEL]: 'computer-1',
    };
    api.addMachine('crewaid-upgrade-incomplete', {
      labels: {
        [COMPUTER_LABEL.key]: UPGRADE_STAGE_ROLE,
        [UPGRADE_SOURCE_LABEL]: source.id,
        [UPGRADE_COMPUTER_LABEL]: 'computer-1',
        [UPGRADE_READY_LABEL]: 'false',
      },
    });
    await expect(provider().provisionWorkspace({ botId: 'computer-1' })).rejects.toThrow(
      'upgrade recovery is incomplete',
    );
    expect(api.calls).not.toContain('create');
  });

  it('retains paused backups for the workspace grace period and never deletes a woken backup', async () => {
    await migration().migrate(source, image, 'computer-1');
    const since = Number(source.labels[ORPHANED_AT_LABEL]);
    await migration().retainBackups('computer-1', since + 99, 100);
    expect(api.machines.has(source.id)).toBe(true);
    source.state = 'running';
    await migration().retainBackups('computer-1', since + 101, 100);
    expect(api.machines.has(source.id)).toBe(true);
    source.state = 'paused';
    await migration().retainBackups('computer-1', since + 101, 100);
    expect(api.machines.has(source.id)).toBe(false);
    expect(await migration().find('computer-1')).not.toBeNull();
  });
});
