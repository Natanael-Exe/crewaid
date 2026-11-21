// Runs inside the Dokploy container. The Runtime lookup never wakes a computer.
//
// `--liveness` is what Docker's healthcheck runs, and it asks only whether this
// container serves the release it was deployed as. Dokploy's Traefik stops
// routing to a container that is starting or unhealthy, so failing liveness on
// Redis, Runtime or R2 would turn any outage of theirs into an outage of
// sign-in, chat and Stripe webhooks too. /health stays a liveness route for the
// same reason. Without the flag this is the release runbook's full readiness
// check: every dependency must answer.
import { SdkRuntimeApi } from '@crewaid/sandbox-runtime';
import {
  createArtifactStore,
  readArtifactStorage,
} from '../dist/attachments/artifact-store.config.js';

const liveness = process.argv.includes('--liveness');
const deadline = setTimeout(() => {
  console.error('Readiness checks timed out');
  process.exit(1);
}, 15_000);
const marker = Buffer.from('Crewaid artifact storage readiness v1\n');
const key = '_crewaid/readiness-v1';

async function checkOrchestrator() {
  const response = await fetch('http://127.0.0.1:3000/health');
  const health = await response.json();
  const expected = process.env.CREWAID_VERSION;
  const identified =
    response.ok &&
    Boolean(health.version) &&
    health.version !== 'dev' &&
    health.version === expected &&
    health.edition === 'cloud';
  // /health answers 200 with a degraded body, so readiness reads the status too.
  if (!identified || (!liveness && health.status !== 'ok')) {
    throw new Error('Release identity or orchestrator dependencies are unhealthy');
  }
}

async function checkRuntimeImage() {
  if (!(await new SdkRuntimeApi().resolveImage(process.env.SANDBOX_RUNTIME_IMAGE))) {
    throw new Error('Runtime image was not found');
  }
}

async function checkStorage() {
  const choice = readArtifactStorage(process.env, 'cloud');
  if (choice.kind !== 'r2') throw new Error('R2 configuration required');
  const store = createArtifactStore(choice);
  let bytes = await store.get(key);
  if (bytes === null) {
    await store.put(key, marker, 'text/plain');
    bytes = await store.get(key);
  }
  if (!bytes?.equals(marker)) throw new Error('R2 readiness object could not be verified');
}

const checks = liveness
  ? [['Orchestrator', checkOrchestrator]]
  : [
      ['Orchestrator', checkOrchestrator],
      ['Runtime image', checkRuntimeImage],
      ['R2 object', checkStorage],
    ];

try {
  const results = await Promise.allSettled(checks.map(([, check]) => check()));
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      // Probe logs can be displayed in Dokploy. Keep credentials and vendor URLs out.
      console.error(`${checks[index][0]} readiness failed`);
      process.exitCode = 1;
    }
  }
} finally {
  clearTimeout(deadline);
}
