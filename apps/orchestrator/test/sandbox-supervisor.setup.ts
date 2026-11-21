import { afterAll } from 'vitest';

/**
 * D-200: the Docker provider reaches the daemon only through the sandbox
 * supervisor. A suite that drives real Docker gets an in-process supervisor on
 * a loopback port, configured from the same environment the provider reads,
 * unless the environment already names one. Loaded only when those suites are
 * on, so no other suite pays for the Docker client.
 */
if (process.env['CREWAID_DOCKER_TESTS'] === '1') {
  const { useTestSupervisor } = await import('@crewaid/sandbox-supervisor');
  const supervisor = await useTestSupervisor();
  afterAll(async () => supervisor?.close());
}
