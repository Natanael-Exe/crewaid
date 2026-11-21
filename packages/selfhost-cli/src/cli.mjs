import { chmod, chown, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { generateSecrets, supervisorSecret } from './secrets.mjs';
import { parseEnv, renderEnv, setEnvValue } from './env.mjs';
import { lanAddress, pickSandboxSubnet, portIsFree } from './network.mjs';
import { capture, compose, dockerSubnets, existingProject, preflight } from './docker.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS = 'https://downloads.crewaid.io/desktop/selfhosted';

export async function ownVersion() {
  const pkg = JSON.parse(await readFile(path.join(HERE, '..', 'package.json'), 'utf8'));
  return pkg.version;
}

export async function composeTemplate() {
  return readFile(path.join(HERE, '..', 'assets', 'compose.yml'), 'utf8');
}

const HELP = `crewaid-selfhost — run Crewaid on your own machine or server (Docker)

  init [options]            install: write compose.yml and .env, start the server
    --dir <path>            where to install (default ~/crewaid)
    --mode <local|lan|domain>
                            local:  this computer only (http://localhost:<port>)
                            lan:    your local network (http://<lan-ip>:<port>, unencrypted)
                            domain: a domain name pointed here, HTTPS via Let's Encrypt
    --domain <name>         for --mode domain
    --port <n>              default 3000
    --version <x.y.z>       release to run (default: this installer's)
    --yes                   accept the defaults instead of asking
  update [--dir] [--version]  move to a newer release (keeps .env)
  status [--dir]            what is running, and the server's health
  reset-password <email> [--dir]
                            set a new password for an account
`;

export function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2);
      options[key] = inline ?? argv[++i];
    } else options._.push(arg);
  }
  return options;
}

function installDir(options) {
  const raw = options.dir ?? process.env.CREWAID_DIR ?? path.join(homedir(), 'crewaid');
  return path.resolve(raw.replace(/^~(?=$|\/)/, homedir()));
}

/**
 * Give the files back to the person who ran install.sh. The installer's
 * container runs as root, so on Linux what it writes is root's — including a
 * mode-600 .env its owner could then not read. (Docker Desktop's file sharing
 * hides this on macOS and Windows; the ids it is handed are the host's.)
 */
