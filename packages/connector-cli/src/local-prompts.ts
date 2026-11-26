import { execFile } from 'node:child_process';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { AcpPermissionDecision, AcpPermissionRequest } from '@crewaid/acp-core';
import type { LocalConnectorHarnessId, LocalConnectorReportMode } from '@crewaid/shared';

export interface LocalTaskConfirmRequest {
  readonly botName: string;
  readonly workspaceName: string;
  readonly relativeCwd: string;
  readonly harness: LocalConnectorHarnessId;
  readonly reportMode: LocalConnectorReportMode;
  readonly prompt: string;
  readonly verifyCommand?: string;
}

export interface LocalPromptIO {
  readonly input: Readable;
  readonly output: Writable;
  readonly notify?: (title: string, body: string) => void;
}

/**
 * Best-effort local OS alert + terminal bell so the operator notices an
 * incoming task confirmation or ACP permission prompt even when the terminal
 * is behind another window. Never throws or blocks.
 */
export function notifyLocal(
  title: string,
  body: string,
  output: Writable & { readonly isTTY?: boolean } = process.stderr,
): void {
  if (process.env['CREWAID_NO_NOTIFY'] === '1') return;
  if (output.isTTY === true) {
    try {
      output.write('\x07');
    } catch {
      // Ignore TTY write errors.
    }
  }
  const cleanTitle = title.replace(/[\r\n]+/g, ' ').slice(0, 80);
  const cleanBody = body.replace(/[\r\n]+/g, ' ').slice(0, 160);
  if (process.platform === 'darwin') {
    const script = `display notification ${JSON.stringify(cleanBody)} with title ${JSON.stringify(cleanTitle)}`;
    try {
      const child = execFile('osascript', ['-e', script], { timeout: 2_000 }, () => undefined);
      child.unref();
    } catch {
      // Best-effort only.
    }
  } else if (process.platform === 'linux') {
    try {
      const child = execFile('notify-send', [cleanTitle, cleanBody], { timeout: 2_000 }, () => undefined);
      child.unref();
    } catch {
      // Best-effort only.
    }
  }
}

function readLineWithAbort(
  input: Readable,
  output: Writable,
  question: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted === true) return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: false });
    let settled = false;
    const finish = (answer: string | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      rl.close();
      resolve(answer);
    };
    const onAbort = () => {
      output.write('\n[cancelled]\n');
      finish(null);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    rl.once('close', () => finish(null));
    output.write(question);
    rl.once('line', (line) => finish(line.trim()));
  });
}

/**
 * Serializes terminal prompts so overlapping alerts never interleave stdin reads.
 */
export class TerminalPrompter {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly notify: (title: string, body: string) => void;

  constructor(io?: Partial<LocalPromptIO>) {
    this.input = io?.input ?? process.stdin;
    this.output = io?.output ?? process.stderr;
    this.notify = io?.notify ?? ((title, body) => notifyLocal(title, body, this.output));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Default-ON local confirmation before launching a harness. Displays the
   * requesting bot, target folder, report mode, and full verbatim prompt.
   */
  confirmTask(req: LocalTaskConfirmRequest, signal?: AbortSignal): Promise<boolean> {
    return this.enqueue(async () => {
      if (signal?.aborted === true) return false;
      const lines = [
        '',
        '────────────────────────────────────────────────────────────',
        `Incoming Crewaid local coding task`,
        `  Bot:         ${req.botName}`,
        `  Workspace:   ${req.workspaceName} (${req.relativeCwd})`,
        `  Harness:     ${req.harness}`,
        `  Report mode: ${req.reportMode}`,
        ...(req.verifyCommand === undefined ? [] : [`  Verify cmd:  ${req.verifyCommand}`]),
        '  Prompt (verbatim):',
        ...req.prompt.split('\n').map((line) => `    ${line}`),
        '────────────────────────────────────────────────────────────',
        '',
      ];
      this.output.write(lines.join('\n'));
      this.notify(
        `Crewaid task from ${req.botName}`,
        `Confirm local ${req.harness} task in ${req.workspaceName}`,
      );
      const answer = await readLineWithAbort(
        this.input,
        this.output,
        'Run this task? [y/N] ',
        signal,
      );
      if (answer === null) return false;
      const normalized = answer.toLowerCase();
      return normalized === 'y' || normalized === 'yes';
    });
  }

  /**
   * Local-only ACP `session/request_permission` prompt. Fail-closed: empty,
   * invalid, EOF, or aborted input cancels the permission request.
   */
  requestPermission(
    req: AcpPermissionRequest,
    signal?: AbortSignal,
  ): Promise<AcpPermissionDecision> {
    return this.enqueue(async () => {
      if (signal?.aborted === true || req.options.length === 0) {
        return { outcome: 'cancelled' };
      }
      const lines = [
        '',
        `[Local permission required] ${req.title} (${req.toolKind})`,
        ...(req.locations.length > 0 ? [`  Files: ${req.locations.join(', ')}`] : []),
        ...req.options.map((opt, idx) => `  [${String(idx + 1)}] ${opt.name} (${opt.kind})`),
        `  [0] Deny / Cancel`,
      ];
      this.output.write(`${lines.join('\n')}\n`);
      this.notify('Crewaid local permission required', req.title);

      const answer = await readLineWithAbort(
        this.input,
        this.output,
        `Select option [0-${String(req.options.length)}] (default 0): `,
        signal,
      );
      if (answer === null || answer === '' || answer === '0') {
        return { outcome: 'cancelled' };
      }
      const index = Number.parseInt(answer, 10);
      if (!Number.isInteger(index) || index < 1 || index > req.options.length) {
        return { outcome: 'cancelled' };
      }
      const chosen = req.options[index - 1];
      if (chosen === undefined) return { outcome: 'cancelled' };
      return { outcome: 'selected', optionId: chosen.optionId };
    });
  }
}
