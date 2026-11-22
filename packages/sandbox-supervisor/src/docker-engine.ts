/**
 * The sandbox supervisor's Docker adapter.
 *
 * PRD R2, as D-200 amends it: THIS IS THE ONLY FILE IN THE MONOREPO
 * PERMITTED TO IMPORT `dockerode`. The allowlist in `eslint.config.mjs` names
 * this exact path; `no-restricted-imports` fails the build anywhere else, and
 * `tools/guard-probes/r2-dockerode.probe.ts` proves the rule fires. If you need
 * container behaviour elsewhere, widen the supervisor's verbs — do not widen
 * the allowlist.
 *
 * It implements the same `ContainerEngine` port the provider is written
 * against, so the supervisor's server only has to decide whether a verb is
 * allowed before handing it here. Nothing in this file decides that: admission
 * is `admission.ts`, and this file trusts the spec it is given.
 *
 * Where the daemon lives is a config value, not a code path: dockerode reads
 * `DOCKER_HOST` and speaks a local socket, `tcp://` with TLS, or `ssh://`.
 */

import { PassThrough, Readable } from 'node:stream';
import { isIP } from 'node:net';

import Docker from 'dockerode';
import {
  BROWSER_SANDBOX_SECCOMP,
  HarnessError,
  RUNTIME_MARKER_PROGRAM,
  WORKSPACE_MARKER_PROGRAM,
  type ContainerExecSpec,
  type ContainerMount,
  type ContainerPortBinding,
  type ContainerProcess,
  type ContainerStatus,
  type SandboxContainer,
} from '@crewaid/sandbox-core';
import {
  SANDBOX_LABELS,
  SANDBOX_MANAGED_BY,
  SUPERVISOR_NETWORK_LABEL,
  type ContainerCreateSpec,
  type ContainerEngine,
  type ContainerLimits,
  type WorkspaceVolume,
} from '@crewaid/sandbox-docker';

/** The daemon named by `DOCKER_HOST`, or the local socket. */
export function createDockerEngine(options: {
  readonly publishOn: string;
  readonly connect: SandboxConnect;
  readonly network?: string;
}): DockerContainerEngine {
  return new DockerContainerEngine(
    new Docker(),
    options.publishOn,
    options.connect,
    options.network,
  );
}

/**
 * A Dokploy container reaches a port published on the host's private bridge
 * address. Local development keeps loopback. Reject a wildcard or public bind:
 * Docker's published ports bypass the assumption that an ordinary host INPUT
 * rule alone protects a container service.
 */
