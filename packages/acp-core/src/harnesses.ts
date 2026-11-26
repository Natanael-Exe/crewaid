import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { AcpHarnessId } from './types.js';

export type BuiltinAcpHarnessId = Exclude<AcpHarnessId, 'custom'>;

export interface AcpHarnessPreset {
  readonly id: BuiltinAcpHarnessId;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Minimum Node major version required by the adapter binary, if any. */
  readonly minNodeMajor?: number;
}

/**
 * Built-in ACP harness presets (D-241 Steps 5–6).
 *
 * Uses the current official adapter binaries (`claude-agent-acp` from
 * `@agentclientprotocol/claude-agent-acp`, `codex-acp`, `opencode acp`,
 * `agy acp`) rather than deprecated Zed-era shims.
 */
export const BUILTIN_ACP_HARNESSES: Readonly<Record<BuiltinAcpHarnessId, AcpHarnessPreset>> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    command: 'claude-agent-acp',
    args: [],
    minNodeMajor: 22,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    command: 'codex-acp',
    args: [],
    minNodeMajor: 22,
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    command: 'agy',
    args: ['acp'],
  },
};

export const BUILTIN_ACP_HARNESS_IDS: readonly BuiltinAcpHarnessId[] = [
  'claude-code',
  'codex',
  'opencode',
  'antigravity',
];

export interface ResolvedHarnessCommand {
  readonly id: AcpHarnessId;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface DetectedHarness {
  readonly id: BuiltinAcpHarnessId;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly resolvedPath: string;
}

/**
 * Splits a `--cmd` string into `[binary, ...args]` without invoking a shell.
 * Supports single quotes, double quotes, and backslash escapes.
 */
export function parseCommandLine(raw: string): readonly string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaping = false;
  let started = false;

  for (const ch of raw) {
    if (escaping) {
      current += ch;
      escaping = false;
      started = true;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaping = true;
      started = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      started = true;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      started = true;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }

  if (escaping || inSingle || inDouble) {
    throw new Error('Invalid custom harness command: unterminated quote or escape.');
  }
  if (started) {
    tokens.push(current);
  }
  if (tokens.length === 0 || tokens[0] === undefined || tokens[0].trim() === '') {
    throw new Error('Custom harness command must include a binary name.');
  }
  return tokens;
}

export function resolveHarnessCommand(
  id: AcpHarnessId,
  customCommand?: string,
): ResolvedHarnessCommand {
  if (id === 'custom') {
    if (customCommand === undefined || customCommand.trim() === '') {
      throw new Error('Custom harness requires a non-empty command.');
    }
    const [command, ...args] = parseCommandLine(customCommand);
    if (command === undefined) {
      throw new Error('Custom harness command must include a binary name.');
    }
    return {
      id: 'custom',
      label: path.basename(command),
      command,
      args,
    };
  }
  const preset = BUILTIN_ACP_HARNESSES[id];
  return {
    id: preset.id,
    label: preset.label,
    command: preset.command,
    args: preset.args,
  };
}

export interface DetectHarnessesOptions {
  readonly pathEnv?: string | undefined;
  readonly pathExtEnv?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly isExecutable?: ((candidatePath: string) => boolean) | undefined;
}

function defaultIsExecutable(candidatePath: string): boolean {
  try {
    accessSync(candidatePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutableOnPath(
  binary: string,
  options: DetectHarnessesOptions = {},
): string | null {
  const check = options.isExecutable ?? defaultIsExecutable;
  const platform = options.platform ?? process.platform;
  if (path.isAbsolute(binary) || binary.includes('/') || binary.includes('\\')) {
    return check(binary) ? binary : null;
  }
  const pathEnv = options.pathEnv ?? process.env['PATH'] ?? '';
  const separator = platform === 'win32' ? ';' : ':';
  const dirs = pathEnv.split(separator).filter((entry) => entry !== '');
  const exts =
    platform === 'win32'
      ? (options.pathExtEnv ?? process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter((ext) => ext !== '')
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

export function detectInstalledHarnesses(options: DetectHarnessesOptions = {}): DetectedHarness[] {
  const found: DetectedHarness[] = [];
  for (const id of BUILTIN_ACP_HARNESS_IDS) {
    const preset = BUILTIN_ACP_HARNESSES[id];
    const resolvedPath = findExecutableOnPath(preset.command, options);
    if (resolvedPath !== null) {
      found.push({
        id: preset.id,
        label: preset.label,
        command: preset.command,
        args: preset.args,
        resolvedPath,
      });
    }
  }
  return found;
}

/**
 * Verifies the local Node.js runtime meets the minimum version required by
 * Crewaid's connector and ACP adapters (Node >= 22).
 */
export function assertSupportedNodeVersion(
  version: string = process.versions.node,
  minMajor = 22,
): void {
  const majorStr = version.replace(/^v/i, '').split('.')[0] ?? '';
  const major = Number.parseInt(majorStr, 10);
  if (!Number.isFinite(major) || major < minMajor) {
    throw new Error(
      `Node.js >= ${String(minMajor)} is required (detected ${version}). ` +
        'Upgrade Node.js before running Crewaid ACP harnesses.',
    );
  }
}
