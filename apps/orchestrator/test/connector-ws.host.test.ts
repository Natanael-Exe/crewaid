import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  CONNECTOR_PROTOCOL_VERSION,
  CONNECTOR_WS_PATH,
  type ConnectorClientFrame,
  type ConnectorServerFrame,
} from '@crewaid/shared';

import {
  ConnectorDispatchError,
  ConnectorWsHost,
  type ConnectorWsHostOptions,
} from '../src/connectors/connector-ws.host.js';
import type {
  AuthenticatedConnector,
  ConnectorHostHooks,
  ConnectorsService,
} from '../src/connectors/connectors.service.js';
import type { StructuredLogger } from '../src/logging/structured-logger.js';

const VALID_TOKEN = 'crw_conn_test_token_0123456789abcdef0123456789';
const CONNECTOR_ID = 'clconn000000000000000001';
const USER_ID = 'cluser000000000000000001';
const BOT_ID = 'clbot0000000000000000001';
const HASH_64 = 'a'.repeat(64);

interface TestServer {
  readonly port: number;
  readonly host: ConnectorWsHost;
  readonly connectors: {
    readonly authenticateBearer: ReturnType<typeof vi.fn>;
    readonly markOnline: ReturnType<typeof vi.fn>;
    readonly markOffline: ReturnType<typeof vi.fn>;
    readonly touchHeartbeat: ReturnType<typeof vi.fn>;
    readonly notifyBusy: ReturnType<typeof vi.fn>;
    readonly attachHost: ReturnType<typeof vi.fn>;
  };
  readonly close: () => Promise<void>;
}

