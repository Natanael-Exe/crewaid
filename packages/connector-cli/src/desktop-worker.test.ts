import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { computeLocalTaskPayloadHash } from '@crewaid/acp-core';
import {
  CONNECTOR_WS_PATH,
  type ConnectorClientFrame,
  type ConnectorServerFrame,
} from '@crewaid/shared';

import { parseCliArgs } from './cli.js';
import {
  attachDesktopWorker,
  type DesktopWorkerInboundMessage,
  type DesktopWorkerOutboundMessage,
  type DesktopWorkerPort,
} from './desktop-worker.js';

const PKG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_AGENT = path.join(PKG_DIR, '..', 'acp-core', 'test', 'mock-acp-agent.mjs');
const TOKEN = 'crw_conn_worker_test_token_0123456789abcdef0123';
const CONNECTOR_ID = 'clconn000000000000000042';
const BOT_ID = 'clbot0000000000000000042';

function createFakeWorkerPort(): {
  readonly port: DesktopWorkerPort;
  readonly outbound: DesktopWorkerOutboundMessage[];
  readonly sendFromMain: (msg: DesktopWorkerInboundMessage) => void;
  readonly waitForOutbound: <T extends DesktopWorkerOutboundMessage['type']>(
    type: T,
    predicate?: (msg: Extract<DesktopWorkerOutboundMessage, { type: T }>) => boolean,
  ) => Promise<Extract<DesktopWorkerOutboundMessage, { type: T }>>;
} {
  const listeners: Array<(event: { readonly data: unknown }) => void> = [];
  const outbound: DesktopWorkerOutboundMessage[] = [];
  const waiters: Array<{
    predicate: (msg: DesktopWorkerOutboundMessage) => boolean;
    resolve: (msg: DesktopWorkerOutboundMessage) => void;
  }> = [];

  const port: DesktopWorkerPort = {
    on: (_event, listener) => {
      listeners.push(listener);
    },
    postMessage: (msg) => {
      outbound.push(msg);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i]!;
        if (waiter.predicate(msg)) {
          waiters.splice(i, 1);
          waiter.resolve(msg);
        }
      }
    },
  };

  return {
    port,
    outbound,
    sendFromMain: (msg) => {
      for (const listener of listeners) listener({ data: msg });
    },
    waitForOutbound: <T extends DesktopWorkerOutboundMessage['type']>(
      type: T,
      predicate?: (msg: Extract<DesktopWorkerOutboundMessage, { type: T }>) => boolean,
    ): Promise<Extract<DesktopWorkerOutboundMessage, { type: T }>> => {
      const matches = (
        msg: DesktopWorkerOutboundMessage,
      ): msg is Extract<DesktopWorkerOutboundMessage, { type: T }> =>
        msg.type === type &&
        (predicate === undefined ||
          predicate(msg as Extract<DesktopWorkerOutboundMessage, { type: T }>));
      const existing = outbound.find(matches);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<Extract<DesktopWorkerOutboundMessage, { type: T }>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for worker message ${type}`)),
          8_000,
        );
        waiters.push({
          predicate: matches,
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg as Extract<DesktopWorkerOutboundMessage, { type: T }>);
          },
        });
      });
    },
  };
}

describe('parseCliArgs default directory', () => {
  it('defaults dir to "." when omitted', () => {
    const parsed = parseCliArgs(['--url', 'https://crewaid.example']);
    expect(parsed).toMatchObject({ kind: 'connect', dir: '.', url: 'https://crewaid.example' });
  });
});

describe('attachDesktopWorker (Electron utilityProcess worker)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn !== undefined) await fn();
    }
  });

  it('routes task confirmation and ACP permission prompts over MessagePort IPC', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'crewaid-worker-'));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));

    const wss = new WebSocketServer({ noServer: true });
    const httpServer: Server = createServer();
    const sockets: WebSocket[] = [];
    const results: ConnectorClientFrame[] = [];
    let resolveResult!: (frame: Extract<ConnectorClientFrame, { type: 'task.result' }>) => void;
    const resultPromise = new Promise<Extract<ConnectorClientFrame, { type: 'task.result' }>>(
      (resolve) => {
        resolveResult = resolve;
      },
    );

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== CONNECTOR_WS_PATH || req.headers.authorization !== `Bearer ${TOKEN}`) {
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
          results.push(frame);
          if (frame.type === 'connector.hello') {
            ws.send(
              JSON.stringify({
                type: 'connector.welcome',
                connectorId: CONNECTOR_ID,
                name: 'My Repo',
                heartbeatMs: 15_000,
              } satisfies ConnectorServerFrame),
            );
          } else if (frame.type === 'task.result') {
            resolveResult(frame);
          }
        });
      });
    });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const portNum = (httpServer.address() as AddressInfo).port;
    cleanups.push(async () => {
      for (const s of sockets) s.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
    });

    const fake = createFakeWorkerPort();
    attachDesktopWorker(fake.port, {
      detectHarnesses: () => ['claude-code'],
      resolveHarness: (id) => ({
        id,
        label: 'Mock ACP',
        command: process.execPath,
        args: [MOCK_AGENT, 'permission'],
      }),
    });

    fake.sendFromMain({
      type: 'start',
      config: {
        connectorId: CONNECTOR_ID,
        directory: workspace,
        serverUrl: `http://127.0.0.1:${String(portNum)}`,
        token: TOKEN,
        reportMode: 'summary',
        confirmInApp: true,
        cliVersion: '0.1.6',
      },
    });
    cleanups.push(() => fake.sendFromMain({ type: 'stop' }));

    await fake.waitForOutbound('state', (m) => m.state === 'online');

    const prompt = 'Run local verification';
    sockets[0]!.send(
      JSON.stringify({
        type: 'task.dispatch',
        sessionId: 'sess_worker_1',
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
      } satisfies ConnectorServerFrame),
    );

    const confirmMsg = await fake.waitForOutbound('confirm_task');
    expect(confirmMsg.request.prompt).toBe(prompt);
    fake.sendFromMain({
      type: 'confirm_response',
      requestId: confirmMsg.requestId,
      approved: true,
    });

    const permMsg = await fake.waitForOutbound('request_permission');
    expect(permMsg.request.title).toBe('Run pnpm test');
    fake.sendFromMain({
      type: 'permission_response',
      requestId: permMsg.requestId,
      decision: { outcome: 'selected', optionId: 'allow_1' },
    });

    const taskResult = await resultPromise;
    expect(taskResult.status).toBe('completed');
    expect(taskResult.summary).toContain('Permission approved');
  });

  it('reports NO_HARNESSES_FOUND permanently when no local ACP harness is installed', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'crewaid-worker-empty-'));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));

    const fake = createFakeWorkerPort();
    attachDesktopWorker(fake.port, { detectHarnesses: () => [] });

    fake.sendFromMain({
      type: 'start',
      config: {
        connectorId: CONNECTOR_ID,
        directory: workspace,
        serverUrl: 'http://127.0.0.1:3000',
        token: TOKEN,
        reportMode: 'summary',
        confirmInApp: true,
      },
    });

    const errState = await fake.waitForOutbound('state', (m) => m.state === 'error');
    expect(errState.error).toBe('NO_HARNESSES_FOUND');
    expect(errState.permanent).toBe(true);
  });
});
