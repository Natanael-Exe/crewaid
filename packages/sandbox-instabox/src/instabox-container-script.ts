/**
 * Host firewall, seccomp profile, and Docker container lifecycle inside each
 * Instabox Firecracker VM.
 *
 * Every dynamic value (image ref, memory limit, bot profile ID) travels via
 * environment variables — never interpolated into shell source — and is
 * validated upfront before any command is sent to the VM.
 */

import { BROWSER_SANDBOX_SECCOMP } from '@crewaid/sandbox-core';

import type { InstaboxApi } from './instabox-client.js';
import {
  CONTAINER_BRIDGE,
  CONTAINER_HOME_DIR,
  CONTAINER_NAME,
  CONTAINER_NETWORK,
  CONTAINER_PIDS_LIMIT,
  CONTAINER_SHM_SIZE_MIB,
  CONTAINER_SUBNET,
  DOCKER_FIREWALL_DROPIN_PATH,
  FIREWALL_SCRIPT_PATH,
  FIREWALL_SERVICE_PATH,
  PORT_OFFSET,
  ROOT_MIN_FREE_PULL_MIB,
  SECCOMP_PROFILE_PATH,
} from './instabox-labels.js';

const OCI_IMAGE_REF =
  /^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9._-]+)?(?:@sha256:[a-fA-F0-9]{64})?$/;

const BOT_PROFILE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const TMP_SECCOMP_PATH = '/tmp/crewaid-seccomp-browser.json';
const TMP_FIREWALL_SCRIPT_PATH = '/tmp/crewaid-firewall.sh';
const TMP_FIREWALL_SERVICE_PATH = '/tmp/crewaid-firewall.service';
const TMP_DOCKER_DROPIN_PATH = '/tmp/crewaid-docker-firewall.conf';

const ENSURE_RESULT_MARKER = 'CREWAID_ENSURE_JSON=';

/** Rejects malformed or shell/flag-injectable OCI image references. */
export function assertValidImageRef(image: string): string {
  const trimmed = image.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 256 ||
    trimmed.includes('..') ||
    !OCI_IMAGE_REF.test(trimmed)
  ) {
    throw new Error(`Invalid sandbox image reference: ${JSON.stringify(image)}`);
  }
  return trimmed;
}

/** Rejects invalid or reserved bot profile IDs before touching the VM. */
export function assertValidBotProfileId(botId: string): string {
  if (!BOT_PROFILE_ID.test(botId) || botId === 'Default') {
    throw new Error('Invalid bot profile');
  }
  return botId;
}

/**
 * Idempotent firewall script persisted in the VM and invoked by
 * `crewaid-firewall.service` before `docker.service` on every boot:
 *
 * - `INPUT` (`CREWAID-IN`): blocks all new connections from the container
 *   bridge `crewaid0` to the VM itself (bridge gateway SSH `172.28.0.1:22`,
 *   VM eth0 SSH `172.16.0.2:22`, local services), while permitting replies to
 *   host-initiated `docker-proxy` loopback forwards.
 * - `DOCKER-USER` (`CREWAID-EGRESS`): matches the Docker provider's D-155
 *   egress fence — drops private/link-local/metadata/Instabox-gateway ranges,
 *   permits outbound TCP 80/443 only, and drops all other ports/protocols
 *   (Docker's embedded DNS resolver at `127.0.0.11` runs in the host namespace
 *   and stays reachable).
 * - `ip6tables` `DOCKER-USER`: fails closed on IPv6 egress from `crewaid0`.
 */