export function sandboxPublishAddress(raw: string | undefined): string {
  if (raw === undefined || raw === '') return '127.0.0.1';
  if (isIP(raw) !== 4) throw new Error('SANDBOX_PUBLISH_ON must be a private IPv4 address');
  const [first, second] = raw.split('.').map(Number);
  const privateAddress =
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    // RFC 6598 shared space: the address a Tailscale tunnel gives a sandbox
    // host when the orchestrator reaches it from another machine.
    (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
    first === 127;
  if (!privateAddress) throw new Error('SANDBOX_PUBLISH_ON must be a private IPv4 address');
  return raw;
}

export type SandboxConnect = 'published' | 'network';

/** `SANDBOX_CONNECT`, read at construction: a typo fails the boot rather than picking a mode. */
export function sandboxConnectMode(raw: string | undefined): SandboxConnect {
  const value = (raw ?? '').trim();
  if (value === '' || value === 'published') return 'published';
  if (value === 'network') return 'network';
  throw new Error(`SANDBOX_CONNECT must be "published" or "network", got ${JSON.stringify(value)}`);
}

/** Docker addresses ports as `<port>/<protocol>`; everything here is TCP. */
const DOCKER_TCP = '/tcp';
// Helpers never appear in the computer inventory a reconciler may remove.
const WORKSPACE_HELPER_OWNER = `${SANDBOX_MANAGED_BY}-helper`;

/**
 * A profile is sent as its JSON text: `docker run --security-opt seccomp=FILE`
 * is the CLI reading FILE, and the Engine API only ever sees the contents.
 */
export function securityOptions(limits: ContainerLimits): { SecurityOpt?: string[] } {
  const options = [
    ...(limits.noNewPrivileges ? ['no-new-privileges:true'] : []),
    ...(limits.allowBrowserSandbox ? [`seccomp=${JSON.stringify(BROWSER_SANDBOX_SECCOMP)}`] : []),
  ];
  return options.length === 0 ? {} : { SecurityOpt: options };
}

/**
 * The one modem method this file uses. dockerode types `modem` as `any`, which
 * would let unchecked member access spread from here through every exec call.
 * Narrowing it once, to exactly the signature we depend on, keeps the `any`
 * contained to a single line and makes an upstream signature change a type
 * error here rather than a runtime surprise in a file read.
 */
interface DockerModem {
  demuxStream(
    source: NodeJS.ReadableStream,
    stdout: NodeJS.WritableStream,
    stderr: NodeJS.WritableStream,
  ): void;
}

export class DockerContainerEngine implements ContainerEngine {
  async listWorkspaceVolumes(): Promise<readonly WorkspaceVolume[]> {
    // A process crash can bypass a helper's finally block. Reclaim only old,
    // explicitly labelled helpers, never their volumes or an active fresh call.
    const helpers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [
          'crewaid.workspaceRetentionHelper=true',
          `${SANDBOX_LABELS.managedBy}=${WORKSPACE_HELPER_OWNER}`,
        ],
      },
    });
    for (const helper of helpers) {
      if (
        this.network !== undefined &&
        helper.Labels[SUPERVISOR_NETWORK_LABEL] === this.network &&
        helper.Created * 1000 < Date.now() - 60_000
      ) {
        await this.docker.getContainer(helper.Id).remove({ force: true, v: false });
      }
    }
    const result = await this.docker.listVolumes({
      filters: { label: [`${SANDBOX_LABELS.managedBy}=${SANDBOX_MANAGED_BY}`] },
    });
    return (result.Volumes ?? []).map((volume) => ({
      name: volume.Name,
      labels: volume.Labels ?? {},
    }));
  }

  async removeWorkspaceVolume(name: string): Promise<void> {
    await this.docker.getVolume(name).remove({ force: false });
  }

  async retireBotProfile(name: string, image: string, botId: string): Promise<void> {
    // This helper writes only a tombstone, never Chrome's live files. It also
    // works while the desktop is stopped; no restart of sibling bots is needed.
    const helper = await this.docker.createContainer({
      Image: image,
      Labels: {
        'crewaid.workspaceRetentionHelper': 'true',
        [SANDBOX_LABELS.managedBy]: WORKSPACE_HELPER_OWNER,
        ...(this.network === undefined ? {} : { [SUPERVISOR_NETWORK_LABEL]: this.network }),
      },
      Entrypoint: ['python3', '/opt/agent-bridge/profiles.py'],
      Cmd: ['retire', botId],
      User: 'bot',
      NetworkDisabled: true,
      HostConfig: {
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Memory: 64 * 1024 ** 2,
        PidsLimit: 16,
        NanoCpus: 1e9,
        Binds: [],
        Mounts: [{ Type: 'volume', Source: name, Target: '/home/bot' }],
      },
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await helper.start();
      const result: unknown = await Promise.race([
        helper.wait(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Profile retirement timed out')), 5_000);
        }),
      ]);
      if (
        typeof result !== 'object' ||
        result === null ||
        !('StatusCode' in result) ||
        result.StatusCode !== 0
      ) {
        throw new Error('Could not persist profile retirement');
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await helper.remove({ force: true, v: false });
    }
  }

  async workspaceMarker(
    name: string,
    image: string,
    now: number,
    clear: boolean,
    history?: 'read' | 'write',
  ): Promise<number | null> {
    if (clear && history === undefined) {
      // A restored, running bot must lose an old orphan clock too. Use its
      // existing runtime rather than mounting a second writable container.
      for (const container of await this.listByVolume(name)) {
        const status = await container.inspect();
        if (!status.running) continue;
        if (
          status.labels[SANDBOX_LABELS.managedBy] !== SANDBOX_MANAGED_BY ||
          (this.network !== undefined && status.network !== this.network) ||
          !status.mounts.some((mount) => mount.volume === name && mount.path === '/home/bot')
        ) {
          throw new Error('Cannot clear retention marker through an unrelated runtime');
        }
        const process = await container.spawn({
          command: ['python3', '-I', '-c', WORKSPACE_MARKER_PROGRAM, String(now), 'clear'],
        });
        let timeout: NodeJS.Timeout | undefined;
        try {
          const result = await Promise.race([
            process.wait(),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('Workspace marker clear timed out')),
                5_000,
              );
            }),
          ]);
          if (result.exitCode !== 0) throw new Error('Workspace marker is unsafe or inaccessible');
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
          await process.kill();
        }
        return null;
      }
    }
    const helper = await this.docker.createContainer({
      Image: image,
      Labels: {
        'crewaid.workspaceRetentionHelper': 'true',
        [SANDBOX_LABELS.managedBy]: WORKSPACE_HELPER_OWNER,
        ...(this.network === undefined ? {} : { [SUPERVISOR_NETWORK_LABEL]: this.network }),
      },
      Entrypoint: [
        'python3',
        '-I',
        '-c',
        history === undefined ? WORKSPACE_MARKER_PROGRAM : RUNTIME_MARKER_PROGRAM,
      ],
      Cmd: [String(now), history ?? (clear ? 'clear' : 'mark')],
      User: 'bot',
      Tty: true,
      NetworkDisabled: true,
      HostConfig: {
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Memory: 64 * 1024 ** 2,
        PidsLimit: 16,
        NanoCpus: 1e9,
        Binds: [],
        Mounts: [{ Type: 'volume', Source: name, Target: '/home/bot' }],
      },
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await helper.start();
      const result: unknown = await Promise.race([
        helper.wait(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Workspace marker helper timed out')), 5_000);
        }),
      ]);
      if (
        typeof result !== 'object' ||
        result === null ||
        !('StatusCode' in result) ||
        result.StatusCode !== 0
      ) {
        throw new Error('Workspace marker is unsafe or inaccessible');
      }
      if (clear && history === undefined) return null;
      // A bare numeric log line is JSON and docker-modem parses it as a number.
      // Prefix the protocol, and validate the transport's actual runtime shape.
      const logs: unknown = await helper.logs({ stdout: true, stderr: false });
      const output = Buffer.isBuffer(logs)
        ? logs.toString('utf8')
        : typeof logs === 'string'
          ? logs
          : '';
      if (history === 'read' && output.trim() === 'crewaid-runtime:none') return null;
      const match = (
        history === undefined ? /^crewaid-retention:(\d+)$/ : /^crewaid-runtime:(\d+)$/
      ).exec(output.trim());
      const first = match === null ? NaN : Number(match[1]);
      if (!Number.isSafeInteger(first) || first <= 0 || first > now)
        throw new Error('Invalid workspace marker');
      return first;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await helper.remove({ force: true, v: false });
    }
  }
  constructor(
    private readonly docker: Docker,
    private readonly publishOn: string,
    private readonly connect: SandboxConnect = 'published',
    private readonly network?: string,
  ) {}

  async ensureNetwork(name: string): Promise<void> {
    const existing = await this.docker.listNetworks({ filters: { name: [name] } });
    // listNetworks matches names as substrings, so `agent-net` also returns
    // `agent-net-staging`. Creating a duplicate would be the louder failure.
    if (existing.some((network) => network.Name === name)) return;

    try {
      await this.docker.createNetwork({ Name: name, Driver: 'bridge' });
    } catch (error: unknown) {
      // Two sandboxes starting at once both see it missing and both create it.
      // The loser gets a 409, which means the network is there — the outcome
      // this method promises.
      if ((error as { statusCode?: number } | null)?.statusCode !== 409) throw error;
    }
  }

  async create(spec: ContainerCreateSpec): Promise<SandboxContainer> {
    const exposed: Record<string, Record<string, never>> = {};
    const bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
    for (const port of spec.publishPorts) {
      exposed[`${port}${DOCKER_TCP}`] = {};
      // An empty HostPort asks Docker for a free one. Fixed host ports would
      // collide the moment a second bot starts.
      bindings[`${port}${DOCKER_TCP}`] = [{ HostIp: this.publishOn, HostPort: '' }];
    }

    const container = await this.docker.createContainer({
      Image: spec.image,
      Env: [`SCREEN_WIDTH=${spec.screen.widthPx}`, `SCREEN_HEIGHT=${spec.screen.heightPx}`],
      name: spec.name,
      Labels: { ...spec.labels },
      ExposedPorts: exposed,
      HostConfig: {
        Memory: spec.limits.memoryBytes,
        MemorySwap: spec.limits.memorySwapBytes,
        NanoCpus: Math.round(spec.limits.cpus * 1e9),
        PidsLimit: spec.limits.pidsLimit,
        ...securityOptions(spec.limits),
        ...(spec.limits.dropAllCapabilities ? { CapDrop: ['ALL'] } : {}),
        NetworkMode: spec.network,
        Tmpfs: { '/dev/shm': `size=${spec.limits.shmSizeBytes}` },
        RestartPolicy: { Name: 'no' },
        // `network`: nothing is published; the orchestrator connects to the
        // container's own address on the sandbox bridge.
        PortBindings: this.connect === 'published' ? bindings : {},
        // R5, stated rather than assumed: no host filesystem reaches a bot.
        // `Binds` is the bind-mount channel and stays empty forever; durable
        // storage goes through `Mounts` as named volumes only.
        Binds: [],
        Mounts: spec.mounts.map((mount) => ({
          Type: 'volume' as const,
          Source: mount.volume,
          Target: mount.path,
          ReadOnly: false,
        })),
      },
    });

    return new DockerContainerHandle(container, this.connect);
  }

  async findByLabel(label: string, value: string): Promise<SandboxContainer | null> {
    const found = await this.docker.listContainers({
      all: true,
      filters: { label: [`${label}=${value}`] },
    });
    const first = found[0];
    if (first === undefined) return null;
    return new DockerContainerHandle(this.docker.getContainer(first.Id), this.connect);
  }

  async listByLabel(label: string, value: string): Promise<readonly SandboxContainer[]> {
    const found = await this.docker.listContainers({
      all: true,
      filters: { label: [`${label}=${value}`] },
    });
    return found.map(
      (container) =>
        new DockerContainerHandle(this.docker.getContainer(container.Id), this.connect),
    );
  }

  async listByVolume(volumeName: string): Promise<readonly SandboxContainer[]> {
    const found = await this.docker.listContainers({
      all: true,
      filters: { volume: [volumeName] },
    });
    return found.map(
      (container) =>
        new DockerContainerHandle(this.docker.getContainer(container.Id), this.connect),
    );
  }

  async findById(id: string): Promise<SandboxContainer | null> {
    const container = new DockerContainerHandle(this.docker.getContainer(id), this.connect);
    try {
      await container.inspect();
      return container;
    } catch (error: unknown) {
      if ((error as { statusCode?: number } | null)?.statusCode === 404) return null;
      throw error;
    }
  }

  async findVolume(name: string): Promise<WorkspaceVolume | null> {
    try {
      const volume = await this.docker.getVolume(name).inspect();
      return { name: volume.Name, labels: volume.Labels ?? {} };
    } catch (error: unknown) {
      // 404 is the answer "no such workspace", which every caller here handles.
      // Anything else is the daemon failing and must not read as "absent" —
      // that would turn a Docker hiccup into a brand-new empty desktop.
      if ((error as { statusCode?: number } | null)?.statusCode === 404) return null;
      throw error;
    }
  }

  async createVolume(spec: {
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
  }): Promise<WorkspaceVolume> {
    // Docker's volume create is idempotent on the name, so two starts racing
    // for a bot's first desktop both succeed and both get the same volume.
    await this.docker.createVolume({ Name: spec.name, Labels: { ...spec.labels } });

    // Read it back rather than trusting the return value, for two reasons and
    // one of them bites hard. dockerode resolves a Volume HANDLE here, not the
    // API response: its `Name` and `Labels` are undefined, and a mount built
    // from that undefined name does not fail — Docker reads a `Type: volume`
    // with no source as a request for an ANONYMOUS volume and cheerfully
    // creates one. The desktop then comes up on storage nothing will ever find
    // again, looking exactly like a working durable workspace. dockerode's
    // types do not catch it; the real-Docker test did.
    //
    // The second reason stands on its own: create is idempotent, so a volume
    // that already existed keeps ITS labels, not the ones just requested, and
    // those are the labels ownership is decided by.
    const created = await this.findVolume(spec.name);
    if (created === null) {
      throw new HarnessError({
        message: `workspace volume ${spec.name} did not exist immediately after being created`,
      });
    }
    return created;
  }
}

