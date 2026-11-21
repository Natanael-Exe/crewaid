import { spawn, spawnSync } from 'node:child_process';

/** Run a command and capture its output; never throws, so preflight can explain instead. */
export function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    missing: result.error?.code === 'ENOENT',
  };
}

/** Run a command attached to this terminal; resolves to its exit code. */
export function attached(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', () => resolve(127));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * `docker compose`, pointed at the install directory. `--project-directory`
 * makes Compose read that directory's .env itself — COMPOSE_PROFILES included,
 * so `docker compose up -d` run by hand there does exactly what this does.
 */
export function compose(dir, args) {
  return attached('docker', [
    'compose',
    '--project-directory',
    dir,
    '-f',
    `${dir}/compose.yml`,
    ...args,
  ]);
}

/** What Docker and Compose report, or why there is nothing to talk to. */
export function preflight() {
  const docker = capture('docker', ['version', '--format', '{{.Server.Version}}']);
  if (docker.missing) {
    return {
      ok: false,
      message:
        'Docker is not installed. Get Docker Desktop (Mac, Windows) or Docker Engine (Linux): https://docs.docker.com/get-docker/',
    };
  }
  if (!docker.ok) {
    return {
      ok: false,
      message: `Docker is installed but not running (or this user cannot reach it): ${docker.stderr.split('\n')[0]}`,
    };
  }
  const composeVersion = capture('docker', ['compose', 'version', '--short']);
  if (!composeVersion.ok) {
    return {
      ok: false,
      message:
        'Docker Compose v2 is missing (`docker compose`). It ships with Docker Desktop; on Linux install the docker-compose-plugin package.',
    };
  }
  return { ok: true, docker: docker.stdout, compose: composeVersion.stdout };
}

/**
 * What Docker already holds of a `crewaid` Compose project: the folders its
 * containers were started from, and whether its database volume exists. The
 * project, network and volume names are fixed by compose.yml, so a second
 * install would take these over rather than sit beside them.
 */
export function existingProject() {
  const containers = capture('docker', [
    'ps',
    '-a',
    '--filter',
    'label=com.docker.compose.project=crewaid',
    '--format',
    '{{.Label "com.docker.compose.project.working_dir"}}',
  ]);
  const volume = capture('docker', ['volume', 'inspect', 'crewaid_postgres-data']);
  return {
    folders: [...new Set(containers.stdout.split('\n').filter((line) => line !== ''))],
    dataVolume: volume.ok,
  };
}

/** Every subnet an existing Docker network uses, so a new one can avoid them. */
export function dockerSubnets() {
  const ids = capture('docker', ['network', 'ls', '-q']);
  if (!ids.ok || ids.stdout === '') return [];
  const inspected = capture('docker', [
    'network',
    'inspect',
    ...ids.stdout.split('\n'),
    '--format',
    '{{range .IPAM.Config}}{{.Subnet}} {{end}}',
  ]);
  return inspected.stdout.split(/\s+/).filter((cidr) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(cidr));
}
