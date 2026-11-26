import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { normalizeRelativeCwd } from '@crewaid/acp-core';

export interface WorkspaceRootInfo {
  readonly root: string;
  readonly workspaceName: string;
}

export interface ConfinedCwd {
  readonly normalizedRelative: string;
  readonly absoluteCwd: string;
}

/**
 * Resolves and verifies the operator-chosen repository root directory.
 * Follows symlinks once at startup so all subsequent confinement checks compare
 * canonical `realpath` prefixes.
 */
export function resolveWorkspaceRoot(dir: string): WorkspaceRootInfo {
  const trimmed = dir.trim();
  if (trimmed === '') {
    throw new Error('A target repository directory is required.');
  }
  let real: string;
  try {
    real = realpathSync(path.resolve(trimmed));
  } catch (error: unknown) {
    throw new Error(`Workspace directory does not exist: ${dir}`, { cause: error });
  }
  const stat = statSync(real);
  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${dir}`);
  }
  const workspaceName = path.basename(real) || real;
  return { root: real, workspaceName };
}

/**
 * Resolves a task's `relativeCwd` strictly inside `workspaceRoot`, rejecting
 * parent traversal (`..`), absolute paths, drive prefixes, missing folders,
 * non-directories, and symlinks whose real target escapes `workspaceRoot`.
 */
export function resolveConfinedCwd(
  workspaceRoot: string,
  relativeCwd: string | undefined,
): ConfinedCwd {
  const normalizedRelative = normalizeRelativeCwd(relativeCwd);
  const candidate =
    normalizedRelative === '.'
      ? workspaceRoot
      : path.resolve(workspaceRoot, normalizedRelative);

  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch (error: unknown) {
    throw new Error(`Requested folder "${normalizedRelative}" does not exist in workspace.`, {
      cause: error,
    });
  }

  const realRoot = realpathSync(workspaceRoot);
  const inside =
    realCandidate === realRoot || realCandidate.startsWith(`${realRoot}${path.sep}`);
  if (!inside) {
    throw new Error(
      `Requested folder "${normalizedRelative}" escapes the paired workspace root via symlink or path traversal.`,
    );
  }

  if (!statSync(realCandidate).isDirectory()) {
    throw new Error(`Requested path "${normalizedRelative}" is not a directory.`);
  }

  return { normalizedRelative, absoluteCwd: realCandidate };
}