export class DockerContainerHandle implements SandboxContainer {
  constructor(
    private readonly container: Docker.Container,
    private readonly connect: SandboxConnect = 'published',
  ) {}

  get id(): string {
    return this.container.id;
  }

  async start(): Promise<void> {
    try {
      await this.container.start();
    } catch (error: unknown) {
      // 304 Not Modified: already started. The port's contract is the outcome.
      if ((error as { statusCode?: number } | null)?.statusCode !== 304) throw error;
    }
  }

  async stop(timeoutSeconds?: number): Promise<void> {
    try {
      await this.container.stop(timeoutSeconds === undefined ? {} : { t: timeoutSeconds });
    } catch (error: unknown) {
      const status = (error as { statusCode?: number } | null)?.statusCode;
      if (status !== 304 && status !== 404) throw error;
    }
  }

  async remove(): Promise<void> {
    try {
      // Runtime cleanup must never ask Docker to remove attached volumes.
      // Named volumes are not removed by `v: true` today, but relying on that
      // daemon distinction here would make the strongest rule implicit.
      await this.container.remove({ force: true, v: false });
    } catch (error: unknown) {
      if ((error as { statusCode?: number } | null)?.statusCode !== 404) throw error;
    }
  }

  async inspect(): Promise<ContainerStatus> {
    const info = await this.container.inspect();
    const portBindings: Record<number, ContainerPortBinding | undefined> = {};

    if (this.connect === 'network') {
      // Nothing is published: every exposed port is reached at the
      // container's own address on its one network, which the orchestrator
      // shares. No address yet means not running, and so no ports.
      const address = Object.values(info.NetworkSettings.Networks ?? {})[0]?.IPAddress ?? '';
      if (info.State.Running && address !== '') {
        for (const key of Object.keys(info.Config.ExposedPorts ?? {})) {
          const port = Number.parseInt(key, 10);
          if (!Number.isNaN(port)) portBindings[port] = { host: address, port };
        }
      }
    }

    for (const [key, value] of Object.entries(
      this.connect === 'published' ? (info.NetworkSettings.Ports ?? {}) : {},
    )) {
      const port = Number.parseInt(key, 10);
      const binding = value?.[0];
      if (Number.isNaN(port) || binding === undefined) continue;
      portBindings[port] = {
        // Docker reports a wildcard bind as 0.0.0.0; that is where it listens,
        // not an address anything can connect to.
        host: binding.HostIp === '0.0.0.0' || binding.HostIp === '' ? '127.0.0.1' : binding.HostIp,
        port: Number.parseInt(binding.HostPort, 10),
      };
    }

    // Volume mounts only. A bind mount cannot appear in `ContainerMount` by
    // construction, so one found here is dropped rather than reported as
    // durable storage — it would be an R5 violation, not a workspace.
    const mounts: ContainerMount[] = (info.Mounts ?? [])
      .filter((mount) => mount.Type === 'volume' && typeof mount.Name === 'string')
      .map((mount) => ({ volume: mount.Name as string, path: mount.Destination }));

    return {
      running: info.State.Running,
      ...(info.HostConfig.NetworkMode === undefined
        ? {}
        : { network: info.HostConfig.NetworkMode }),
      exitCode: info.State.Running ? null : info.State.ExitCode,
      portBindings,
      mounts,
      labels: info.Config.Labels ?? {},
    };
  }

