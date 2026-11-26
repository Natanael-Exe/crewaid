import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveConfinedCwd, resolveWorkspaceRoot } from './path-guard.js';

describe('path-guard', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  it('resolves valid workspace root and confined subdirectories', () => {
    const rootDir = makeTempDir('crewaid-pg-root-');
    const subDir = path.join(rootDir, 'apps', 'web');
    mkdirSync(subDir, { recursive: true });

    const workspace = resolveWorkspaceRoot(rootDir);
    expect(workspace.workspaceName).toBe(path.basename(workspace.root));

    expect(resolveConfinedCwd(workspace.root, '.')).toEqual({
      normalizedRelative: '.',
      absoluteCwd: workspace.root,
    });
    expect(resolveConfinedCwd(workspace.root, './apps/web/')).toEqual({
      normalizedRelative: 'apps/web',
      absoluteCwd: path.join(workspace.root, 'apps', 'web'),
    });
  });

  it('rejects parent traversal, absolute paths, non-directories, and escaping symlinks', () => {
    const rootDir = makeTempDir('crewaid-pg-root-');
    const outsideDir = makeTempDir('crewaid-pg-outside-');
    const filePath = path.join(rootDir, 'README.md');
    writeFileSync(filePath, 'hello', 'utf8');
    symlinkSync(outsideDir, path.join(rootDir, 'escape-link'));

    const { root } = resolveWorkspaceRoot(rootDir);

    expect(() => resolveConfinedCwd(root, '../outside')).toThrow();
    expect(() => resolveConfinedCwd(root, '/etc')).toThrow();
    expect(() => resolveConfinedCwd(root, 'missing-folder')).toThrow();
    expect(() => resolveConfinedCwd(root, 'README.md')).toThrow(/not a directory/i);
    expect(() => resolveConfinedCwd(root, 'escape-link')).toThrow(/escapes/i);
  });
});
