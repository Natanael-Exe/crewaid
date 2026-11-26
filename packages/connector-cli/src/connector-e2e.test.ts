import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { computeLocalTaskPayloadHash } from '@crewaid/acp-core';
import {
  CONNECTOR_WS_PATH,
  type ConnectorClientFrame,
  type ConnectorServerFrame,
} from '@crewaid/shared';

import { ConnectorClient } from './connector-client.js';

const PKG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_AGENT = path.join(PKG_DIR, '..', 'acp-core', 'test', 'mock-acp-agent.mjs');
const BUNDLE_PATH = path.join(PKG_DIR, 'dist', 'bin.mjs');

const TOKEN = 'crw_conn_e2e_test_token_0123456789abcdef012345';
const CONNECTOR_ID = 'clconn000000000000000009';
const BOT_ID = 'clbot0000000000000000009';

interface LoopbackServer {
  readonly wsUrl: string;
  readonly sockets: WebSocket[];
  readonly received: ConnectorClientFrame[];
  readonly waitForFrame: (
    predicate: (frame: ConnectorClientFrame) => boolean,
    timeoutMs?: number,
  ) => Promise<ConnectorClientFrame>;
  readonly sendToLatest: (frame: ConnectorServerFrame) => void;
  readonly close: () => Promise<void>;
}