export function buildFirewallScript(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `BRIDGE=${CONTAINER_BRIDGE}`,
    '',
    'iptables -N CREWAID-IN 2>/dev/null || true',
    'iptables -F CREWAID-IN',
    'iptables -A CREWAID-IN -m conntrack --ctstate RELATED,ESTABLISHED --ctdir REPLY -j ACCEPT',
    'iptables -A CREWAID-IN -j DROP',
    'iptables -C INPUT -i "$BRIDGE" -j CREWAID-IN 2>/dev/null || iptables -I INPUT 1 -i "$BRIDGE" -j CREWAID-IN',
    '',
    'iptables -N DOCKER-USER 2>/dev/null || true',
    'iptables -N CREWAID-EGRESS 2>/dev/null || true',
    'iptables -F CREWAID-EGRESS',
    'iptables -A CREWAID-EGRESS -m conntrack --ctstate RELATED,ESTABLISHED --ctdir REPLY -j RETURN',
    'for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do',
    '  iptables -A CREWAID-EGRESS -d "$cidr" -j DROP',
    'done',
    'iptables -A CREWAID-EGRESS -p tcp -m multiport --dports 80,443 -m conntrack --ctstate NEW,ESTABLISHED --ctdir ORIGINAL -j RETURN',
    'iptables -A CREWAID-EGRESS -j DROP',
    'iptables -C DOCKER-USER -i "$BRIDGE" -j CREWAID-EGRESS 2>/dev/null || iptables -I DOCKER-USER 1 -i "$BRIDGE" -j CREWAID-EGRESS',
    '',
    'if command -v ip6tables >/dev/null 2>&1; then',
    '  ip6tables -N DOCKER-USER 2>/dev/null || true',
    '  ip6tables -C DOCKER-USER -i "$BRIDGE" -j DROP 2>/dev/null || ip6tables -I DOCKER-USER 1 -i "$BRIDGE" -j DROP',
    'fi',
    '',
  ].join('\n');
}

/** Systemd unit that installs the container fence before Docker starts on cold boots. */
export function buildFirewallUnit(): string {
  return [
    '[Unit]',
    'Description=Crewaid Instabox container INPUT and D-155 egress firewall',
    'Before=docker.service',
    'Wants=network-pre.target',
    'After=network-pre.target',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    `ExecStart=${FIREWALL_SCRIPT_PATH}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

/**
 * Makes `docker.service` require the firewall unit. `Before=` alone only orders
 * the two: if the firewall script failed at boot, Docker would still start and
 * `--restart unless-stopped` would bring the container up with no fence. With
 * `Requires=`, a failed firewall keeps Docker, and so the container, down; the
 * computer then reports unhealthy instead of running unfenced.
 */
export function buildDockerFirewallDropIn(): string {
  return ['[Unit]', 'Requires=crewaid-firewall.service', 'After=crewaid-firewall.service', ''].join(
    '\n',
  );
}

const INSTALL_HOST_SETUP_CMD = [
  'set -euo pipefail',
  `sudo install -D -m 0644 -o root -g root ${TMP_SECCOMP_PATH} ${SECCOMP_PROFILE_PATH}`,
  `sudo install -D -m 0755 -o root -g root ${TMP_FIREWALL_SCRIPT_PATH} ${FIREWALL_SCRIPT_PATH}`,
  `sudo install -D -m 0644 -o root -g root ${TMP_FIREWALL_SERVICE_PATH} ${FIREWALL_SERVICE_PATH}`,
  `sudo install -D -m 0644 -o root -g root ${TMP_DOCKER_DROPIN_PATH} ${DOCKER_FIREWALL_DROPIN_PATH}`,
  `rm -f ${TMP_SECCOMP_PATH} ${TMP_FIREWALL_SCRIPT_PATH} ${TMP_FIREWALL_SERVICE_PATH} ${TMP_DOCKER_DROPIN_PATH}`,
  // Reload only; restarting docker.service here would kill a live container.
  'sudo systemctl daemon-reload',
  'sudo systemctl enable --now crewaid-firewall.service',
  `docker network inspect ${CONTAINER_NETWORK} >/dev/null 2>&1 || docker network create --driver bridge --subnet ${CONTAINER_SUBNET} -o com.docker.network.bridge.name=${CONTAINER_BRIDGE} ${CONTAINER_NETWORK}`,
  `sudo install -d -m 0755 -o 1000 -g 1000 ${CONTAINER_HOME_DIR}`,
].join('\n');

/**
 * Installs the Chrome browser-sandbox seccomp profile, persistent host/egress
 * firewall systemd unit, isolated `crewaid-net` (`crewaid0`) Docker bridge,
 * and persistent `/data/crewaid-home` directory inside a fresh or booted VM.
 */
export async function installHostSetup(
  api: InstaboxApi,
  machineId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const writeOpts = abortSignal !== undefined ? { abortSignal } : undefined;
  await api.writeFile(
    machineId,
    TMP_SECCOMP_PATH,
    `${JSON.stringify(BROWSER_SANDBOX_SECCOMP)}\n`,
    writeOpts,
  );
  await api.writeFile(machineId, TMP_FIREWALL_SCRIPT_PATH, buildFirewallScript(), writeOpts);
  await api.writeFile(machineId, TMP_FIREWALL_SERVICE_PATH, buildFirewallUnit(), writeOpts);
  await api.writeFile(machineId, TMP_DOCKER_DROPIN_PATH, buildDockerFirewallDropIn(), writeOpts);

  const result = await api.exec(machineId, INSTALL_HOST_SETUP_CMD, {
    timeoutMs: 60_000,
    ...(abortSignal !== undefined ? { abortSignal } : {}),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to configure Instabox VM firewall and network (exit ${result.exitCode ?? 'timeout'}): ` +
        result.stderr.trim().slice(0, 400),
    );
  }
}

