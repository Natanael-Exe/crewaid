import {
  assertSupportedNodeVersion,
  BUILTIN_ACP_HARNESSES,
  BUILTIN_ACP_HARNESS_IDS,
  detectInstalledHarnesses,
  parseCommandLine,
  type BuiltinAcpHarnessId,
} from '@crewaid/acp-core';
import {
  LocalConnectorHarnessIdSchema,
  LocalConnectorReportModeSchema,
  type LocalConnectorHarnessId,
  type LocalConnectorReportMode,
} from '@crewaid/shared';

import { ConnectorClient } from './connector-client.js';
import { TerminalPrompter } from './local-prompts.js';
import { resolveWorkspaceRoot } from './path-guard.js';
import {
  buildConnectorWsUrl,
  defaultTokenStorePath,
  normalizeServerUrl,
  promptHiddenToken,
  readSavedToken,
  readTokenFromStream,
  saveToken,
  validateTokenFormat,
} from './token-store.js';

declare const __CREWAID_CONNECT_VERSION__: string | undefined;

export function cliVersion(): string {
  return typeof __CREWAID_CONNECT_VERSION__ === 'string' && __CREWAID_CONNECT_VERSION__ !== ''
    ? __CREWAID_CONNECT_VERSION__
    : '0.0.0-dev';
}

export type ParsedCliCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'harnesses' }
  | {
      readonly kind: 'connect';
      readonly dir: string;
      readonly url: string;
      readonly save: boolean;
      readonly tokenStdin: boolean;
      readonly harness?: LocalConnectorHarnessId;
      readonly allowHarnesses?: readonly LocalConnectorHarnessId[];
      readonly customCommand?: string;
      readonly reportMode: LocalConnectorReportMode;
      readonly trustServerApprovals: boolean;
      readonly disconnectGraceSec: number;
      readonly verbose: boolean;
    };

export const HELP_TEXT = `crewaid-connect — Connect a local repository and ACP coding harness to Crewaid

Usage:
  crewaid-connect <dir> --url <server-url> [options]
  crewaid-connect harnesses

Options:
  --url <url>                 Crewaid server URL (required)
  --save                      Save bearer token to ~/.config/crewaid/connectors.json (0600)
  --token-stdin               Read bearer token from stdin instead of interactive hidden prompt
  --harness <id>              Default harness (claude-code|codex|opencode|antigravity|custom)
  --allow-harnesses <csv>     Comma-separated allowlist of harnesses bots may invoke
  --cmd "<binary> [args...]"  Custom ACP harness command (parsed without a shell)
  --report <summary|full>     Reporting detail sent back to Crewaid (default: summary)
  --trust-server-approvals    Skip the local terminal y/N task confirmation prompt
  --disconnect-grace <sec>    Cancel active task if disconnected longer than <sec> (default: 60)
  --verbose                   Pass harness stderr diagnostics through to this terminal
  -v, --version               Print CLI version
  -h, --help                  Show this help
`;

