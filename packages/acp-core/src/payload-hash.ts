import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * Fixed-order task payload fingerprint shared by the orchestrator and the
 * local connector CLI (D-241 Step 5).
 *
 * Living here rather than in `@crewaid/shared` keeps `@crewaid/shared`
 * browser-safe for the desktop renderer while guaranteeing that server and CLI
 * hash identical inputs with zero drift. On the server this hash binds the
 * operator's approval; on the CLI re-checking it catches wire/routing bugs
 * (it is not a trust boundary against a compromised server).
 */

export interface LocalTaskHashInput {
  readonly botId: string;
  readonly connectorId: string;
  readonly relativeCwd: string;
  readonly harness: string;
  readonly prompt: string;
  readonly verifyCommand?: string | undefined;
}

/**
 * Normalizes a connector-relative folder path so `""`, `"."`, `"./"`, and
 * `"apps/web/"` all hash identically across OSes and callers.
 */
export function normalizeRelativeCwd(raw: string | undefined): string {
  if (raw === undefined) return '.';
  const trimmed = raw.trim().replaceAll('\\', '/');
  if (trimmed === '' || trimmed === '.' || trimmed === './') return '.';
  const normalized = path.posix.normalize(trimmed).replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') return '.';
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

export function computeLocalTaskPayloadHash(input: LocalTaskHashInput): string {
  const canonical = JSON.stringify([
    input.botId,
    input.connectorId,
    normalizeRelativeCwd(input.relativeCwd),
    input.harness,
    input.prompt,
    input.verifyCommand ?? '',
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