  async spawn(spec: ContainerExecSpec): Promise<ContainerProcess> {
    const pidPath = `/tmp/crewaid-exec-${crypto.randomUUID()}.pid`;
    const exec = await this.container.exec({
      // Docker inspect reports a host PID. Record the namespace PID and give
      // the command its own process group so cancellation also reaches children.
      Cmd: [
        'setsid',
        '--wait',
        'sh',
        '-c',
        'echo $$ > "$1"; shift; exec "$@"',
        'crewaid-exec',
        pidPath,
        ...spec.command,
      ],
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: spec.stdin === true,
      // Tty false is load-bearing: with a TTY, Docker merges stdout and stderr
      // onto one unframed stream, and every file read here would come back with
      // stderr spliced into its bytes.
      Tty: false,
      ...(spec.workingDirectory !== undefined ? { WorkingDir: spec.workingDirectory } : {}),
      ...(spec.env !== undefined
        ? { Env: Object.entries(spec.env).map(([key, val]) => `${key}=${val}`) }
        : {}),
    });

    const stream = await exec.start({ hijack: true, stdin: spec.stdin === true });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const modem = this.container.modem as DockerModem;
    modem.demuxStream(stream, stdout, stderr);
    // demuxStream never ends the sinks it writes into, so both web streams
    // would stay open forever and every collect below would hang.
    stream.on('error', (error: Error) => {
      stdout.destroy(error);
      stderr.destroy(error);
    });
    stream.on('close', () => {
      stdout.end();
      stderr.end();
    });
    stream.on('end', () => {
      stdout.end();
      stderr.end();
    });

    return new DockerExecProcess(
      exec,
      stream,
      stdout,
      stderr,
      spec.stdin === true,
      this.container,
      pidPath,
    );
  }
}