export interface EnsureContainerResult {
  readonly imageId: string;
  readonly recreated: boolean;
  /**
   * Why a newer image was left for later: `disk` when `/` lacked room to pull
   * it, `pull` when the registry could not be reached. The computer keeps
   * running its current image either way; `null` when nothing was skipped.
   */
  readonly skippedUpgrade: 'disk' | 'pull' | null;
}

/**
 * How `ensureContainer` treats a container that already exists:
 *
 * - `ensure`: keep it while it was started from the configured image name;
 *   replace it when the configured name changed. Used on create and on a cold
 *   boot.
 * - `follow`: pull the configured name and replace the container only if the
 *   name now points at a different image. A tag a release moves, such as
 *   `crewaid-sandbox:latest`, keeps the same name while its content changes, so
 *   comparing names alone would leave a computer on its first image forever.
 *   Used when a computer wakes from paused or stopped, never under a running
 *   one. A pull that fails keeps the current container: the start a person
 *   asked for matters more than the update.
 * - `keep`: never replace it, only start it; create one only when none exists.
 *   Used to recover a computer whose bridge does not answer, so a bot that may
 *   be mid-task is never moved onto another image underneath it.
 */
export type EnsureMode = 'ensure' | 'follow' | 'keep';

/**
 * Shell program that ensures `crewaid-sandbox` is running with all hardening,
 * resource limits, Chrome browser-sandbox seccomp profile, and offset loopback
 * port mappings.
 *
 * Persistence note (R5): On the shared-host Docker provider, R5 forbids host
 * bind mounts so a container cannot reach arbitrary host directories. Inside an
 * Instabox Firecracker VM, the entire VM belongs to one computer and `/data` is
 * that computer's dedicated persistent block device (whereas `/var/lib/docker`
 * sits on the fixed 16 GiB root disk). Mounting `/data/crewaid-home:/home/bot`
 * keeps user profiles on the persistent disk without exposing anything outside
 * this single computer's VM.
 */