function parseHarnessId(raw: string, flag: string): LocalConnectorHarnessId {
  const parsed = LocalConnectorHarnessIdSchema.safeParse(raw.trim());
  if (!parsed.success) {
    throw new Error(
      `Invalid value "${raw}" for ${flag}. Expected one of: ${BUILTIN_ACP_HARNESS_IDS.join(', ')}, custom.`,
    );
  }
  return parsed.data;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliCommand {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { kind: 'help' };
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    return { kind: 'version' };
  }
  if (argv[0] === 'harnesses') {
    return { kind: 'harnesses' };
  }

  let dir: string | undefined;
  let url: string | undefined;
  let save = false;
  let tokenStdin = false;
  let harness: LocalConnectorHarnessId | undefined;
  let allowHarnesses: LocalConnectorHarnessId[] | undefined;
  let customCommand: string | undefined;
  let reportMode: LocalConnectorReportMode = 'summary';
  let trustServerApprovals = false;
  let disconnectGraceSec = 60;
  let verbose = false;

  const takeValue = (index: number, flag: string): string => {
    const val = argv[index + 1];
    if (val === undefined || val.startsWith('-')) {
      throw new Error(`Option ${flag} requires a value.`);
    }
    return val;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--url':
        url = takeValue(i, arg);
        i += 1;
        break;
      case '--save':
        save = true;
        break;
      case '--token-stdin':
        tokenStdin = true;
        break;
      case '--harness':
        harness = parseHarnessId(takeValue(i, arg), arg);
        i += 1;
        break;
      case '--allow-harnesses': {
        const csv = takeValue(i, arg);
        allowHarnesses = csv
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item !== '')
          .map((item) => parseHarnessId(item, arg));
        if (allowHarnesses.length === 0) {
          throw new Error('--allow-harnesses must list at least one harness id.');
        }
        i += 1;
        break;
      }
      case '--cmd':
        customCommand = takeValue(i, arg);
        parseCommandLine(customCommand);
        i += 1;
        break;
      case '--report': {
        const rawMode = takeValue(i, arg);
        const parsedMode = LocalConnectorReportModeSchema.safeParse(rawMode);
        if (!parsedMode.success) {
          throw new Error(`Invalid --report mode "${rawMode}". Expected "summary" or "full".`);
        }
        reportMode = parsedMode.data;
        i += 1;
        break;
      }
      case '--trust-server-approvals':
        trustServerApprovals = true;
        break;
      case '--disconnect-grace': {
        const rawSec = takeValue(i, arg);
        const num = Number(rawSec);
        if (!Number.isFinite(num) || num < 5 || num > 600) {
          throw new Error('--disconnect-grace must be a number of seconds between 5 and 600.');
        }
        disconnectGraceSec = Math.round(num);
        i += 1;
        break;
      }
      case '--verbose':
        verbose = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        if (dir !== undefined) {
          throw new Error(`Unexpected extra argument: ${arg}`);
        }
        dir = arg;
        break;
    }
  }

  if (dir === undefined) {
    throw new Error('Missing target directory. Usage: crewaid-connect <dir> --url <server-url>');
  }
  if (url === undefined) {
    throw new Error('Missing --url <server-url>.');
  }

  return {
    kind: 'connect',
    dir,
    url: normalizeServerUrl(url),
    save,
    tokenStdin,
    ...(harness === undefined ? {} : { harness }),
    ...(allowHarnesses === undefined ? {} : { allowHarnesses }),
    ...(customCommand === undefined ? {} : { customCommand }),
    reportMode,
    trustServerApprovals,
    disconnectGraceSec,
    verbose,
  };
}

const HARNESS_INSTALL_HINTS: Readonly<Record<BuiltinAcpHarnessId, string>> = {
  'claude-code': 'npm install -g @agentclientprotocol/claude-agent-acp (requires Node >= 22)',
  codex: 'Install codex-acp on PATH (requires Node >= 22)',
  opencode: 'Install OpenCode (provides `opencode acp`)',
  antigravity: 'Install Google Antigravity CLI (provides `agy acp`)',
};

function formatHarnessesTable(): string {
  const detected = new Map(detectInstalledHarnesses().map((entry) => [entry.id, entry]));
  const lines = ['Detected local ACP coding harnesses:', ''];
  for (const id of BUILTIN_ACP_HARNESS_IDS) {
    const preset = BUILTIN_ACP_HARNESSES[id];
    const hit = detected.get(id);
    const status = hit !== undefined ? `installed (${hit.resolvedPath})` : 'not found';
    lines.push(`  - ${id.padEnd(12)} ${preset.label.padEnd(14)} ${status}`);
    if (hit === undefined) {
      lines.push(`    Install: ${HARNESS_INSTALL_HINTS[id]}`);
    }
  }
  lines.push('', 'Custom harnesses are also supported via --cmd "<binary> [args...]".');
  return lines.join('\n');
}