async function returnOwnership(dir, files) {
  const uid = Number(process.env.CREWAID_HOST_UID);
  const gid = Number(process.env.CREWAID_HOST_GID);
  if (process.env.CREWAID_IN_CONTAINER !== '1' || !Number.isInteger(uid) || !Number.isInteger(gid))
    return;
  for (const target of [dir, ...files.map((file) => path.join(dir, file))]) {
    await chown(target, uid, gid).catch(() => undefined);
  }
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The address the desktop app will use and how the server listens, for a mode.
 * Pure, so the three shapes are tested without a terminal or Docker.
 */
export function addressPlan({ mode, port, domain, lan }) {
  if (mode === 'domain') {
    if (!domain) throw new Error('--mode domain needs --domain <name>');
    return {
      BETTER_AUTH_URL: `https://${domain}`,
      CREWAID_BIND: '127.0.0.1',
      CREWAID_PORT: String(port),
      CREWAID_DOMAIN: domain,
      COMPOSE_PROFILES: 'https',
    };
  }
  if (mode === 'lan') {
    if (!lan)
      throw new Error(
        'Could not find this machine’s local network address; use --mode local or --mode domain.',
      );
    return {
      BETTER_AUTH_URL: `http://${lan}:${port}`,
      CREWAID_BIND: '0.0.0.0',
      CREWAID_PORT: String(port),
    };
  }
  return {
    BETTER_AUTH_URL: `http://localhost:${port}`,
    CREWAID_BIND: '127.0.0.1',
    CREWAID_PORT: String(port),
  };
}

async function ask(rl, question, fallback) {
  if (!rl) return fallback;
  const answer = (await rl.question(`${question} [${fallback}] `)).trim();
  return answer === '' ? fallback : answer;
}

/**
 * The server's `/health`, or null. Asked over its published port — which also
 * proves the port works — except when the installer itself runs in a
 * container (install.sh without Node), where 127.0.0.1 is that container: then
 * the orchestrator container is asked directly.
 */
export async function readHealth(dir, port) {
  if (process.env.CREWAID_IN_CONTAINER === '1') {
    const result = capture('docker', [
      'compose',
      '--project-directory',
      dir,
      '-f',
      `${dir}/compose.yml`,
      'exec',
      '-T',
      'orchestrator',
      'node',
      '-e',
      "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(t=>process.stdout.write(t))",
    ]);
    try {
      return result.ok ? JSON.parse(result.stdout) : null;
    } catch {
      return null;
    }
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/**
 * Ready means `/health` says `ok`. It answers 200 whenever the process is up —
 * a database or Redis outage is reported in the body, not the status code —
 * so a 200 alone would call a broken server running.
 */
export function readiness(health) {
  if (health === null) return { ready: false, problem: 'the server is not answering' };
  if (health.status === 'ok') return { ready: true };
  const down = ['db', 'redis', 'docker'].filter((part) => health[part] === false);
  const names = { db: 'the database', redis: 'Redis', docker: 'Docker' };
  return {
    ready: false,
    problem: down.length
      ? `${down.map((part) => names[part]).join(' and ')} not reachable`
      : `status ${health.status}`,
  };
}

/** Wait until the server is ready; the last answer either way. */
async function waitForReady(dir, port, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let health = null;
  while (Date.now() < deadline) {
    health = await readHealth(dir, port);
    if (readiness(health).ready) return health;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return health;
}

/**
 * Why `init` must not run here, or null. The Compose project, its volumes and
 * networks have fixed names, so a second install in another folder would take
 * over the first one's containers and data with new keys.
 */
export function installConflict({ dir, folders, dataVolume }) {
  const elsewhere = folders.filter((folder) => path.resolve(folder) !== path.resolve(dir));
  if (elsewhere.length > 0) {
    return (
      `A Crewaid server already runs from ${elsewhere[0]}. One machine runs one: use ` +
      `\`crewaid-selfhost update --dir ${elsewhere[0]}\` to update it, or remove it there first ` +
      '(`docker compose down`).'
    );
  }
  if (folders.length === 0 && dataVolume) {
    return (
      'An earlier Crewaid install left its data here (Docker volume crewaid_postgres-data), and it ' +
      'is encrypted with that install’s keys. Run `crewaid-selfhost update` in that install’s folder ' +
      'to bring it back, or delete the data for a fresh start: ' +
      '`docker volume rm crewaid_postgres-data crewaid_redis-data crewaid_artifacts`.'
    );
  }
  return null;
}

async function init(options) {
  const check = preflight();
  if (!check.ok) return fail(check.message);
  console.log(`Docker ${check.docker}, Compose ${check.compose}.`);

  const dir = installDir(options);
  if (await exists(path.join(dir, '.env'))) {
    return fail(
      `${dir} already has a Crewaid server. Use \`crewaid-selfhost update\` to move it to a newer release.`,
    );
  }
  const conflict = installConflict({ dir, ...existingProject() });
  if (conflict !== null) return fail(conflict);

  const interactive = !options.yes && process.stdin.isTTY;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    let mode = options.mode;
    if (!mode) {
      console.log('\nHow will the desktop app reach this server?');
      console.log('  local   this computer only');
      console.log('  lan     other computers on your local network (unencrypted)');
      console.log('  domain  the internet, through a domain name pointed here (HTTPS)');
      mode = await ask(rl, 'Choose', 'local');
    }
    if (!['local', 'lan', 'domain'].includes(mode))
      return fail(`Unknown mode "${mode}": use local, lan or domain.`);
    const domain =
      mode === 'domain' ? (options.domain ?? (await ask(rl, 'Domain name', ''))) : undefined;
    const port = Number(options.port ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return fail(`--port must be 1–65535, got ${options.port}`);
    if (process.env.CREWAID_IN_CONTAINER !== '1' && !(await portIsFree(port))) {
      return fail(`Port ${port} is already in use on this machine. Choose another with --port.`);
    }
    const lan = process.env.CREWAID_HOST_LAN_IP || lanAddress();
    const plan = addressPlan({ mode, port, domain, lan });
    const version = options.version ?? (await ownVersion());
    const { subnet, orchestrator } = pickSandboxSubnet(dockerSubnets());

    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'compose.yml'), await composeTemplate());
    const envFile = path.join(dir, '.env');
    await writeFile(
      envFile,
      renderEnv({
        CREWAID_VERSION: version,
        ...plan,
        CREWAID_SANDBOX_SUBNET: subnet,
        CREWAID_ORCHESTRATOR_ADDRESS: orchestrator,
        SANDBOX_MAX_RUNNING: '2',
        ...generateSecrets(),
      }),
      { mode: 0o600 },
    );
    await chmod(envFile, 0o600);
    await returnOwnership(dir, ['compose.yml', '.env']);
    console.log(`\nWrote ${dir}/compose.yml and .env (keep .env private: it holds every key).`);
    if (mode === 'lan') {
      console.log(
        'Note: on a local network the connection is not encrypted — fine on a network you trust.',
      );
    }
    if (mode === 'domain') {
      console.log(
        `Point ${domain}'s DNS at this machine and open ports 80 and 443 for the certificate.`,
      );
    }

    console.log(`\nStarting Crewaid ${version} (the first start downloads about 2 GB)…`);
    const code = await compose(dir, ['up', '-d']);
    if (code !== 0)
      return fail(
        `docker compose up failed (exit ${code}). Logs: cd ${dir} && docker compose logs`,
      );
    const health = await waitForReady(dir, port);
    const state = readiness(health);
    if (!state.ready) {
      return fail(
        `The server is not ready after 5 minutes: ${state.problem}. Logs: cd ${dir} && docker compose logs`,
      );
    }

    console.log(`
Crewaid ${health.version} is running.

  1. Download Crewaid Self-Hosted:
       macOS    ${DOWNLOADS}/mac
       Windows  ${DOWNLOADS}/windows
  2. Open it and enter this address:  ${plan.BETTER_AUTH_URL}
  3. Create your account — the first one is yours; anyone who can reach the
     address can create their own.

Later: \`npx crewaid-selfhost update\` for new releases, \`npx crewaid-selfhost reset-password <email>\`
if someone forgets theirs. Everything lives in ${dir}.`);
    return 0;
  } finally {
    rl?.close();
  }
}

async function update(options) {
  const check = preflight();
  if (!check.ok) return fail(check.message);
  const dir = installDir(options);
  const envFile = path.join(dir, '.env');
  if (!(await exists(envFile)))
    return fail(`No Crewaid server in ${dir}. Install one with \`crewaid-selfhost init\`.`);
  const text = await readFile(envFile, 'utf8');
  const current = parseEnv(text).CREWAID_VERSION;
  const version = options.version ?? (await ownVersion());
  console.log(`Updating ${dir} from ${current} to ${version}.`);
  // The compose file belongs to the release; .env belongs to the operator and
  // only its version line changes (and a secret a newer release needs is added).
  await writeFile(path.join(dir, 'compose.yml'), await composeTemplate());
  await writeFile(envFile, updateEnvironment(text, version), { mode: 0o600 });
  await returnOwnership(dir, ['compose.yml', '.env']);
  let code = await compose(dir, ['pull']);
  if (code !== 0) {
    return fail(
      `Could not download Crewaid ${version}'s images (exit ${code}). Check the version exists ` +
        '(https://github.com/natanael-exe — crewaid-orchestrator) and that this machine is online.',
    );
  }
  code = await compose(dir, ['up', '-d']);
  if (code !== 0)
    return fail(`docker compose up failed (exit ${code}). Logs: cd ${dir} && docker compose logs`);
  const health = await waitForReady(dir, Number(parseEnv(text).CREWAID_PORT ?? 3000));
  const state = readiness(health);
  if (!state.ready) {
    return fail(
      `Started, but not ready after 5 minutes: ${state.problem}. Logs: cd ${dir} && docker compose logs`,
    );
  }
  console.log(`Crewaid ${health.version} is running.`);
  return 0;
}

/** Add the supervisor key once when upgrading an older install; retain every existing key. */
export function updateEnvironment(text, version) {
  if (!parseEnv(text).SANDBOX_SUPERVISOR_SECRET) {
    text = setEnvValue(text, 'SANDBOX_SUPERVISOR_SECRET', supervisorSecret());
  }
  return setEnvValue(text, 'CREWAID_VERSION', version);
}

async function status(options) {
  const dir = installDir(options);
  const code = await compose(dir, ['ps']);
  const env = (await exists(path.join(dir, '.env')))
    ? parseEnv(await readFile(path.join(dir, '.env'), 'utf8'))
    : {};
  const health = await readHealth(dir, Number(env.CREWAID_PORT ?? 3000));
  console.log(
    health === null
      ? '\nServer: not answering.'
      : `\nServer: ${health.status}, version ${health.version}, address ${env.BETTER_AUTH_URL ?? '?'}`,
  );
  return code;
}

async function resetPassword(options) {
  const email = options._[1];
  if (!email) return fail('usage: crewaid-selfhost reset-password <email>');
  return compose(installDir(options), [
    'exec',
    'orchestrator',
    'node',
    'apps/orchestrator/dist/cli/reset-password.js',
    email,
  ]);
}

function fail(message) {
  console.error(`crewaid-selfhost: ${message}`);
  return 1;
}

export async function main(argv) {
  const options = parseArgs(argv);
  const command = options._[0];
  if (!command && 'version' in options && options.version === undefined) {
    console.log(await ownVersion());
    return 0;
  }
  if (options.help || !command) {
    console.log(HELP);
    return command || options.help ? 0 : 1;
  }
  if (command === '--version' || command === 'version') {
    console.log(await ownVersion());
    return 0;
  }
  switch (command) {
    case 'init':
      return init(options);
    case 'update':
      return update(options);
    case 'status':
      return status(options);
    case 'reset-password':
      return resetPassword(options);
    default:
      return fail(`unknown command "${command}"\n\n${HELP}`);
  }
}