export function buildEnsureContainerCommand(): string {
  const bridgeHostPort = 7070 + PORT_OFFSET;
  const cdpHostPort = 9222 + PORT_OFFSET;
  const rfbStart = 5900 + PORT_OFFSET;
  const rfbEnd = 5916 + PORT_OFFSET;
  const seatCdpStart = 9301 + PORT_OFFSET;
  const seatCdpEnd = 9316 + PORT_OFFSET;

  return [
    'set -euo pipefail',
    `NAME=${CONTAINER_NAME}`,
    'IMAGE="$CREWAID_IMAGE"',
    'MEM_MIB="$CREWAID_CONTAINER_MEM_MIB"',
    'MODE="${CREWAID_ENSURE_MODE:-ensure}"',
    `MIN_FREE_MIB=${ROOT_MIN_FREE_PULL_MIB}`,
    '',
    'emit() {',
    `  printf '${ENSURE_RESULT_MARKER}{"imageId":"%s","recreated":%s,"skippedUpgrade":"%s"}\\n' "$1" "$2" "$3"`,
    '}',
    'start_existing() {',
    '  if [ "$EXISTING_STATE" != "running" ]; then docker start "$NAME" >/dev/null; fi',
    '}',
    '',
    'EXISTING_STATE=$(docker inspect -f "{{.State.Status}}" "$NAME" 2>/dev/null || true)',
    'EXISTING_IMAGE_ID=$(docker inspect -f "{{.Image}}" "$NAME" 2>/dev/null || true)',
    'EXISTING_IMAGE_REF=$(docker inspect -f "{{.Config.Image}}" "$NAME" 2>/dev/null || true)',
    '',
    'if [ -n "$EXISTING_STATE" ]; then',
    '  if [ "$MODE" = "keep" ] || { [ "$MODE" = "ensure" ] && [ "$EXISTING_IMAGE_REF" = "$IMAGE" ]; }; then',
    '    start_existing',
    '    emit "$EXISTING_IMAGE_ID" false ""',
    '    exit 0',
    '  fi',
    'fi',
    '',
    'if [ "$MODE" = "follow" ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then',
    '  docker image prune -af >/dev/null 2>&1 || true',
    '  FREE_MIB=$(df -Pm / | awk "NR==2 {print \\$4}")',
    '  if [ "${FREE_MIB:-0}" -lt "$MIN_FREE_MIB" ]; then',
    '    if [ -n "$EXISTING_STATE" ]; then',
    '      start_existing',
    '      emit "$EXISTING_IMAGE_ID" false disk',
    '      exit 0',
    '    fi',
    '    echo "Insufficient free space on / (${FREE_MIB:-0} MiB < ${MIN_FREE_MIB} MiB) to pull $IMAGE" >&2',
    '    exit 28',
    '  fi',
    '  if ! PULL_ERR=$(timeout 180 docker pull -q "$IMAGE" 2>&1 >/dev/null); then',
    '    if [ -n "$EXISTING_STATE" ]; then',
    '      echo "pull of $IMAGE failed, keeping the current image: $PULL_ERR" >&2',
    '      start_existing',
    '      emit "$EXISTING_IMAGE_ID" false pull',
    '      exit 0',
    '    fi',
    '    echo "pull of $IMAGE failed: $PULL_ERR" >&2',
    '    exit 1',
    '  fi',
    'fi',
    '',
    'TARGET_IMAGE_ID=$(docker image inspect -f "{{.Id}}" "$IMAGE")',
    '',
    'if [ -n "$EXISTING_STATE" ] && [ "$EXISTING_IMAGE_ID" = "$TARGET_IMAGE_ID" ]; then',
    '  start_existing',
    '  emit "$TARGET_IMAGE_ID" false ""',
    '  exit 0',
    'fi',
    '',
    'if [ -n "$EXISTING_STATE" ]; then',
    '  docker stop -t 15 "$NAME" >/dev/null 2>&1 || true',
    '  docker rm -f "$NAME" >/dev/null 2>&1 || true',
    'fi',
    '',
    'docker run -d \\',
    '  --name "$NAME" \\',
    '  --restart unless-stopped \\',
    `  --network ${CONTAINER_NETWORK} \\`,
    `  -v ${CONTAINER_HOME_DIR}:/home/bot:rw \\`,
    '  --cap-drop=ALL \\',
    '  --security-opt no-new-privileges:true \\',
    `  --security-opt seccomp=${SECCOMP_PROFILE_PATH} \\`,
    '  --memory "${MEM_MIB}m" \\',
    '  --memory-swap "${MEM_MIB}m" \\',
    `  --pids-limit ${CONTAINER_PIDS_LIMIT} \\`,
    `  --shm-size ${CONTAINER_SHM_SIZE_MIB}m \\`,
    `  -p 127.0.0.1:${bridgeHostPort}:7070 \\`,
    `  -p 127.0.0.1:${cdpHostPort}:9222 \\`,
    `  -p 127.0.0.1:${rfbStart}-${rfbEnd}:5900-5916 \\`,
    `  -p 127.0.0.1:${seatCdpStart}-${seatCdpEnd}:9301-9316 \\`,
    '  "$IMAGE" >/dev/null',
    '',
    'docker image prune -af >/dev/null 2>&1 || true',
    'emit "$TARGET_IMAGE_ID" true ""',
  ].join('\n');
}