export async function runCli(argv: readonly string[]): Promise<number> {
  assertSupportedNodeVersion();

  let command: ParsedCliCommand;
  try {
    command = parseCliArgs(argv);
  } catch (error: unknown) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (command.kind === 'help') {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (command.kind === 'version') {
    process.stdout.write(`${cliVersion()}\n`);
    return 0;
  }
  if (command.kind === 'harnesses') {
    process.stdout.write(`${formatHarnessesTable()}\n`);
    return 0;
  }

  const workspace = resolveWorkspaceRoot(command.dir);
  const detected = detectInstalledHarnesses();
  const availableBuiltins = detected.map((h) => h.id);
  const allDetected: LocalConnectorHarnessId[] = [
    ...availableBuiltins,
    ...(command.customCommand !== undefined ? (['custom'] as const) : []),
  ];

  const harnesses: LocalConnectorHarnessId[] =
    command.allowHarnesses !== undefined
      ? [...command.allowHarnesses]
      : allDetected;

  if (harnesses.length === 0) {
    process.stderr.write(
      'No supported ACP coding harnesses were found on PATH.\n' +
        'Run `crewaid-connect harnesses` to see install instructions, or pass --cmd "<binary> [args...]".\n',
    );
    return 1;
  }

  if (harnesses.includes('custom') && command.customCommand === undefined) {
    process.stderr.write('Error: harness "custom" requires --cmd "<binary> [args...]".\n');
    return 1;
  }

  const defaultHarness: LocalConnectorHarnessId | null =
    command.harness !== undefined
      ? command.harness
      : command.customCommand !== undefined && command.allowHarnesses === undefined && availableBuiltins.length === 0
        ? 'custom'
        : (harnesses[0] ?? null);

  if (defaultHarness !== null && !harnesses.includes(defaultHarness)) {
    process.stderr.write(
      `Error: --harness "${defaultHarness}" is not in the enabled harness list (${harnesses.join(', ')}).\n`,
    );
    return 1;
  }

  const storePath = defaultTokenStorePath();
  const envToken = process.env['CREWAID_CONNECTOR_TOKEN']?.trim();
  let rawToken: string | null =
    envToken !== undefined && envToken !== ''
      ? envToken
      : readSavedToken(storePath, command.url, workspace.root);

  let tokenFromPrompt = false;
  if (rawToken === null) {
    rawToken = command.tokenStdin
      ? await readTokenFromStream(process.stdin)
      : await promptHiddenToken();
    tokenFromPrompt = true;
  }

  let token: string;
  try {
    token = validateTokenFormat(rawToken);
  } catch (error: unknown) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (command.save && (tokenFromPrompt || envToken !== undefined)) {
    saveToken(storePath, command.url, workspace.root, token);
    process.stderr.write(`Saved connector token to ${storePath} (0600).\n`);
  }

  const wsUrl = buildConnectorWsUrl(command.url);
  const prompter = new TerminalPrompter();

  const client = new ConnectorClient({
    wsUrl,
    token,
    cliVersion: cliVersion(),
    workspaceRoot: workspace.root,
    workspaceName: workspace.workspaceName,
    harnesses,
    defaultHarness,
    ...(command.customCommand === undefined ? {} : { customCommand: command.customCommand }),
    reportMode: command.reportMode,
    trustServerApprovals: command.trustServerApprovals,
    disconnectGraceMs: command.disconnectGraceSec * 1_000,
    verbose: command.verbose,
    confirmTask: (req, signal) => prompter.confirmTask(req, signal),
    requestPermission: (req, signal) => prompter.requestPermission(req, signal),
  });

  const onSignal = () => {
    process.stderr.write('\nShutting down crewaid-connect…\n');
    client.stop(0);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  process.stderr.write(
    `Connecting "${workspace.workspaceName}" to ${wsUrl} (report=${command.reportMode}, localConfirm=${command.trustServerApprovals ? 'off' : 'on'})…\n`,
  );
  client.start();
  const exitCode = await client.done;
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  return exitCode;
}