async function startMockOrchestrator(options: {
  readonly onHello?: (ws: WebSocket, frame: Extract<ConnectorClientFrame, { type: 'connector.hello' }>) => void;
} = {}): Promise<LoopbackServer> {
  const wss = new WebSocketServer({ noServer: true });
  const httpServer: Server = createServer();
  const sockets: WebSocket[] = [];
  const received: ConnectorClientFrame[] = [];
  const waiters: Array<{
    predicate: (frame: ConnectorClientFrame) => boolean;
    resolve: (frame: ConnectorClientFrame) => void;
  }> = [];

  httpServer.on('upgrade', (req, socket, head) => {
    const auth = req.headers.authorization;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== CONNECTOR_WS_PATH || auth !== `Bearer ${TOKEN}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws);
      ws.on('message', (raw) => {
        const text =
          typeof raw === 'string'
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString('utf8')
              : Array.isArray(raw)
                ? Buffer.concat(raw).toString('utf8')
                : Buffer.from(raw).toString('utf8');
        const frame = JSON.parse(text) as ConnectorClientFrame;
        received.push(frame);
        if (frame.type === 'connector.hello') {
          if (options.onHello !== undefined) {
            options.onHello(ws, frame);
          } else {
            ws.send(
              JSON.stringify({
                type: 'connector.welcome',
                connectorId: CONNECTOR_ID,
                name: 'Dev Laptop',
                heartbeatMs: 15_000,
              } satisfies ConnectorServerFrame),
            );
          }
        }
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          const waiter = waiters[i]!;
          if (waiter.predicate(frame)) {
            waiters.splice(i, 1);
            waiter.resolve(frame);
          }
        }
      });
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (httpServer.address() as AddressInfo).port;

  return {
    wsUrl: `ws://127.0.0.1:${String(port)}${CONNECTOR_WS_PATH}`,
    sockets,
    received,
    waitForFrame: (predicate, timeoutMs = 8_000) => {
      const existing = received.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<ConnectorClientFrame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for WS frame')), timeoutMs);
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
    sendToLatest: (frame) => {
      const latest = sockets.at(-1);
      if (latest === undefined) throw new Error('No connected CLI socket');
      latest.send(JSON.stringify(frame));
    },
    close: async () => {
      for (const s of sockets) s.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

describe('ConnectorClient end-to-end (loopback WS + real ACP subprocess)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn !== undefined) await fn();
    }
  });

  function makeWorkspace(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'crewaid-e2e-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it('runs local confirmation, local-only permission prompt, summary redaction, and chatty stderr drain', async () => {
    const workspace = makeWorkspace();
    const srv = await startMockOrchestrator();
    cleanups.push(srv.close);

    const confirmTask = vi.fn(() => Promise.resolve(true));
    const requestPermission = vi.fn(() =>
      Promise.resolve({
        outcome: 'selected' as const,
        optionId: 'allow_1',
      }),
    );
    let stderrBytes = 0;

    let scenario = 'happy';
    const client = new ConnectorClient({
      wsUrl: srv.wsUrl,
      token: TOKEN,
      cliVersion: '0.1.0',
      workspaceRoot: workspace,
      workspaceName: 'repo',
      harnesses: ['claude-code'],
      defaultHarness: 'claude-code',
      reportMode: 'summary',
      trustServerApprovals: false,
      disconnectGraceMs: 5_000,
      log: () => undefined,
      confirmTask,
      requestPermission,
      resolveHarness: (id) => ({
        id,
        label: 'Mock ACP',
        command: process.execPath,
        args: [MOCK_AGENT, scenario],
      }),
      onHarnessStderr: (chunk) => {
        stderrBytes += chunk.length;
      },
    });
    cleanups.push(() => client.stop(0));
    client.start();

    await srv.waitForFrame((f) => f.type === 'connector.hello');

    // 1. Happy summary-mode task: drops raw secrets/diffs while preserving summary & command title
    const prompt1 = 'Fix src/app.ts';
    srv.sendToLatest({
      type: 'task.dispatch',
      sessionId: 'sess_happy',
      payloadHash: computeLocalTaskPayloadHash({
        botId: BOT_ID,
        connectorId: CONNECTOR_ID,
        relativeCwd: '.',
        harness: 'claude-code',
        prompt: prompt1,
      }),
      botId: BOT_ID,
      botName: 'Atlas',
      relativeCwd: '.',
      harness: 'claude-code',
      prompt: prompt1,
      maxDurationMs: 15_000,
    });

    const result1 = (await srv.waitForFrame(
      (f) => f.type === 'task.result' && f.sessionId === 'sess_happy',
    )) as Extract<ConnectorClientFrame, { type: 'task.result' }>;
    expect(confirmTask).toHaveBeenCalledWith(
      expect.objectContaining({ botName: 'Atlas', prompt: prompt1, reportMode: 'summary' }),
      expect.any(AbortSignal),
    );
    expect(result1.status).toBe('completed');
    expect(result1.filesChanged).toEqual(['src/app.ts']);
    expect(result1.commandsRun).toEqual([{ command: 'pnpm test', status: 'completed' }]);
    expect(result1.diffExcerpt).toBeUndefined();
    expect(result1.transcriptExcerpt).toBeUndefined();
    expect(JSON.stringify(result1)).not.toContain('RAW_FILE_BODY_SECRET_TOKEN_XYZ');
    expect(JSON.stringify(result1)).not.toContain('RAW_OLD_DIFF_CODE');

    // 2. Local permission roundtrip: emits waiting_local_permission -> resumed
    scenario = 'permission';
    const prompt2 = 'Run tests locally';
    srv.sendToLatest({
      type: 'task.dispatch',
      sessionId: 'sess_perm',
      payloadHash: computeLocalTaskPayloadHash({
        botId: BOT_ID,
        connectorId: CONNECTOR_ID,
        relativeCwd: '.',
        harness: 'claude-code',
        prompt: prompt2,
      }),
      botId: BOT_ID,
      botName: 'Atlas',
      relativeCwd: '.',
      harness: 'claude-code',
      prompt: prompt2,
      maxDurationMs: 15_000,
    });

    const result2 = (await srv.waitForFrame(
      (f) => f.type === 'task.result' && f.sessionId === 'sess_perm',
    )) as Extract<ConnectorClientFrame, { type: 'task.result' }>;
    expect(result2.status).toBe('completed');
    expect(result2.summary).toContain('Permission approved');
    expect(requestPermission).toHaveBeenCalledTimes(1);
    const permKinds = srv.received
      .filter((f) => f.type === 'task.progress' && f.sessionId === 'sess_perm')
      .map((f) => (f as Extract<ConnectorClientFrame, { type: 'task.progress' }>).kind);
    expect(permKinds).toContain('waiting_local_permission');
    expect(permKinds).toContain('resumed');

    // 3. Chatty stderr (> 256 KB) drains without freezing the harness
    scenario = 'chatty-stderr';
    const prompt3 = 'Chatty diagnostics';
    srv.sendToLatest({
      type: 'task.dispatch',
      sessionId: 'sess_chatty',
      payloadHash: computeLocalTaskPayloadHash({
        botId: BOT_ID,
        connectorId: CONNECTOR_ID,
        relativeCwd: '.',
        harness: 'claude-code',
        prompt: prompt3,
      }),
      botId: BOT_ID,
      botName: 'Atlas',
      relativeCwd: '.',
      harness: 'claude-code',
      prompt: prompt3,
      maxDurationMs: 15_000,
    });
    const result3 = (await srv.waitForFrame(
      (f) => f.type === 'task.result' && f.sessionId === 'sess_chatty',
    )) as Extract<ConnectorClientFrame, { type: 'task.result' }>;
    expect(result3.status).toBe('completed');
    expect(result3.summary).toContain('Completed after chatty stderr output');
    expect(stderrBytes).toBeGreaterThan(250_000);
  });

  it('declines locally without spawning harness and enforces local CONNECTOR_BUSY', async () => {
    const workspace = makeWorkspace();
    const srv = await startMockOrchestrator();
    cleanups.push(srv.close);

    let resolveConfirm!: (value: boolean) => void;
    let markConfirmStarted!: () => void;
    const confirmStarted = new Promise<void>((resolve) => {
      markConfirmStarted = resolve;
    });
    const confirmTask = vi.fn().mockImplementationOnce(() => {
      markConfirmStarted();
      return new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      });
    });
    const resolveHarness = vi.fn((id: 'claude-code' | 'codex' | 'opencode' | 'antigravity' | 'custom') => ({
      id,
      label: 'Mock ACP',
      command: process.execPath,
      args: [MOCK_AGENT, 'happy'],
    }));

    const client = new ConnectorClient({
      wsUrl: srv.wsUrl,
      token: TOKEN,
      cliVersion: '0.1.0',
      workspaceRoot: workspace,
      workspaceName: 'repo',
      harnesses: ['claude-code'],
      defaultHarness: 'claude-code',
      reportMode: 'summary',
      trustServerApprovals: false,
      disconnectGraceMs: 5_000,
      log: () => undefined,
      confirmTask,
      requestPermission: () => Promise.resolve({ outcome: 'cancelled' }),
      resolveHarness,
    });
    cleanups.push(() => client.stop(0));
    client.start();

    await srv.waitForFrame((f) => f.type === 'connector.hello');

    const prompt = 'First task';
    srv.sendToLatest({
      type: 'task.dispatch',
      sessionId: 'sess_1',
      payloadHash: computeLocalTaskPayloadHash({
        botId: BOT_ID,
        connectorId: CONNECTOR_ID,
        relativeCwd: '.',
        harness: 'claude-code',
        prompt,
      }),
      botId: BOT_ID,
      botName: 'Atlas',
      relativeCwd: '.',
      harness: 'claude-code',
      prompt,
      maxDurationMs: 15_000,
    });

    // Wait until sess_1 is awaiting local confirmation, then send overlapping sess_2
    await confirmStarted;
    srv.sendToLatest({
      type: 'task.dispatch',
      sessionId: 'sess_2',
      payloadHash: computeLocalTaskPayloadHash({
        botId: BOT_ID,
        connectorId: CONNECTOR_ID,
        relativeCwd: '.',
        harness: 'claude-code',
        prompt: 'Second task',
      }),
      botId: BOT_ID,
      botName: 'Atlas',
      relativeCwd: '.',
      harness: 'claude-code',
      prompt: 'Second task',
      maxDurationMs: 15_000,
    });

    const busyResult = (await srv.waitForFrame(
      (f) => f.type === 'task.result' && f.sessionId === 'sess_2',
    )) as Extract<ConnectorClientFrame, { type: 'task.result' }>;
    expect(busyResult.error?.code).toBe('CONNECTOR_BUSY');

    // Now decline sess_1 locally
    resolveConfirm(false);
    const declined = (await srv.waitForFrame(
      (f) => f.type === 'task.result' && f.sessionId === 'sess_1',
    )) as Extract<ConnectorClientFrame, { type: 'task.result' }>;
    expect(declined.error?.code).toBe('LOCAL_TASK_DECLINED');
    expect(resolveHarness).not.toHaveBeenCalled();
  });

  it('cancels the local harness when disconnected longer than disconnectGraceMs', async () => {
    const workspace = makeWorkspace();
    const srv = await startMockOrchestrator();
    cleanups.push(srv.close);

    const logs: string[] = [];
    const client = new ConnectorClient({
      wsUrl: srv.wsUrl,
      token: TOKEN,
      cliVersion: '0.1.0',
      workspaceRoot: workspace,
      workspaceName: 'repo',
      harnesses: ['claude-code'],
      defaultHarness: 'claude-code',
      reportMode: 'summary',
      trustServerApprovals: true,
      disconnectGraceMs: 120,
      reconnectBaseMs: 5_000,
      log: (line) => logs.push(line),
      confirmTask: () => Promise.resolve(true),
      requestPermission: () => Promise.resolve({ outcome: 'cancelled' }),
      resolveHarness: (id) => ({
        id,
        label: 'Mock ACP',
        command: process.execPath,
        args: [MOCK_AGENT, 'cancel'],
      }),
    });
    cleanups.push(() => client.stop(0));
    client.start();

    await srv.waitForFrame((f) => f.type === 'connector.hello');

    const prompt = 'Long running work';
    srv.sendToLatest({
      type: 'task.dispatch',
      sessionId: 'sess_drop',
      payloadHash: computeLocalTaskPayloadHash({
        botId: BOT_ID,
        connectorId: CONNECTOR_ID,
        relativeCwd: '.',
        harness: 'claude-code',
        prompt,
      }),
      botId: BOT_ID,
      botName: 'Atlas',
      relativeCwd: '.',
      harness: 'claude-code',
      prompt,
      maxDurationMs: 15_000,
    });

    await srv.waitForFrame(
      (f) =>
        f.type === 'task.progress' && f.sessionId === 'sess_drop' && f.kind === 'step',
    );

    // Shut down server completely so reconnect cannot succeed before disconnectGraceMs
    await srv.close();
    await vi.waitFor(
      () => {
        expect(logs.some((line) => line.includes('cancelling active local task sess_drop'))).toBe(
          true,
        );
      },
      { timeout: 3_000 },
    );
  });

  it.each([
    { code: 4001, reason: 'Token rotated' },
    { code: 4003, reason: 'CLI_OUTDATED' },
  ])('exits permanently with code 1 on close $code without reconnecting', async ({ code, reason }) => {
    const workspace = makeWorkspace();
    let connections = 0;
    const srv = await startMockOrchestrator({
      onHello: (ws) => {
        connections += 1;
        if (code === 4003) {
          ws.send(
            JSON.stringify({
              type: 'connector.error',
              code: 'CLI_OUTDATED',
              message: 'Please update crewaid-connect.',
            } satisfies ConnectorServerFrame),
          );
        }
        ws.close(code, reason);
      },
    });
    cleanups.push(srv.close);

    const client = new ConnectorClient({
      wsUrl: srv.wsUrl,
      token: TOKEN,
      cliVersion: '0.0.1',
      workspaceRoot: workspace,
      workspaceName: 'repo',
      harnesses: ['claude-code'],
      defaultHarness: 'claude-code',
      reportMode: 'summary',
      trustServerApprovals: true,
      disconnectGraceMs: 1_000,
      reconnectBaseMs: 20,
      log: () => undefined,
      confirmTask: () => Promise.resolve(true),
      requestPermission: () => Promise.resolve({ outcome: 'cancelled' }),
    });
    client.start();

    const exitCode = await client.done;
    expect(exitCode).toBe(1);
    expect(connections).toBe(1);
  });

  it('executes the standalone esbuild dist/bin.mjs bundle directly', () => {
    if (!existsSync(BUNDLE_PATH)) {
      execFileSync(process.execPath, [path.join(PKG_DIR, 'scripts', 'build.mjs')], {
        cwd: PKG_DIR,
        stdio: 'pipe',
      });
    }
    const helpOut = execFileSync(process.execPath, [BUNDLE_PATH, '--help'], {
      encoding: 'utf8',
    });
    expect(helpOut).toContain('crewaid-connect <dir> --url <server-url>');

    const harnessesOut = execFileSync(process.execPath, [BUNDLE_PATH, 'harnesses'], {
      encoding: 'utf8',
    });
    expect(harnessesOut).toContain('claude-code');
    expect(harnessesOut).toContain('codex');
  });
});
