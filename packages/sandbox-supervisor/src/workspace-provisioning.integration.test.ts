import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DockerSandboxProvider,
  SANDBOX_LABELS,
  SANDBOX_MANAGED_BY,
  SUPERVISOR_NETWORK_LABEL,
  SUPERVISOR_PATHS,
  SupervisorEngine,
  workspaceVolumeNameFor,
} from '@crewaid/sandbox-docker';
import { useTestSupervisor } from './testing.js';

const run = promisify(execFile);
// The provider reaches Docker only through a supervisor (D-200).
const supervisor = process.env['CREWAID_DOCKER_TESTS'] ? await useTestSupervisor() : null;
afterAll(async () => supervisor?.close());
// Real Docker/image required; CREWAID_DOCKER_TESTS is the existing opt-in gate (D-017).
describe.skipIf(!process.env['CREWAID_DOCKER_TESTS'])('workspace provisioning on Docker', () => {
  it('refuses to clear a marker through another deployment runtime mounting an owned volume', async () => {
    const botId = `it-foreign-writer-${randomUUID()}`;
    const volume = workspaceVolumeNameFor(botId);
    const image = process.env['SANDBOX_IMAGE'] ?? 'crewaid/sandbox:dev';
    const engine = new SupervisorEngine({
      url: process.env['SANDBOX_SUPERVISOR_URL']!,
      secret: process.env['SANDBOX_SUPERVISOR_SECRET']!,
    });
    let id: string | undefined;
    try {
      await engine.createVolume({
        name: volume,
        labels: {
          [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY,
          [SANDBOX_LABELS.botId]: botId,
        },
      });
      id = (
        await run('docker', [
          'run',
          '-d',
          '--network',
          'none',
          '--label',
          `${SANDBOX_LABELS.managedBy}=${SANDBOX_MANAGED_BY}`,
          '--mount',
          `type=volume,source=${volume},target=/home/bot`,
          '--entrypoint',
          'sleep',
          image,
          '30',
        ])
      ).stdout.trim();
      await expect(engine.workspaceMarker(volume, image, Date.now(), true)).rejects.toThrow(
        'unrelated runtime',
      );
      const inspected = JSON.parse((await run('docker', ['inspect', id])).stdout);
      expect(inspected[0].State.Running).toBe(true);
    } finally {
      if (id !== undefined) await run('docker', ['rm', '-f', id]);
      await run('docker', ['volume', 'rm', volume]);
    }
  }, 30_000);

  it('cannot inventory or mutate another deployment on the same daemon', async () => {
    const botId = `it-foreign-deployment-${randomUUID()}`;
    const volume = workspaceVolumeNameFor(botId);
    const image = process.env['SANDBOX_IMAGE'] ?? 'crewaid/sandbox:dev';
    const engine = new SupervisorEngine({
      url: process.env['SANDBOX_SUPERVISOR_URL']!,
      secret: process.env['SANDBOX_SUPERVISOR_SECRET']!,
    });
    let id: string | undefined;
    try {
      await run('docker', [
        'volume',
        'create',
        '--label',
        `${SANDBOX_LABELS.managedBy}=${SANDBOX_MANAGED_BY}`,
        '--label',
        `${SANDBOX_LABELS.botId}=${botId}`,
        '--label',
        `${SUPERVISOR_NETWORK_LABEL}=another-deployment`,
        volume,
      ]);
      id = (
        await run('docker', [
          'create',
          '--network',
          'none',
          '--label',
          `${SANDBOX_LABELS.managedBy}=${SANDBOX_MANAGED_BY}`,
          '--label',
          `${SANDBOX_LABELS.sessionId}=${botId}`,
          '--mount',
          `type=volume,source=${volume},target=/home/bot`,
          image,
          'true',
        ])
      ).stdout.trim();
      expect(await engine.findById(id)).toBeNull();
      expect((await engine.listWorkspaceVolumes()).some((entry) => entry.name === volume)).toBe(
        false,
      );
      await expect(engine.call(SUPERVISOR_PATHS.stop, { id })).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(engine.removeWorkspaceVolume(volume)).rejects.toMatchObject({ statusCode: 403 });
      await expect(engine.workspaceMarker(volume, image, Date.now(), false)).rejects.toMatchObject({
        statusCode: 403,
      });
      expect((await run('docker', ['inspect', id])).stdout).toContain(id);
      expect((await run('docker', ['volume', 'inspect', volume])).stdout).toContain(volume);
    } finally {
      if (id !== undefined) await run('docker', ['rm', '-f', id]);
      await run('docker', ['volume', 'rm', volume]);
    }
  }, 30_000);

  it('queues profile deletion in a workspace with no running desktop', async () => {
    const computerId = `it-retire-${randomUUID()}`;
    const volume = workspaceVolumeNameFor(computerId);
    const image = process.env['SANDBOX_IMAGE'] ?? 'crewaid/sandbox:dev';
    const provider = new DockerSandboxProvider({ image });
    const inspect = (program: string) =>
      run('docker', [
        'run',
        '--rm',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--read-only',
        '--user',
        'bot',
        '--mount',
        `type=volume,source=${volume},target=/home/bot`,
        '--entrypoint',
        'python3',
        image,
        '-c',
        program,
      ]);
    try {
      await provider.provisionWorkspace({ botId: computerId });
      await inspect(
        "from pathlib import Path; p=Path('/home/bot/.chrome'); (p/'bot-a').mkdir(); (p/'bot-b').mkdir(); (p/'bot-b'/'keep').write_text('saved')",
      );
      await provider.retireBotProfile({ computerId, botId: 'bot-a' });
      await provider.retireBotProfile({ computerId, botId: 'bot-a' });
      await inspect(
        "from pathlib import Path; p=Path('/home/bot'); assert (p/'.crewaid-deleted-profiles'/'bot-a').is_file(); assert (p/'.chrome'/'bot-a').is_dir()",
      );
      await inspect(
        "import sys; sys.path.insert(0, '/opt/agent-bridge'); from profiles import reap; from pathlib import Path; p=Path('/home/bot'); reap(p); assert not (p/'.chrome'/'bot-a').exists(); assert (p/'.chrome'/'bot-b'/'keep').read_text() == 'saved'",
      );
    } finally {
      await run('docker', ['volume', 'rm', volume]);
    }
  }, 120_000);

  it('seeds writable home without a desktop, then first boot preserves it and records history', async () => {
    const botId = `it-provision-${randomUUID()}`;
    const volume = workspaceVolumeNameFor(botId);
    const image = process.env['SANDBOX_IMAGE'] ?? 'crewaid/sandbox:dev';
    const provider = new DockerSandboxProvider({ image });
    try {
      await provider.provisionWorkspace({ botId });
      await provider.provisionWorkspace({ botId });
      expect(
        (await run('docker', ['ps', '-aq', '--filter', `volume=${volume}`])).stdout.trim(),
      ).toBe('');
      expect(await provider.inspectWorkspaceHistory({ botId })).toEqual({
        referenced: false,
        runtimeCreatedAt: null,
      });
      const result = await run('docker', [
        'run',
        '--rm',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--read-only',
        '--user',
        'bot',
        '--mount',
        `type=volume,source=${volume},target=/home/bot`,
        '--entrypoint',
        'python3',
        image,
        '-I',
        '-c',
        "from pathlib import Path; p=Path('/home/bot'); assert (p/'.bashrc').is_file(); assert (p/'.chrome').is_dir(); (p/'before-start.txt').write_text('saved before runtime'); print('seeded')",
      ]);
      expect(result.stdout.trim()).toBe('seeded');
      const session = await provider.createSession({
        sessionId: botId,
        identity: botId,
        requireExistingWorkspace: true,
      });
      await session.destroy();
      const history = await provider.inspectWorkspaceHistory({ botId });
      expect(history.referenced).toBe(false);
      expect(history.runtimeCreatedAt).toBeGreaterThan(0);
      const saved = await run('docker', [
        'run',
        '--rm',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--read-only',
        '--user',
        'bot',
        '--mount',
        `type=volume,source=${volume},target=/home/bot`,
        '--entrypoint',
        'python3',
        image,
        '-I',
        '-c',
        "from pathlib import Path; print(Path('/home/bot/before-start.txt').read_text())",
      ]);
      expect(saved.stdout.trim()).toBe('saved before runtime');
    } finally {
      await (await provider.attachSession({ sessionId: botId }))?.destroy();
      await run('docker', ['volume', 'rm', volume]);
    }
  }, 90_000);
});
