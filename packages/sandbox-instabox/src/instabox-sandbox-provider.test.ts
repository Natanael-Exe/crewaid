import {
  BROWSER_SANDBOX_SECCOMP,
  HarnessError,
  HarnessSandboxAuthenticationError,
  SANDBOX_PORTS,
  SEAT_CDP_PORTS,
  SEAT_PORTS,
} from '@crewaid/sandbox-core';
import { describe, expect, it, vi } from 'vitest';

import { FakeInstaboxApi } from './fake-instabox-api.js';
import { InstaboxApiError } from './instabox-client.js';
import {
  COMPUTER_LABEL,
  FIRST_START_LABEL,
  IMAGE_ID_LABEL,
  IMAGE_LABEL,
  ORPHANED_AT_LABEL,
  PORT_OFFSET,
  sandboxNameFor,
} from './instabox-labels.js';
import { InstaboxSandboxProvider } from './instabox-sandbox-provider.js';

const IMAGE = 'ghcr.io/natanael-exe/crewaid-sandbox:0.1.4';

function makeProvider(
  api: FakeInstaboxApi,
  overrides: {
    image?: string;
    vcpus?: number;
    memoryMiB?: number;
    bridgeProbe?: (url: string) => Promise<boolean>;
    log?: (msg: string) => void;
    readyTimeoutMs?: number;
    relaunchMs?: number;
  } = {},
): InstaboxSandboxProvider {
  return new InstaboxSandboxProvider({
    api,
    image: overrides.image ?? IMAGE,
    bridgeProbe: overrides.bridgeProbe ?? (() => Promise.resolve(true)),
    ...(overrides.vcpus !== undefined ? { vcpus: overrides.vcpus } : {}),
    ...(overrides.memoryMiB !== undefined ? { memoryMiB: overrides.memoryMiB } : {}),
    ...(overrides.log !== undefined ? { log: overrides.log } : {}),
    ...(overrides.readyTimeoutMs !== undefined ? { readyTimeoutMs: overrides.readyTimeoutMs } : {}),
    ...(overrides.relaunchMs !== undefined ? { relaunchMs: overrides.relaunchMs } : {}),
  });
}

