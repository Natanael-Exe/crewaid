import { randomBytes } from 'node:crypto';

/**
 * Every secret a self-hosted server needs, in the formats the orchestrator
 * reads (see infra/selfhost/.env.example). Hex where a value goes into a URL.
 */
export function generateSecrets() {
  return {
    POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
    REDIS_PASSWORD: randomBytes(24).toString('hex'),
    BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
    CREWAID_CREDENTIAL_KEYRING: JSON.stringify({ 1: randomBytes(32).toString('hex') }),
    CREDENTIAL_KEY: randomBytes(32).toString('hex'),
    SANDBOX_SUPERVISOR_SECRET: supervisorSecret(),
  };
}

/**
 * Signs the orchestrator's requests to the sandbox supervisor (D-200). Shared
 * by the two services and nothing else; it never enters a computer.
 */
export function supervisorSecret() {
  return randomBytes(32).toString('hex');
}
