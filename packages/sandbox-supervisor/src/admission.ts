/**
 * What the supervisor will do, decided before anything reaches Docker.
 *
 * Every value that changes what a container can reach or consume is the
 * supervisor's own configuration, and a request can only match it or ask for
 * less. The provider still sends the full `ContainerCreateSpec` — it is the
 * same port it always spoke — but here the spec is a claim to check, not an
 * instruction to follow: a different image, network, port set, label, mount or
 * a looser limit is refused with the reason, and nothing is created.
 */

import { z } from 'zod';

import {
  SANDBOX_PORTS,
  SANDBOX_WORKING_DIRECTORY,
  SEAT_CDP_PORTS,
  SEAT_PORTS,
} from '@crewaid/sandbox-core';
import {
  SANDBOX_IDENTITY_LABEL,
  SANDBOX_LABELS,
  SANDBOX_MANAGED_BY,
  containerNameFor,
  readSandboxLimits,
  workspaceVolumeNameFor,
  MIN_SECRET_LENGTH,
  SUPERVISOR_NETWORK_LABEL,
  type ContainerCreateSpec,
  type ContainerLimits,
  type WorkspaceVolume,
} from '@crewaid/sandbox-docker';

import { sandboxConnectMode, sandboxPublishAddress, type SandboxConnect } from './docker-engine.js';

export interface SupervisorConfig {
  /** The one image a computer may run. A `@sha256:` reference is verified by the daemon. */
  readonly image: string;
  readonly network: string;
  /** The ceiling: a request may ask for these limits or tighter ones, never looser. */
  readonly limits: ContainerLimits;
  readonly publishOn: string;
  readonly connect: SandboxConnect;
  /** The current secret first, then the previous one while a rotation is under way. */
  readonly secrets: readonly string[];
  readonly host: string;
  readonly port: number;
}