class DockerExecProcess implements ContainerProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdin: WritableStream<Uint8Array> | null;

  #pid: number | undefined;
  readonly #completion: Promise<void>;

  constructor(
    private readonly exec: Docker.Exec,
    private readonly raw: NodeJS.ReadWriteStream,
    stdout: PassThrough,
    stderr: PassThrough,
    stdinRequested: boolean,
    private readonly container: Docker.Container,
    private readonly pidPath: string,
  ) {
    // Subscribe at spawn time: callers may consume output before calling wait.
    this.#completion = new Promise<void>((resolve, reject) => {
      raw.once('end', resolve);
      raw.once('close', resolve);
      raw.once('error', reject);
    });
    void this.#completion.catch(() => undefined);
    this.stdout = Readable.toWeb(stdout) as ReadableStream<Uint8Array>;
    this.stderr = Readable.toWeb(stderr) as ReadableStream<Uint8Array>;
    this.stdin = stdinRequested ? this.#writable() : null;
  }

  get pid(): number | undefined {
    return this.#pid;
  }

  #writable(): WritableStream<Uint8Array> {
    const raw = this.raw as unknown as {
      write(chunk: Uint8Array, cb: (error?: Error | null) => void): void;
      end(cb: () => void): void;
      destroy(): void;
    };
    return new WritableStream<Uint8Array>({
      write: (chunk) =>
        new Promise((resolve, reject) => {
          raw.write(chunk, (error) => (error ? reject(error) : resolve()));
        }),
      // Half-closing the hijacked connection is what delivers EOF to the
      // process. Without it `cat > file` never returns and wait never
      // resolves — the write appears to hang rather than fail.
      close: () => new Promise((resolve) => raw.end(resolve)),
      abort: () => raw.destroy(),
    });
  }

  async wait(): Promise<{ exitCode: number }> {
    await this.#completion;

    // The stream ending means the process closed its outputs, which happens a
    // beat before Docker records the exit code. Polling briefly is the
    // difference between the real code and a confident 0.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const info = await this.exec.inspect();
      this.#pid = info.Pid;
      if (!info.Running) {
        const cleanup = await this.container.exec({ Cmd: ['rm', '-f', this.pidPath] });
        await cleanup.start({});
        return { exitCode: info.ExitCode ?? 0 };
      }
      await delay(20);
    }
    throw new HarnessError({ message: 'exec did not report an exit code within 1s of closing' });
  }

  async kill(): Promise<void> {
    // Signal the namespace process group, never Docker inspect's host PID.
    const info = await this.exec.inspect().catch(() => null);
    if (info === null || !info.Running || info.Pid === 0) return;

    const killer = await this.container.exec({
      Cmd: [
        'sh',
        '-c',
        'for i in $(seq 1 100); do if [ -s "$1" ]; then /bin/kill -TERM -- "-$(cat "$1")"; exit; fi; sleep 0.01; done; exit 1',
        'crewaid-kill',
        this.pidPath,
      ],
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
    });
    await killer.start({});
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
