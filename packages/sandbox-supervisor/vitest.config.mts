import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      // Skipped Docker suites still construct their providers while collected.
      // Opted-in suites replace these with their in-process supervisor.
      SANDBOX_SUPERVISOR_URL:
        process.env['SANDBOX_SUPERVISOR_URL'] ||
        (process.env['CREWAID_DOCKER_TESTS'] === '1' ? '' : 'http://127.0.0.1:1'),
      SANDBOX_SUPERVISOR_SECRET:
        process.env['SANDBOX_SUPERVISOR_SECRET'] || 'test-supervisor-secret-not-a-real-key-000000',
    },
  },
});