export function readSupervisorConfig(env: NodeJS.ProcessEnv): SupervisorConfig {
  const secret = env['SANDBOX_SUPERVISOR_SECRET'] ?? '';
  const previous = env['SANDBOX_SUPERVISOR_SECRET_PREVIOUS'] ?? '';
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SANDBOX_SUPERVISOR_SECRET must be at least ${MIN_SECRET_LENGTH} characters ` +
        '(openssl rand -hex 32).',
    );
  }
  if (previous !== '' && previous.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SANDBOX_SUPERVISOR_SECRET_PREVIOUS must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  const port = Number(env['SANDBOX_SUPERVISOR_PORT'] ?? '7300');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SANDBOX_SUPERVISOR_PORT must be a TCP port');
  }
  return {
    image: env['SANDBOX_IMAGE'] || 'crewaid/sandbox:dev',
    network: env['SANDBOX_NETWORK'] || 'agent-net',
    limits: readSandboxLimits({ cpus: env['SANDBOX_CPUS'], memoryMiB: env['SANDBOX_MEMORY_MIB'] }),
    publishOn: sandboxPublishAddress(env['SANDBOX_PUBLISH_ON']),
    connect: sandboxConnectMode(env['SANDBOX_CONNECT']),
    secrets: previous === '' ? [secret] : [secret, previous],
    // Loopback unless the deployment says otherwise: the compose file binds
    // the project's private network, and nothing ever publishes this port.
    host: env['SANDBOX_SUPERVISOR_HOST'] || '127.0.0.1',
    port,
  };
}

/** A refusal the caller is told about. Nothing was changed when one is thrown. */
export class AdmissionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdmissionRefused';
  }
}

/** Every port a computer publishes, fixed by the image's own layout. */
export const COMPUTER_PORTS: readonly number[] = [
  SANDBOX_PORTS.rfb,
  SANDBOX_PORTS.cdp,
  SANDBOX_PORTS.bridge,
  ...SEAT_PORTS,
  ...SEAT_CDP_PORTS,
];

/** The names a caller may give: ids and session ids, never a path or a flag. */
const Name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const VolumeName = z.string().regex(/^crewaid-workspace-[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const ContainerId = z.string().regex(/^[0-9a-f]{12,64}$/);

const CreateSpec = z
  .object({
    image: z.string(),
    screen: z
      .object({
        widthPx: z.number().int().min(320).max(7680),
        heightPx: z.number().int().min(240).max(4320),
      })
      .strict(),
    name: z.string(),
    network: z.string(),
    publishPorts: z.array(z.number().int()),
    labels: z.record(z.string(), z.string()),
    limits: z
      .object({
        memoryBytes: z.number().int().positive(),
        memorySwapBytes: z.number().int().positive(),
        cpus: z.number().positive(),
        pidsLimit: z.number().int().positive(),
        noNewPrivileges: z.boolean(),
        dropAllCapabilities: z.boolean(),
        allowBrowserSandbox: z.boolean(),
        shmSizeBytes: z.number().int().positive(),
      })
      .strict(),
    mounts: z.array(z.object({ volume: z.string(), path: z.string() }).strict()),
  })
  .strict();

export const Requests = {
  ensureNetwork: z.object({ network: z.string() }).strict(),
  create: CreateSpec,
  container: z.object({ id: ContainerId }).strict(),
  stop: z
    .object({ id: ContainerId, timeoutSeconds: z.number().int().min(0).max(600).optional() })
    .strict(),
  byLabel: z.object({ label: z.string(), value: Name }).strict(),
  volume: z.object({ volume: VolumeName }).strict(),
  createVolume: z.object({ volume: VolumeName, labels: z.record(z.string(), z.string()) }).strict(),
  marker: z
    .object({
      volume: VolumeName,
      image: z.string(),
      now: z.number().int().positive(),
      clear: z.boolean(),
      history: z.enum(['read', 'write']).optional(),
    })
    .strict(),
  retire: z.object({ volume: VolumeName, image: z.string(), botId: Name }).strict(),
} as const;

/** The labels a lookup may filter on. Ownership is never something a caller filters away. */
const LOOKUP_LABELS = new Set<string>([
  SANDBOX_LABELS.sessionId,
  SANDBOX_LABELS.managedBy,
  SANDBOX_IDENTITY_LABEL,
]);

export function admitLookupLabel(label: string): void {
  if (!LOOKUP_LABELS.has(label)) throw new AdmissionRefused(`lookups by ${label} are not allowed`);
}

export function admitNetwork(config: SupervisorConfig, network: string): void {
  if (network !== config.network) {
    throw new AdmissionRefused(`network ${network} is not the sandbox network`);
  }
}

export function admitImage(config: SupervisorConfig, image: string): void {
  if (image !== config.image) throw new AdmissionRefused(`image ${image} is not the sandbox image`);
}

/** A workspace the supervisor created: in the namespace, and carrying its label. */
export function admitManagedVolume(
  volume: WorkspaceVolume | null,
  name: string,
  network: string,
): WorkspaceVolume {
  if (volume === null) throw new AdmissionRefused(`workspace volume ${name} does not exist`);
  if (volume.labels[SANDBOX_LABELS.managedBy] !== SANDBOX_MANAGED_BY) {
    throw new AdmissionRefused(`volume ${name} is not managed by ${SANDBOX_MANAGED_BY}`);
  }
  if (volume.labels[SUPERVISOR_NETWORK_LABEL] !== network) {
    throw new AdmissionRefused(`volume ${name} belongs to another supervisor network`);
  }
  const owner = volume.labels[SANDBOX_LABELS.botId];
  if (
    owner === undefined ||
    !Name.safeParse(owner).success ||
    name !== workspaceVolumeNameFor(owner)
  ) {
    throw new AdmissionRefused(`volume ${name} does not carry its own workspace owner`);
  }
  return volume;
}

/** A new workspace's labels are exactly the owner and the supervisor's own mark. */
export function admitVolumeLabels(name: string, labels: Readonly<Record<string, string>>): void {
  const owner = labels[SANDBOX_LABELS.botId];
  const keys = Object.keys(labels).sort();
  if (
    owner === undefined ||
    !Name.safeParse(owner).success ||
    name !== workspaceVolumeNameFor(owner) ||
    labels[SANDBOX_LABELS.managedBy] !== SANDBOX_MANAGED_BY ||
    keys.join(',') !== [SANDBOX_LABELS.botId, SANDBOX_LABELS.managedBy].sort().join(',')
  ) {
    throw new AdmissionRefused(`volume ${name} must be labelled with its own bot and nothing else`);
  }
}

/**
 * A computer exactly as this supervisor would build it, or a refusal.
 *
 * `workspaceOf` reads the daemon: a mount is admitted only for a volume the
 * supervisor labelled for the same bot the container is labelled with.
 */
export async function admitCreate(
  config: SupervisorConfig,
  raw: unknown,
  workspaceOf: (name: string) => Promise<WorkspaceVolume | null>,
): Promise<ContainerCreateSpec> {
  const parsed = CreateSpec.safeParse(raw);
  if (!parsed.success) throw new AdmissionRefused('the create spec is not a computer spec');
  const spec = parsed.data;

  admitImage(config, spec.image);
  admitNetwork(config, spec.network);

  const sessionId = spec.labels[SANDBOX_LABELS.sessionId];
  if (sessionId === undefined || !Name.safeParse(sessionId).success) {
    throw new AdmissionRefused('a computer needs a session id label');
  }
  for (const key of Object.keys(spec.labels)) {
    if (
      key !== SANDBOX_LABELS.sessionId &&
      key !== SANDBOX_LABELS.managedBy &&
      key !== SANDBOX_IDENTITY_LABEL
    ) {
      throw new AdmissionRefused(`label ${key} is not one the supervisor writes`);
    }
  }
  if (
    spec.labels[SANDBOX_LABELS.managedBy] !== undefined &&
    spec.labels[SANDBOX_LABELS.managedBy] !== SANDBOX_MANAGED_BY
  ) {
    throw new AdmissionRefused('a computer is managed by the supervisor, not by its caller');
  }
  const identity = spec.labels[SANDBOX_IDENTITY_LABEL];
  if (identity !== undefined && !Name.safeParse(identity).success) {
    throw new AdmissionRefused('the identity label is not a bot id');
  }
  if (spec.name !== containerNameFor(sessionId)) {
    throw new AdmissionRefused(
      `a computer for ${sessionId} is named ${containerNameFor(sessionId)}`,
    );
  }

  const asked = [...spec.publishPorts].sort((a, b) => a - b).join(',');
  const fixed = [...COMPUTER_PORTS].sort((a, b) => a - b).join(',');
  if (asked !== fixed) throw new AdmissionRefused('a computer publishes exactly its own ports');

  const limits = spec.limits;
  if (!limits.noNewPrivileges || !limits.dropAllCapabilities) {
    throw new AdmissionRefused('a computer always drops capabilities and new privileges');
  }
  if (limits.memorySwapBytes !== limits.memoryBytes) {
    throw new AdmissionRefused('a computer always disables swap');
  }
  if (limits.allowBrowserSandbox && !config.limits.allowBrowserSandbox) {
    throw new AdmissionRefused('the requested browser syscalls are not admitted by this host');
  }
  if (
    limits.memoryBytes > config.limits.memoryBytes ||
    limits.memorySwapBytes > config.limits.memorySwapBytes ||
    limits.cpus > config.limits.cpus ||
    limits.pidsLimit > config.limits.pidsLimit ||
    limits.shmSizeBytes > config.limits.shmSizeBytes
  ) {
    throw new AdmissionRefused('the requested limits are looser than this host allows');
  }

  if (spec.mounts.length > 1) throw new AdmissionRefused('a computer mounts one workspace at most');
  const mount = spec.mounts[0];
  if (mount !== undefined) {
    if (identity === undefined) {
      throw new AdmissionRefused('only a bot-owned computer mounts a workspace');
    }
    if (
      mount.path !== SANDBOX_WORKING_DIRECTORY ||
      mount.volume !== workspaceVolumeNameFor(identity)
    ) {
      throw new AdmissionRefused(
        `a computer mounts only its own bot's workspace, at ${SANDBOX_WORKING_DIRECTORY}`,
      );
    }
    const volume = admitManagedVolume(
      await workspaceOf(mount.volume),
      mount.volume,
      config.network,
    );
    if (volume.labels[SANDBOX_LABELS.botId] !== identity) {
      throw new AdmissionRefused(`workspace ${mount.volume} belongs to another bot`);
    }
  }

  return {
    ...spec,
    labels: { ...spec.labels, [SANDBOX_LABELS.managedBy]: SANDBOX_MANAGED_BY },
  };
}