describe('InstaboxSandboxProvider', () => {
  it('declares v1 contract: workspaceOnFirstStart=true, no screenAccess, no snapshots', () => {
    const provider = makeProvider(new FakeInstaboxApi());
    expect(provider.workspaceOnFirstStart).toBe(true);
    expect(provider.providerId).toBe('crewaid-instabox');
    expect('screenAccess' in provider).toBe(false);
    expect('snapshots' in provider).toBe(false);
  });

  it('createSession creates VM, writes browser seccomp & firewall, starts container with VM_RAM-1536, and forwards +10000 ports', async () => {
    const api = new FakeInstaboxApi();
    const onFirstCreate = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider(api);

    const session = await provider.createSession({ sessionId: 'comp1', onFirstCreate });

    expect(api.creates).toHaveLength(1);
    expect(api.creates[0]).toMatchObject({
      name: 'crewaid-comp1',
      template: 'agent-browser',
      autoSuspendMs: 0,
      metadata: {
        [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
        [ORPHANED_AT_LABEL]: 'none',
        [IMAGE_LABEL]: IMAGE,
      },
    });
    expect(api.creates[0]?.vcpus).toBeUndefined();
    expect(api.creates[0]?.memoryMiB).toBeUndefined();

    // Seccomp profile, firewall script, and systemd unit were uploaded before setup exec.
    const seccompWrite = api.writes.find((w) => w.path === '/tmp/crewaid-seccomp-browser.json');
    expect(seccompWrite).toBeDefined();
    expect(JSON.parse(seccompWrite!.content)).toEqual(BROWSER_SANDBOX_SECCOMP);
    expect(api.writes.some((w) => w.path === '/tmp/crewaid-firewall.sh')).toBe(true);
    expect(api.writes.some((w) => w.path === '/tmp/crewaid-firewall.service')).toBe(true);
    expect(
      api.writes.find((w) => w.path === '/tmp/crewaid-docker-firewall.conf')?.content,
    ).toContain('Requires=crewaid-firewall.service');

    // Container limit reserves 1536 MiB from the 8192 MiB VM -> 6656 MiB.
    const containerExec = api.execs.find((e) => e.envs?.['CREWAID_IMAGE'] === IMAGE);
    expect(containerExec?.envs?.['CREWAID_CONTAINER_MEM_MIB']).toBe('6656');

    // Metadata updated with pulled image ID.
    const machine = api.machines.get(session.containerId);
    expect(machine?.metadata[IMAGE_ID_LABEL]).toBe(api.ensureResult.imageId);

    // Offset port forwarding: container port 7070 -> VM loopback 17070, seat 1 RFB 5901 -> 15901, CDP 9301 -> 19301.
    await session.getPortEndpoint({ port: SEAT_PORTS[0]! });
    await session.getPortEndpoint({ port: SEAT_CDP_PORTS[0]! });
    expect(api.tunnels).toHaveLength(1);
    expect(api.tunnels[0]!.tunnel.forwardedHostPorts).toContain(SANDBOX_PORTS.bridge + PORT_OFFSET);
    expect(api.tunnels[0]!.tunnel.forwardedHostPorts).toContain(SEAT_PORTS[0]! + PORT_OFFSET);
    expect(api.tunnels[0]!.tunnel.forwardedHostPorts).toContain(SEAT_CDP_PORTS[0]! + PORT_OFFSET);
    expect(onFirstCreate).toHaveBeenCalledTimes(1);
  });

  it('createSession deletes fresh VM on setup failure and enforces D-031 / duplicate / identity guards', async () => {
    const api = new FakeInstaboxApi();
    const provider = makeProvider(api);

    await expect(provider.createSession({ sessionId: 'c1', identity: 'other' })).rejects.toThrow(
      'asked for identity other',
    );

    await expect(
      provider.createSession({ sessionId: 'c1', requireExistingWorkspace: true }),
    ).rejects.toThrow('storage is not recreated automatically');

    api.execHandler = () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'iptables failed',
      timedOut: false,
    });
    await expect(provider.createSession({ sessionId: 'c2' })).rejects.toThrow(
      'Failed to configure Instabox VM firewall',
    );
    expect(api.machines.size).toBe(0);
    expect(api.events.some((e) => e.startsWith('delete:'))).toBe(true);

    api.execHandler = null;
    api.seed({
      id: 'm_existing',
      name: sandboxNameFor('c3'),
      metadata: { [COMPUTER_LABEL.key]: COMPUTER_LABEL.value },
    });
    await expect(provider.createSession({ sessionId: 'c3' })).rejects.toThrow(
      'Use resumeSession() to reattach',
    );
  });

  it('resumeSession from suspended pulls the tag again and keeps the live container when nothing changed', async () => {
    const api = new FakeInstaboxApi();
    api.seed({
      id: 'm_1',
      name: sandboxNameFor('c1'),
      state: 'suspended',
      metadata: {
        [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
        [FIRST_START_LABEL]: '1000',
        [ORPHANED_AT_LABEL]: '2000',
        [IMAGE_LABEL]: IMAGE,
        [IMAGE_ID_LABEL]: 'sha256:same',
      },
    });
    api.ensureResult = { imageId: 'sha256:same', recreated: false, skippedUpgrade: null };
    const provider = makeProvider(api);

    await provider.resumeSession({ sessionId: 'c1' });

    expect(api.events).toContain('resume:m_1');
    // A paused VM keeps its firewall in memory: no host setup is re-sent.
    expect(api.writes).toHaveLength(0);
    // One check of the tag, in follow mode; the script keeps the container when the image is the same.
    expect(api.execs).toHaveLength(1);
    expect(api.execs[0]?.envs?.['CREWAID_ENSURE_MODE']).toBe('follow');
    expect(api.machines.get('m_1')?.metadata[IMAGE_ID_LABEL]).toBe('sha256:same');
    // Orphan clock cleared on resume.
    expect(api.machines.get('m_1')?.metadata[ORPHANED_AT_LABEL]).toBe('none');
  });

  it('follows a moving tag such as :latest: same name, new image, new image ID recorded', async () => {
    const latest = 'ghcr.io/natanael-exe/crewaid-sandbox:latest';
    const api = new FakeInstaboxApi();
    api.seed({
      id: 'm_1',
      name: sandboxNameFor('c1'),
      state: 'suspended',
      metadata: {
        [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
        [FIRST_START_LABEL]: '1000',
        [ORPHANED_AT_LABEL]: 'none',
        [IMAGE_LABEL]: latest,
        [IMAGE_ID_LABEL]: 'sha256:release-1',
      },
    });
    // The release moved `latest`; the in-VM pull sees a different image and replaces the container.
    api.ensureResult = { imageId: 'sha256:release-2', recreated: true, skippedUpgrade: null };
    const provider = makeProvider(api, { image: latest });

    await provider.resumeSession({ sessionId: 'c1' });

    const ensureCall = api.execs.find((e) => e.envs?.['CREWAID_IMAGE'] === latest);
    expect(ensureCall?.envs?.['CREWAID_ENSURE_MODE']).toBe('follow');
    expect(api.machines.get('m_1')?.metadata[IMAGE_ID_LABEL]).toBe('sha256:release-2');
    expect(api.machines.get('m_1')?.metadata[IMAGE_LABEL]).toBe(latest);
  });

  it('resumeSession moves to a newly configured image, and keeps the current one when disk or registry stop the pull', async () => {
    const newImage = 'ghcr.io/natanael-exe/crewaid-sandbox:0.1.5';
    const api = new FakeInstaboxApi();
    api.seed({
      id: 'm_1',
      name: sandboxNameFor('c1'),
      state: 'suspended',
      metadata: {
        [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
        [FIRST_START_LABEL]: '1000',
        [ORPHANED_AT_LABEL]: 'none',
        [IMAGE_LABEL]: IMAGE,
      },
    });
    const logs: string[] = [];
    const provider = makeProvider(api, { image: newImage, log: (m) => logs.push(m) });

    await provider.resumeSession({ sessionId: 'c1' });
    const ensureCall = api.execs.find((e) => e.envs?.['CREWAID_IMAGE'] === newImage);
    expect(ensureCall?.envs?.['CREWAID_ENSURE_MODE']).toBe('follow');
    expect(api.machines.get('m_1')?.metadata[IMAGE_LABEL]).toBe(newImage);
    expect(logs).toHaveLength(0);

    // Low disk: the computer still starts, on its current image, and says why.
    const newerImage = 'ghcr.io/natanael-exe/crewaid-sandbox:0.1.6';
    api.machines.get('m_1')!.state = 'suspended';
    api.ensureResult = { imageId: 'sha256:old', recreated: false, skippedUpgrade: 'disk' };
    await makeProvider(api, { image: newerImage, log: (m) => logs.push(m) }).resumeSession({
      sessionId: 'c1',
    });
    expect(logs.some((m) => m.includes('less than 2 GiB free'))).toBe(true);
    expect(api.machines.get('m_1')?.metadata[IMAGE_LABEL]).toBe(newImage);

    // Registry unreachable: same outcome, a different reason.
    api.machines.get('m_1')!.state = 'suspended';
    api.ensureResult = { imageId: 'sha256:old', recreated: false, skippedUpgrade: 'pull' };
    await makeProvider(api, { image: newerImage, log: (m) => logs.push(m) }).resumeSession({
      sessionId: 'c1',
    });
    expect(logs.some((m) => m.includes('could not be pulled'))).toBe(true);
    expect(api.machines.get('m_1')?.metadata[IMAGE_LABEL]).toBe(newImage);
  });

  it('recovering an unhealthy bridge restarts the container but never swaps its image', async () => {
    const api = new FakeInstaboxApi();
    api.seed({
      id: 'm_1',
      name: sandboxNameFor('c1'),
      state: 'running',
      metadata: {
        [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
        [FIRST_START_LABEL]: '1000',
        [ORPHANED_AT_LABEL]: 'none',
        [IMAGE_LABEL]: IMAGE,
      },
    });
    let probes = 0;
    const provider = makeProvider(api, {
      // A configured image newer than the running one must not be applied here.
      image: 'ghcr.io/natanael-exe/crewaid-sandbox:0.9.0',
      relaunchMs: 0,
      bridgeProbe: () => Promise.resolve((probes += 1) > 1),
    });

    await provider.resumeSession({ sessionId: 'c1' });

    const ensures = api.execs.filter((e) => e.envs?.['CREWAID_ENSURE_MODE'] !== undefined);
    expect(ensures.length).toBeGreaterThan(0);
    expect(ensures.every((e) => e.envs?.['CREWAID_ENSURE_MODE'] === 'keep')).toBe(true);
  });

  it('resumeSession from stopped re-verifies host setup and container; never recreates while already running', async () => {
    const api = new FakeInstaboxApi();
    api.seed({
      id: 'm_1',
      name: sandboxNameFor('c1'),
      state: 'stopped',
      metadata: {
        [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
        [FIRST_START_LABEL]: '1000',
        [ORPHANED_AT_LABEL]: 'none',
        [IMAGE_LABEL]: IMAGE,
      },
    });
    const provider = makeProvider(api);

    await provider.resumeSession({ sessionId: 'c1' });
    expect(api.events).toContain('resume:m_1');
    expect(api.writes.some((w) => w.path === '/tmp/crewaid-firewall.sh')).toBe(true);
    expect(api.execs.some((e) => e.envs?.['CREWAID_IMAGE'] === IMAGE)).toBe(true);

    // Already running with a newer configured image -> must NOT recreate underneath a live session.
    const execCountBefore = api.execs.length;
    const providerNewer = makeProvider(api, {
      image: 'ghcr.io/natanael-exe/crewaid-sandbox:0.2.0',
    });
    await providerNewer.resumeSession({ sessionId: 'c1' });
    expect(api.execs.length).toBe(execCountBefore);
  });

  it('shares one SSH tunnel across resumeSession/attachSession, reconnects on drop, and closes tunnel before pausing on stop()', async () => {
    const api = new FakeInstaboxApi();
    api.seed({
      id: 'm_1',
      name: sandboxNameFor('c1'),
      state: 'running',
      metadata: {
        [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
        [FIRST_START_LABEL]: '1000',
        [IMAGE_LABEL]: IMAGE,
      },
    });
    const provider = makeProvider(api);

    const resumed = await provider.resumeSession({ sessionId: 'c1' });
    const attached = await provider.attachSession({ sessionId: 'c1' });
    expect(attached).not.toBeNull();

    const ep1 = await resumed.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
    const ep2 = await attached!.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
    expect(ep1).toEqual(ep2);
    expect(api.tunnels).toHaveLength(1);

    // Unexpected SSH drop triggers transparent reconnect on next endpoint request.
    api.tunnels[0]!.tunnel.drop();
    await Promise.resolve();
    const ep3 = await resumed.getPortEndpoint({ port: SANDBOX_PORTS.bridge });
    expect(api.tunnels).toHaveLength(2);
    expect(ep3.url).not.toBe(ep1.url);

    // stop() closes the tunnel BEFORE pausing the VM, and preserves the VM (never deletes).
    const activeTunnel = api.tunnels[1]!.tunnel;
    const pauseEventsBefore = api.events.length;
    await attached!.stop();
    expect(activeTunnel.isClosed).toBe(true);
    expect(api.machines.get('m_1')?.state).toBe('suspended');
    expect(api.events.slice(pauseEventsBefore)).toContain('pause:m_1');
    expect(api.events.some((e) => e.startsWith('delete:'))).toBe(false);
  });

  it('attachSession returns null for absent computers and never wakes a suspended VM', async () => {
    const api = new FakeInstaboxApi();
    api.seed({
      id: 'm_1',
      name: sandboxNameFor('c1'),
      state: 'suspended',
      metadata: { [COMPUTER_LABEL.key]: COMPUTER_LABEL.value },
    });
    const provider = makeProvider(api);

    expect(await provider.attachSession({ sessionId: 'missing' })).toBeNull();
    const attached = await provider.attachSession({ sessionId: 'c1' });
    expect(attached).not.toBeNull();
    expect(api.machines.get('m_1')?.state).toBe('suspended');
    expect(api.events.filter((e) => e.startsWith('resume:'))).toHaveLength(0);
  });

  it('checkHealth reports non-running states, cooldowns, and bridge failures without throwing', async () => {
    const api = new FakeInstaboxApi();
    let bridgeOk = true;
    const provider = makeProvider(api, { bridgeProbe: () => Promise.resolve(bridgeOk) });

    expect(await provider.checkHealth({ sessionId: 'missing' })).toMatchObject({ ok: false });

    api.seed({
      id: 'm_1',
      name: sandboxNameFor('c1'),
      state: 'suspended',
      cooldownUntil: '2026-11-22T20:00:00Z',
      metadata: { [COMPUTER_LABEL.key]: COMPUTER_LABEL.value },
    });
    const pausedHealth = await provider.checkHealth({ sessionId: 'c1' });
    expect(pausedHealth.ok).toBe(false);
    if (!pausedHealth.ok) {
      expect(pausedHealth.reason).toContain('cooldown until 2026-11-22T20:00:00Z');
    }

    api.machines.get('m_1')!.state = 'running';
    expect(await provider.checkHealth({ sessionId: 'c1' })).toEqual({ ok: true });

    bridgeOk = false;
    expect(await provider.checkHealth({ sessionId: 'c1' })).toMatchObject({ ok: false });
  });

  it('reads a known computer by ID on hot paths instead of listing the account', async () => {
    const api = new FakeInstaboxApi();
    const provider = makeProvider(api);
    // Unrelated VMs on the same account must never be paged through per check.
    api.seed({ id: 'm_other', name: 'someone-elses-box', metadata: {} });

    await provider.createSession({ sessionId: 'c1' });
    const afterCreate = { ...api.lookups };
    for (let i = 0; i < 5; i += 1) {
      expect(await provider.checkHealth({ sessionId: 'c1' })).toEqual({ ok: true });
    }
    expect(await provider.attachSession({ sessionId: 'c1' })).not.toBeNull();
    expect(api.lookups.list).toBe(afterCreate.list);
    expect(api.lookups.findByName).toBe(afterCreate.findByName);
    expect(api.lookups.get).toBeGreaterThan(afterCreate.get);

    // A computer first seen by this process costs one filtered list, then reads by ID.
    api.seed({
      id: 'm_2',
      name: sandboxNameFor('c2'),
      metadata: { [COMPUTER_LABEL.key]: COMPUTER_LABEL.value },
    });
    const beforeC2 = api.lookups.list;
    await provider.checkHealth({ sessionId: 'c2' });
    await provider.checkHealth({ sessionId: 'c2' });
    expect(api.lookups.list).toBe(beforeC2 + 1);

    // A VM deleted behind the provider's back is noticed, not served from memory.
    api.machines.delete('m_2');
    expect(await provider.checkHealth({ sessionId: 'c2' })).toMatchObject({ ok: false });
    expect(api.lookups.list).toBe(beforeC2 + 2);
  });

  it('retainWorkspace manages orphan clock purely via metadata and never wakes a paused VM', async () => {
    const api = new FakeInstaboxApi();
    api.seed({
      id: 'm_1',
      name: sandboxNameFor('c1'),
      state: 'suspended',
      metadata: {
        [COMPUTER_LABEL.key]: COMPUTER_LABEL.value,
        [FIRST_START_LABEL]: '1000',
        [ORPHANED_AT_LABEL]: 'none',
      },
    });
    const provider = makeProvider(api);

    expect(
      await provider.retainWorkspace({
        botId: 'absent',
        orphaned: true,
        now: 5000,
        retentionMs: 10_000,
      }),
    ).toBe('absent');

    // First orphan sight stamps the clock without waking.
    expect(
      await provider.retainWorkspace({
        botId: 'c1',
        orphaned: true,
        now: 5000,
        retentionMs: 10_000,
      }),
    ).toBe('retained');
    expect(api.machines.get('m_1')?.metadata[ORPHANED_AT_LABEL]).toBe('5000');
    expect(api.machines.get('m_1')?.state).toBe('suspended');

    // Still inside retention window.
    expect(
      await provider.retainWorkspace({
        botId: 'c1',
        orphaned: true,
        now: 14_999,
        retentionMs: 10_000,
      }),
    ).toBe('retained');

    // Restored computer clears its clock.
    expect(
      await provider.retainWorkspace({
        botId: 'c1',
        orphaned: false,
        now: 15_000,
        retentionMs: 10_000,
      }),
    ).toBe('retained');
    expect(api.machines.get('m_1')?.metadata[ORPHANED_AT_LABEL]).toBe('none');

    // Re-orphaned and expired -> deleted.
    await provider.retainWorkspace({ botId: 'c1', orphaned: true, now: 20_000, retentionMs: 5000 });
    expect(
      await provider.retainWorkspace({
        botId: 'c1',
        orphaned: true,
        now: 25_000,
        retentionMs: 5000,
      }),
    ).toBe('deleted');
    expect(api.machines.has('m_1')).toBe(false);
    expect(api.events.filter((e) => e.startsWith('resume:'))).toHaveLength(0);
  });

  it('removeManagedSession pauses rather than deleting, and refuses non-Crewaid VMs', async () => {
    const api = new FakeInstaboxApi();
    api.seed({
      id: 'm_1',
      name: sandboxNameFor('c1'),
      state: 'running',
      metadata: { [COMPUTER_LABEL.key]: COMPUTER_LABEL.value },
    });
    api.seed({
      id: 'm_personal',
      name: 'my-personal-box',
      state: 'running',
      metadata: {},
    });
    const provider = makeProvider(api);

    expect(await provider.listManagedSessions()).toEqual([
      {
        containerId: 'm_1',
        sessionId: 'c1',
        botId: 'c1',
        running: true,
        workspace: { ok: true, volumeName: 'm_1' },
      },
    ]);

    await provider.removeManagedSession({ containerId: 'm_1' });
    expect(api.machines.get('m_1')?.state).toBe('suspended');
    expect(api.machines.has('m_1')).toBe(true);

    await expect(provider.removeManagedSession({ containerId: 'm_personal' })).rejects.toThrow(
      'is not a Crewaid computer',
    );
  });

  it('retireBotProfile retires profiles and restores suspended/stopped VMs to their prior state', async () => {
    const api = new FakeInstaboxApi();
    api.seed({
      id: 'm_susp',
      name: sandboxNameFor('c1'),
      state: 'suspended',
      metadata: { [COMPUTER_LABEL.key]: COMPUTER_LABEL.value, [IMAGE_LABEL]: IMAGE },
    });
    api.seed({
      id: 'm_stop',
      name: sandboxNameFor('c2'),
      state: 'stopped',
      metadata: { [COMPUTER_LABEL.key]: COMPUTER_LABEL.value, [IMAGE_LABEL]: IMAGE },
    });
    const provider = makeProvider(api);

    await expect(provider.retireBotProfile({ computerId: 'c1', botId: 'Default' })).rejects.toThrow(
      'Invalid bot profile',
    );

    await provider.retireBotProfile({ computerId: 'c1', botId: 'bot_1' });
    expect(api.machines.get('m_susp')?.state).toBe('suspended');
    expect(
      api.execs.some((e) => e.machineId === 'm_susp' && e.envs?.['CREWAID_BOT_ID'] === 'bot_1'),
    ).toBe(true);

    await provider.retireBotProfile({ computerId: 'c2', botId: 'bot_2' });
    expect(api.machines.get('m_stop')?.state).toBe('stopped');
    expect(
      api.execs.some((e) => e.machineId === 'm_stop' && e.envs?.['CREWAID_BOT_ID'] === 'bot_2'),
    ).toBe(true);
  });

  it('maps 401/403 auth, 409 machine_cooldown, and 429 quota_exceeded into typed Harness errors', async () => {
    const api = new FakeInstaboxApi();
    const provider = makeProvider(api);

    api.nextError = new InstaboxApiError(401, 'unauthorized', 'invalid key', {
      unauthorized: true,
    });
    await expect(provider.listWorkspaces()).rejects.toBeInstanceOf(
      HarnessSandboxAuthenticationError,
    );

    api.nextError = new InstaboxApiError(409, 'machine_cooldown', 'cooling down until 20:00Z', {
      unauthorized: false,
      quotaExceeded: false,
    });
    await expect(provider.createSession({ sessionId: 'c1' })).rejects.toThrow(
      /Free-plan continuous run limit/,
    );

    api.nextError = new InstaboxApiError(429, 'quota_exceeded', 'max 1 sandbox on Free plan', {
      unauthorized: false,
      quotaExceeded: true,
    });
    const err = await provider.createSession({ sessionId: 'c1' }).catch((e: unknown) => e);
    expect(HarnessError.isInstance(err)).toBe(true);
    expect(err instanceof HarnessSandboxAuthenticationError).toBe(false);
    expect((err as Error).message).toContain('quota_exceeded');
  });
});
