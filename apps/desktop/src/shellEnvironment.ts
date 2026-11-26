import { execFileSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuiltinLocalHarnessId, LocalHarnessProbeItem } from './localConnectorTypes.js';

interface HarnessDescriptor {
  readonly id: BuiltinLocalHarnessId;
  readonly label: string;
  readonly command: string;
  readonly installCommandFor: (platform: NodeJS.Platform) => string | null;
  readonly installHintFor: (platform: NodeJS.Platform) => string;
}

export const DESKTOP_BUILTIN_HARNESSES: readonly HarnessDescriptor[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    command: 'claude-agent-acp',
    installCommandFor: () => 'npm install -g @agentclientprotocol/claude-agent-acp',
    installHintFor: () => 'npm install -g @agentclientprotocol/claude-agent-acp',
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex-acp',
    installCommandFor: () => 'npm install -g @agentclientprotocol/codex-acp',
    installHintFor: () => 'npm install -g @agentclientprotocol/codex-acp',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    installCommandFor: (platform) =>
      platform === 'win32'
        ? 'npm install -g opencode-ai'
        : 'curl -fsSL https://opencode.ai/install | bash',
    installHintFor: (platform) =>
      platform === 'win32'
        ? 'npm install -g opencode-ai'
        : 'curl -fsSL https://opencode.ai/install | bash',
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    command: 'agy',
    installCommandFor: (platform) =>
      platform === 'win32'
        ? 'irm https://antigravity.google/cli/install.ps1 | iex'
        : 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    installHintFor: (platform) =>
      platform === 'win32'
        ? 'irm https://antigravity.google/cli/install.ps1 | iex'
        : 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  },
];

const ENV_START_MARKER = '__CREWAID_SHELL_ENV_START__';
const ENV_END_MARKER = '__CREWAID_SHELL_ENV_END__';

function compareSemverDesc(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function discoverExtraPathDirs(homeDir: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const dirs: string[] = [];
    const appData = process.env['APPDATA'];
    if (typeof appData === 'string' && appData !== '') {
      dirs.push(path.win32.join(appData, 'npm'));
    }
    const localAppData = process.env['LOCALAPPDATA'];
    if (typeof localAppData === 'string' && localAppData !== '') {
      dirs.push(path.win32.join(localAppData, 'agy', 'bin'));
    }
    dirs.push(path.win32.join(homeDir, '.local', 'bin'));
    return dirs;
  }

  const dirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    path.posix.join(homeDir, '.local', 'bin'),
    path.posix.join(homeDir, '.npm-global', 'bin'),
    path.posix.join(homeDir, '.volta', 'bin'),
    path.posix.join(homeDir, '.bun', 'bin'),
    path.posix.join(homeDir, '.cargo', 'bin'),
    path.posix.join(homeDir, '.opencode', 'bin'),
    path.posix.join(homeDir, '.antigravity', 'antigravity', 'bin'),
  ];

  // Include the newest nvm Node bin directory if present so global npm CLIs
  // installed under nvm are found even when launched from Finder/Dock.
  const nvmDir = path.posix.join(homeDir, '.nvm', 'versions', 'node');
  try {
    if (existsSync(nvmDir)) {
      const versions = readdirSync(nvmDir).sort(compareSemverDesc);
      for (const ver of versions.slice(0, 3)) {
        dirs.push(path.posix.join(nvmDir, ver, 'bin'));
      }
    }
  } catch {
    // Ignore unreadable nvm directories.
  }

  return dirs;
}

export function mergePathEntries(
  basePath: string | undefined,
  extras: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const sep = platform === 'win32' ? ';' : ':';
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (entry: string) => {
    const trimmed = entry.trim();
    if (trimmed === '') return;
    const key = platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(trimmed);
  };
  for (const part of (basePath ?? '').split(sep)) push(part);
  for (const extra of extras) push(extra);
  return ordered.join(sep);
}