/** Ensures `crewaid-sandbox` is running on the requested image and limits. */
export async function ensureContainer(
  api: InstaboxApi,
  machineId: string,
  options: {
    readonly image: string;
    readonly containerMemoryMiB: number;
    readonly mode?: EnsureMode;
    readonly abortSignal?: AbortSignal;
  },
): Promise<EnsureContainerResult> {
  const image = assertValidImageRef(options.image);
  const memMiB = Math.max(512, Math.floor(options.containerMemoryMiB));

  const result = await api.exec(machineId, buildEnsureContainerCommand(), {
    envs: {
      CREWAID_IMAGE: image,
      CREWAID_CONTAINER_MEM_MIB: String(memMiB),
      CREWAID_ENSURE_MODE: options.mode ?? 'ensure',
    },
    // First pull of the ~3.5 GiB desktop image takes ~25-45 s; allow up to 5 min.
    timeoutMs: 300_000,
    ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to start ${CONTAINER_NAME} on Instabox VM ${machineId} ` +
        `(exit ${result.exitCode ?? 'timeout'}): ${result.stderr.trim().slice(0, 400)}`,
    );
  }
  return parseEnsureResult(result.stdout);
}

/**
 * Retires a bot's Chrome profile inside `/data/crewaid-home` by running the
 * sandbox image's `profiles.py retire <botId>` as UID 1000 (`bot`). Uses the
 * running `crewaid-sandbox` container when up, or a one-shot hardened container
 * when the VM was cold-stopped and woken solely for profile retirement.
 */
export async function retireContainerBotProfile(
  api: InstaboxApi,
  machineId: string,
  botId: string,
  fallbackImage: string,
): Promise<void> {
  const safeBotId = assertValidBotProfileId(botId);
  const safeImage = assertValidImageRef(fallbackImage);
  const cmd = [
    'set -euo pipefail',
    `if [ "$(docker inspect -f '{{.State.Running}}' ${CONTAINER_NAME} 2>/dev/null || true)" = "true" ]; then`,
    `  docker exec -u bot -e CREWAID_BOT_ID ${CONTAINER_NAME} python3 /opt/agent-bridge/profiles.py retire "$CREWAID_BOT_ID"`,
    'else',
    `  IMG=$(docker inspect -f '{{.Config.Image}}' ${CONTAINER_NAME} 2>/dev/null || printf '%s' "$CREWAID_FALLBACK_IMAGE")`,
    `  docker run --rm --network none --user 1000:1000 --cap-drop=ALL --security-opt no-new-privileges:true -v ${CONTAINER_HOME_DIR}:/home/bot:rw --entrypoint python3 -e CREWAID_BOT_ID "$IMG" /opt/agent-bridge/profiles.py retire "$CREWAID_BOT_ID"`,
    'fi',
  ].join('\n');

  const result = await api.exec(machineId, cmd, {
    envs: {
      CREWAID_BOT_ID: safeBotId,
      CREWAID_FALLBACK_IMAGE: safeImage,
    },
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not persist profile retirement (exit ${result.exitCode ?? 'timeout'}): ` +
        result.stderr.trim().slice(0, 300),
    );
  }
}

function parseEnsureResult(stdout: string): EnsureContainerResult {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() ?? '';
    if (!line.startsWith(ENSURE_RESULT_MARKER)) continue;
    const json = line.slice(ENSURE_RESULT_MARKER.length);
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null) {
      const imageId: unknown = Reflect.get(parsed, 'imageId');
      const recreated: unknown = Reflect.get(parsed, 'recreated');
      const skipped: unknown = Reflect.get(parsed, 'skippedUpgrade');
      if (
        typeof imageId === 'string' &&
        typeof recreated === 'boolean' &&
        (skipped === '' || skipped === 'disk' || skipped === 'pull')
      ) {
        return { imageId, recreated, skippedUpgrade: skipped === '' ? null : skipped };
      }
    }
  }
  throw new Error('Could not parse container start outcome from Instabox VM output');
}
