/**
 * An in-process supervisor on a loopback port, for the suites that drive real
 * Docker. The provider under test reaches it exactly as a deployment
 * does — signed HTTP, admission, audit — so nothing about the boundary is
 * skipped by testing through it.
 */

import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { readSupervisorConfig } from './admission.js';
import { createDockerEngine } from './docker-engine.js';
import { createSupervisorServer, type AuditLine } from './server.js';

export interface TestSupervisor {
  readonly url: string;
  readonly secret: string;
  /** Every audit line written so far. */
  readonly audit: readonly AuditLine[];
  close(): Promise<void>;
}

export async function startTestSupervisor(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TestSupervisor> {
  const secret = randomBytes(32).toString('hex');
  const config = readSupervisorConfig({
    ...env,
    SANDBOX_SUPERVISOR_SECRET: secret,
    SANDBOX_SUPERVISOR_SECRET_PREVIOUS: '',
    SANDBOX_SUPERVISOR_HOST: '127.0.0.1',
    SANDBOX_SUPERVISOR_PORT: '7300',
  });
  const lines: AuditLine[] = [];
  const server = createSupervisorServer({
    config,
    engine: createDockerEngine({
      publishOn: config.publishOn,
      connect: config.connect,
      network: config.network,
    }),
    audit: (line) => lines.push(line),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    secret,
    audit: lines,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Points `SANDBOX_SUPERVISOR_URL`/`SECRET` at an in-process supervisor unless
 * the environment already names one. `overrides` (a suite's own network, say)
 * always start a fresh one, configured with them.
 */
export async function useTestSupervisor(
  overrides: NodeJS.ProcessEnv = {},
): Promise<TestSupervisor | null> {
  if ((process.env['SANDBOX_SUPERVISOR_URL'] ?? '') !== '' && Object.keys(overrides).length === 0) {
    return null;
  }
  const supervisor = await startTestSupervisor({ ...process.env, ...overrides });
  process.env['SANDBOX_SUPERVISOR_URL'] = supervisor.url;
  process.env['SANDBOX_SUPERVISOR_SECRET'] = supervisor.secret;
  return supervisor;
}