/**
 * Parses `env -0` output delimited by our start/end markers so stray profile
 * banners printed by `.zprofile` / `.bash_profile` never corrupt keys.
 */
export function parseNullDelimitedEnv(raw: string): Record<string, string> | null {
  const start = raw.indexOf(ENV_START_MARKER);
  if (start === -1) return null;
  const end = raw.indexOf(ENV_END_MARKER, start + ENV_START_MARKER.length);
  if (end === -1) return null;
  const payload = raw.slice(start + ENV_START_MARKER.length, end);
  const parsed: Record<string, string> = {};
  for (const entry of payload.split('\0')) {
    if (entry === '') continue;
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    const val = entry.slice(eq + 1);
    parsed[key] = val;
  }
  return parsed;
}

export interface ResolveShellEnvOptions {
  readonly platform?: NodeJS.Platform;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly runLoginShell?: (shellPath: string) => string | null;
}

function defaultRunLoginShell(shellPath: string): string | null {
  try {
    return execFileSync(
      shellPath,
      ['-lc', `printf '${ENV_START_MARKER}'; env -0; printf '${ENV_END_MARKER}'`],
      {
        encoding: 'utf8',
        timeout: 4_000,
        maxBuffer: 512 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
  } catch {
    return null;
  }
}

/**
 * Resolves the user's login-shell environment so packaged GUI apps launched
 * from Finder/Dock still find Homebrew, nvm, volta, and ~/.local/bin CLIs.
 * Strips connector secrets and falls back gracefully if the shell times out.
 */
export function resolveShellEnvironment(
  options: ResolveShellEnvOptions = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const baseEnv = options.baseEnv ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const merged: NodeJS.ProcessEnv = { ...baseEnv };

  if (platform === 'darwin' || platform === 'linux') {
    const shell =
      typeof baseEnv['SHELL'] === 'string' && baseEnv['SHELL'].trim() !== ''
        ? baseEnv['SHELL'].trim()
        : platform === 'darwin'
          ? '/bin/zsh'
          : '/bin/sh';
    const raw = (options.runLoginShell ?? defaultRunLoginShell)(shell);
    if (raw !== null) {
      const fromShell = parseNullDelimitedEnv(raw);
      if (fromShell !== null) {
        for (const [key, val] of Object.entries(fromShell)) {
          merged[key] = val;
        }
      }
    }
  }

  const extras = discoverExtraPathDirs(homeDir, platform).filter((dir) => {
    try {
      return existsSync(dir);
    } catch {
      return false;
    }
  });
  merged['PATH'] = mergePathEntries(merged['PATH'], extras, platform);
  delete merged['CREWAID_CONNECTOR_TOKEN'];
  return merged;
}

function defaultIsExecutable(candidatePath: string): boolean {
  try {
    accessSync(candidatePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutableInEnv(
  binary: string,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly isExecutable?: (candidate: string) => boolean;
  } = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const check = options.isExecutable ?? defaultIsExecutable;
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = (env['PATH'] ?? '').split(sep).filter((d) => d !== '');
  const exts =
    platform === 'win32'
      ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((e) => e !== '')
      : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate =
        platform === 'win32'
          ? path.win32.join(dir, `${binary}${ext}`)
          : path.posix.join(dir, binary);
      if (check(candidate)) return candidate;
    }
  }
  return null;
}

export function detectLocalHarnesses(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly isExecutable?: (candidate: string) => boolean;
} = {}): readonly LocalHarnessProbeItem[] {
  const platform = options.platform ?? process.platform;
  return DESKTOP_BUILTIN_HARNESSES.map((descriptor) => {
    const resolvedPath = findExecutableInEnv(descriptor.command, options);
    return {
      id: descriptor.id,
      label: descriptor.label,
      command: descriptor.command,
      available: resolvedPath !== null,
      resolvedPath,
      installCommand: descriptor.installCommandFor(platform),
      installHint: descriptor.installHintFor(platform),
    };
  });
}