async function startWsServer(options?: ConnectorWsHostOptions): Promise<TestServer> {
  let attachedHooks: ConnectorHostHooks | undefined;
  const connectors = {
    authenticateBearer: vi.fn(async (token: string): Promise<AuthenticatedConnector | null> => {
      if (token === VALID_TOKEN) {
        return { connectorId: CONNECTOR_ID, userId: USER_ID, name: 'Test MacBook' };
      }
      return null;
    }),
    markOnline: vi.fn(async () => true),
    markOffline: vi.fn(async () => undefined),
    touchHeartbeat: vi.fn(async () => undefined),
    notifyBusy: vi.fn(),
    attachHost: vi.fn((hooks: ConnectorHostHooks) => {
      attachedHooks = hooks;
    }),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const host = new ConnectorWsHost(
    connectors as unknown as ConnectorsService,
    logger as unknown as StructuredLogger,
    {
      heartbeatMs: 5_000,
      disconnectGraceMs: 180,
      helloTimeoutMs: 500,
      cancelGraceMs: 80,
      ...options,
    },
  );
  expect(attachedHooks).toBeDefined();

  const httpServer: Server = createServer();
  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== CONNECTOR_WS_PATH) {
      socket.destroy();
      return;
    }
    host.server.handleUpgrade(req, socket, head, (ws) => {
      host.server.emit('connection', ws, req);
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (httpServer.address() as AddressInfo).port;

  return {
    port,
    host,
    connectors,
    close: async () => {
      host.onModuleDestroy();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function nextFrame(ws: WebSocket): Promise<ConnectorServerFrame> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: Buffer | string) => {
      cleanup();
      resolve(JSON.parse(data.toString()) as ConnectorServerFrame);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      ws.off('message', onMessage);
      ws.off('error', onError);
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
  });
}

async function connectCli(
  port: number,
  helloOverrides: Partial<Extract<ConnectorClientFrame, { type: 'connector.hello' }>> = {},
): Promise<{ ws: WebSocket; firstFrame: ConnectorServerFrame }> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}${CONNECTOR_WS_PATH}`, {
    headers: { authorization: `Bearer ${VALID_TOKEN}` },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const framePromise = nextFrame(ws);
  const hello: ConnectorClientFrame = {
    type: 'connector.hello',
    protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    cliVersion: '0.1.0',
    workspaceName: 'crewaid-public',
    hostName: 'dev-macbook',
    harnesses: ['claude-code', 'codex'],
    defaultHarness: 'claude-code',
    reportMode: 'summary',
    ...helloOverrides,
  };
  ws.send(JSON.stringify(hello));
  const firstFrame = await framePromise;
  return { ws, firstFrame };
}

describe('ConnectorWsHost (loopback WebSocket)', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      const fn = closers.pop();
      if (fn !== undefined) await fn();
    }
  });

  it('rejects missing, invalid, or query-string-only credentials with HTTP 401', async () => {
    const srv = await startWsServer();
    closers.push(srv.close);

    for (const attempt of [
      { url: `ws://127.0.0.1:${String(srv.port)}${CONNECTOR_WS_PATH}`, headers: {} },
      {
        url: `ws://127.0.0.1:${String(srv.port)}${CONNECTOR_WS_PATH}?token=${VALID_TOKEN}`,
        headers: {},
      },
      {
        url: `ws://127.0.0.1:${String(srv.port)}${CONNECTOR_WS_PATH}`,
        headers: { authorization: 'Bearer crw_conn_invalid_token_1234567890' },
      },
    ]) {
      const statusCode = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(attempt.url, { headers: attempt.headers });
        ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.once('open', () => {
          ws.close();
          reject(new Error('Expected 401 upgrade rejection'));
        });
      });
      expect(statusCode).toBe(401);
    }
  });

  it('rejects an outdated CLI protocol version with CLI_OUTDATED and close code 4003', async () => {
    const srv = await startWsServer({ minProtocolVersion: 2 });
    closers.push(srv.close);

    const ws = new WebSocket(`ws://127.0.0.1:${String(srv.port)}${CONNECTOR_WS_PATH}`, {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const framePromise = nextFrame(ws);
    const closePromise = nextClose(ws);
    ws.send(
      JSON.stringify({
        type: 'connector.hello',
        protocolVersion: 1,
        cliVersion: '0.0.1',
        workspaceName: 'repo',
        hostName: 'mac',
        harnesses: ['claude-code'],
        defaultHarness: 'claude-code',
        reportMode: 'summary',
      }),
    );

    const frame = await framePromise;
    expect(frame).toMatchObject({ type: 'connector.error', code: 'CLI_OUTDATED' });
    const closed = await closePromise;
    expect(closed.code).toBe(4003);
  });

  it('welcomes connector, streams progress + local permission states, enforces CONNECTOR_BUSY, and settles result', async () => {
    const srv = await startWsServer();
    closers.push(srv.close);

    const { ws, firstFrame } = await connectCli(srv.port);
    expect(firstFrame).toMatchObject({
      type: 'connector.welcome',
      connectorId: CONNECTOR_ID,
      name: 'Test MacBook',
    });
    expect(srv.host.isConnectedLocally(CONNECTOR_ID)).toBe(true);
    expect(srv.connectors.markOnline).toHaveBeenCalledTimes(1);

    const dispatchedPromise = nextFrame(ws);
    const progressFrames: unknown[] = [];
    const taskPromise = srv.host.dispatchTask({
      connectorId: CONNECTOR_ID,
      sessionId: 'lcode_session_1',
      payloadHash: HASH_64,
      botId: BOT_ID,
      botName: 'Atlas',
      relativeCwd: 'apps/web',
      harness: 'claude-code',
      prompt: 'Fix the flaky test',
      verifyCommand: 'pnpm test',
      maxDurationMs: 60_000,
      onProgress: (frame) => progressFrames.push(frame),
    });

    // Strictly one concurrent task per connector
    await expect(
      srv.host.dispatchTask({
        connectorId: CONNECTOR_ID,
        sessionId: 'lcode_session_2',
        payloadHash: HASH_64,
        botId: BOT_ID,
        botName: 'Atlas',
        relativeCwd: '.',
        harness: 'claude-code',
        prompt: 'Second concurrent task',
        maxDurationMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_BUSY' } satisfies Partial<ConnectorDispatchError>);

    const dispatch = await dispatchedPromise;
    expect(dispatch).toMatchObject({
      type: 'task.dispatch',
      sessionId: 'lcode_session_1',
      payloadHash: HASH_64,
      relativeCwd: 'apps/web',
      harness: 'claude-code',
    });
    expect(srv.host.isBusy(CONNECTOR_ID)).toBe(true);

    // Send progress including waiting_local_permission & resumed
    ws.send(
      JSON.stringify({
        type: 'task.progress',
        sessionId: 'lcode_session_1',
        kind: 'waiting_local_permission',
        toolCallId: 'acp_tc_1',
        title: 'Run pnpm test',
        toolKind: 'execute',
      }),
    );
    ws.send(
      JSON.stringify({
        type: 'task.progress',
        sessionId: 'lcode_session_1',
        kind: 'resumed',
        toolCallId: 'acp_tc_1',
        permissionOutcome: 'selected',
      }),
    );
    ws.send(
      JSON.stringify({
        type: 'task.result',
        sessionId: 'lcode_session_1',
        status: 'completed',
        acpSessionId: 'acp_sess_99',
        agentName: 'Claude Code',
        reportMode: 'summary',
        summary: 'Fixed the flaky test and ran pnpm test.',
        filesChanged: ['apps/web/auth.test.ts'],
        commandsRun: [{ command: 'pnpm test', status: 'completed' }],
        steps: 3,
        durationMs: 1200,
        gitBranch: 'feat/fix-flaky',
        headSha: 'abcdef1',
      }),
    );

    const result = await taskPromise;
    expect(result.status).toBe('completed');
    expect(result.acpSessionId).toBe('acp_sess_99');
    expect(result.gitBranch).toBe('feat/fix-flaky');
    expect(progressFrames).toHaveLength(2);
    expect(srv.host.isBusy(CONNECTOR_ID)).toBe(false);
    ws.close();
  });

  it('sends task.cancel on AbortSignal and settles cancelled', async () => {
    const srv = await startWsServer();
    closers.push(srv.close);

    const { ws } = await connectCli(srv.port);
    const controller = new AbortController();
    const dispatchP = nextFrame(ws);
    const taskP = srv.host.dispatchTask({
      connectorId: CONNECTOR_ID,
      sessionId: 'lcode_cancel_1',
      payloadHash: HASH_64,
      botId: BOT_ID,
      botName: 'Atlas',
      relativeCwd: '.',
      harness: 'codex',
      prompt: 'Refactor',
      maxDurationMs: 60_000,
      abortSignal: controller.signal,
    });
    await dispatchP;

    const cancelP = nextFrame(ws);
    controller.abort();
    const cancelFrame = await cancelP;
    expect(cancelFrame).toEqual({
      type: 'task.cancel',
      sessionId: 'lcode_cancel_1',
      reason: 'USER_CANCELLED',
    });

    const settled = await taskP;
    expect(settled.status).toBe('cancelled');
    ws.close();
  });

  it('resumes an active task when CLI reconnects within the disconnect grace window', async () => {
    const srv = await startWsServer({ disconnectGraceMs: 400 });
    closers.push(srv.close);

    const { ws: firstWs } = await connectCli(srv.port);
    const dispatchP = nextFrame(firstWs);
    const taskP = srv.host.dispatchTask({
      connectorId: CONNECTOR_ID,
      sessionId: 'lcode_resume_1',
      payloadHash: HASH_64,
      botId: BOT_ID,
      botName: 'Atlas',
      relativeCwd: '.',
      harness: 'claude-code',
      prompt: 'Continue across blip',
      maxDurationMs: 60_000,
    });
    await dispatchP;

    // Drop the socket mid-task
    firstWs.terminate();
    await new Promise((r) => setTimeout(r, 40));
    expect(srv.connectors.markOffline).toHaveBeenCalledWith(USER_ID, CONNECTOR_ID);

    // Reconnect within grace window with matching activeSessionId
    const { ws: secondWs, firstFrame } = await connectCli(srv.port, {
      activeSessionId: 'lcode_resume_1',
    });
    expect(firstFrame).toMatchObject({
      type: 'connector.welcome',
      resumeAccepted: true,
    });

    secondWs.send(
      JSON.stringify({
        type: 'task.result',
        sessionId: 'lcode_resume_1',
        status: 'completed',
        acpSessionId: 'acp_resumed',
        reportMode: 'summary',
        summary: 'Completed after reconnect.',
        filesChanged: ['src/app.ts'],
        commandsRun: [],
        steps: 2,
        durationMs: 500,
      }),
    );

    const result = await taskP;
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Completed after reconnect.');
    secondWs.close();
  });

  it('settles task as interrupted after grace expiry and sends task.cancel on stale reconnect', async () => {
    const srv = await startWsServer({ disconnectGraceMs: 80 });
    closers.push(srv.close);

    const { ws: firstWs } = await connectCli(srv.port);
    const dispatchP = nextFrame(firstWs);
    const taskP = srv.host.dispatchTask({
      connectorId: CONNECTOR_ID,
      sessionId: 'lcode_expire_1',
      payloadHash: HASH_64,
      botId: BOT_ID,
      botName: 'Atlas',
      relativeCwd: '.',
      harness: 'claude-code',
      prompt: 'Long task',
      maxDurationMs: 60_000,
    });
    await dispatchP;

    firstWs.terminate();
    const interrupted = await taskP;
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.error?.code).toBe('CONNECTOR_OFFLINE');

    // Late reconnect with expired activeSessionId receives resumeAccepted: false + task.cancel
    const lateWs = new WebSocket(`ws://127.0.0.1:${String(srv.port)}${CONNECTOR_WS_PATH}`, {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    await new Promise<void>((resolve, reject) => {
      lateWs.once('open', () => resolve());
      lateWs.once('error', reject);
    });
    const received: ConnectorServerFrame[] = [];
    const twoFrames = new Promise<void>((resolve) => {
      lateWs.on('message', (raw) => {
        received.push(JSON.parse(raw.toString()) as ConnectorServerFrame);
        if (received.length >= 2) resolve();
      });
    });
    lateWs.send(
      JSON.stringify({
        type: 'connector.hello',
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        cliVersion: '0.1.0',
        workspaceName: 'crewaid-public',
        hostName: 'dev-macbook',
        harnesses: ['claude-code'],
        defaultHarness: 'claude-code',
        reportMode: 'summary',
        activeSessionId: 'lcode_expire_1',
      }),
    );
    await twoFrames;
    expect(received[0]).toMatchObject({ type: 'connector.welcome', resumeAccepted: false });
    expect(received[1]).toEqual({
      type: 'task.cancel',
      sessionId: 'lcode_expire_1',
      reason: 'SESSION_EXPIRED',
    });
    lateWs.close();
  });

  it('supersedes an older socket with 4002 and kicks a live socket with 4001 on rotation/revocation', async () => {
    const srv = await startWsServer();
    closers.push(srv.close);

    const { ws: firstWs } = await connectCli(srv.port);
    const firstClosed = nextClose(firstWs);
    const { ws: secondWs } = await connectCli(srv.port);

    expect((await firstClosed).code).toBe(4002);
    expect(srv.connectors.markOffline).not.toHaveBeenCalled();

    const secondClosed = nextClose(secondWs);
    srv.host.kick(CONNECTOR_ID, 4001, 'Token rotated');
    expect((await secondClosed).code).toBe(4001);
  });
});
