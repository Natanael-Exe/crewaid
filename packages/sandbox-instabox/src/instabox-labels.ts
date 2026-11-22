export const COMPUTER_NAME_PREFIX = 'crewaid-';
export const COMPUTER_LABEL = Object.freeze({ key: 'crewaid', value: 'computer' });
export const FIRST_START_LABEL = 'crewaid-first-start';
export const ORPHANED_AT_LABEL = 'crewaid-orphaned-at';
export const IMAGE_LABEL = 'crewaid-image';
export const IMAGE_ID_LABEL = 'crewaid-image-id';

export const DEFAULT_INSTABOX_TEMPLATE = 'agent-browser';
export const DEFAULT_INSTABOX_IMAGE = 'ghcr.io/natanael-exe/crewaid-sandbox:latest';

/** Docker container and isolated bridge parameters inside each Instabox VM. */
export const CONTAINER_NAME = 'crewaid-sandbox';
export const CONTAINER_NETWORK = 'crewaid-net';
export const CONTAINER_BRIDGE = 'crewaid0';
export const CONTAINER_SUBNET = '172.28.0.0/24';
export const CONTAINER_HOME_DIR = '/data/crewaid-home';
export const SECCOMP_PROFILE_PATH = '/etc/crewaid/seccomp-browser.json';
export const FIREWALL_SCRIPT_PATH = '/usr/local/sbin/crewaid-firewall.sh';
export const FIREWALL_SERVICE_PATH = '/etc/systemd/system/crewaid-firewall.service';
/** Drop-in making `docker.service` require the firewall, so no fence means no container. */
export const DOCKER_FIREWALL_DROPIN_PATH =
  '/etc/systemd/system/docker.service.d/10-crewaid-firewall.conf';

/**
 * Container ports are published on VM loopback shifted by `+10000` so they
 * never collide with Instabox's own on-demand desktop (`Xvnc` on `:1` / 5901).
 */
export const PORT_OFFSET = 10_000;

/**
 * VM RAM kept outside the container's cgroup limit. Measured on a stock
 * `agent-browser` VM: ~370 MiB in use before the container starts, ~1.1 GiB
 * once Instabox's own on-demand desktop is up (it starts when anyone opens the
 * dashboard's Computer tab), plus one `docker-proxy` per published port (~35).
 * Sized so a container at its limit is OOM-killed inside its own cgroup, while
 * the VM-wide OOM killer never has to choose `sshd` or `dockerd`, which would
 * cut the orchestrator off from the computer.
 */
export const CONTAINER_MEMORY_RESERVE_MIB = 1536;
export const CONTAINER_PIDS_LIMIT = 2048;
export const CONTAINER_SHM_SIZE_MIB = 512;

/**
 * Minimum free MiB required on `/` (Instabox's fixed 16 GiB root disk where
 * Docker stores image layers) before pulling a new sandbox image.
 */
export const ROOT_MIN_FREE_PULL_MIB = 2048;

export function sandboxNameFor(computerId: string): string {
  return `${COMPUTER_NAME_PREFIX}${computerId}`;
}

export function hostPortFor(containerPort: number): number {
  return containerPort + PORT_OFFSET;
}
