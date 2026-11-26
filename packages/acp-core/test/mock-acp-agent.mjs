#!/usr/bin/env node
/**
 * Minimal real ACP v1 agent over stdio NDJSON for `@crewaid/acp-core` tests.
 *
 * Uses the real `@agentclientprotocol/sdk` v1 `agent()` + `ndJsonStream()` so
 * tests exercise true process stdio framing, `initialize`, `session/new`,
 * `session/prompt`, `session/update`, `session/request_permission`, and
 * `session/cancel`.
 */
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const scenario = process.env['MOCK_ACP_SCENARIO'] ?? 'happy';
let sessionCwd = process.cwd();
let cancelResolver = null;

const app = agent({ name: 'mock-acp-agent' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: 'mock-acp-agent', version: '1.0.0' },
  }))
  .onRequest(methods.agent.session.new, ({ params }) => {
    sessionCwd = params.cwd;
    return { sessionId: 'sess_mock_01' };
  })
  .onNotification(methods.agent.session.cancel, () => {
    if (scenario === 'cancel' && cancelResolver !== null) {
      cancelResolver();
      cancelResolver = null;
    }
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const { sessionId } = params;

    if (scenario === 'crash') {
      process.exit(1);
    }

    if (scenario === 'cancel' || scenario === 'hang-on-cancel') {
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc_long',
          title: 'Running long test suite',
          kind: 'execute',
          status: 'in_progress',
        },
      });
      await new Promise((resolve) => {
        cancelResolver = resolve;
      });
      return { stopReason: 'cancelled' };
    }

    if (scenario === 'permission') {
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc_perm',
          title: 'Run pnpm test',
          kind: 'execute',
          status: 'pending',
          locations: [{ path: path.join(sessionCwd, 'package.json') }],
        },
      });

      const decision = await client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: {
          toolCallId: 'tc_perm',
          title: 'Run pnpm test',
          kind: 'execute',
          locations: [{ path: path.join(sessionCwd, 'package.json') }],
        },
        options: [
          { optionId: 'allow_1', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_1', name: 'Reject', kind: 'reject_once' },
        ],
      });

      const granted =
        decision.outcome.outcome === 'selected' && decision.outcome.optionId === 'allow_1';
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc_perm',
          status: granted ? 'completed' : 'failed',
        },
      });
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg_final',
          content: {
            type: 'text',
            text: granted ? 'Permission approved; tests passed.' : 'Permission denied by operator.',
          },
        },
      });
      return { stopReason: 'end_turn' };
    }

    if (scenario === 'code-in-summary') {
      // A final message that pastes the changed code, split across two chunks
      // in the middle of the fence, the way agents usually report their work.
      for (const text of [
        'Rotated the key.\n```ts\nconst KEY = "SUMMARY_CODE_SECRET',
        '_9F2";\n```\nAll tests pass.',
      ]) {
        await client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg_final',
            content: { type: 'text', text },
          },
        });
      }
      return { stopReason: 'end_turn' };
    }

    // Default `happy` scenario: read with raw secret output, edit with raw diff,
    // execute test command, and send two assistant messages (the last is the summary).
    await client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg_1',
        content: { type: 'text', text: 'Inspecting files first...' },
      },
    });
    await client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_read',
        title: 'Read src/app.ts',
        kind: 'read',
        status: 'completed',
        locations: [{ path: path.join(sessionCwd, 'src', 'app.ts') }],
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'RAW_FILE_BODY_SECRET_TOKEN_XYZ' },
          },
        ],
      },
    });
    await client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_edit',
        title: 'Edit src/app.ts',
        kind: 'edit',
        status: 'completed',
        locations: [{ path: path.join(sessionCwd, 'src', 'app.ts') }],
        content: [
          {
            type: 'diff',
            path: path.join(sessionCwd, 'src', 'app.ts'),
            oldText: 'const oldSecret = "RAW_OLD_DIFF_CODE";',
            newText: 'const updated = "RAW_NEW_DIFF_CODE";',
          },
        ],
      },
    });
    await client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_exec',
        title: 'pnpm test',
        kind: 'execute',
        status: 'in_progress',
      },
    });
    await client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc_exec',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'RAW_COMMAND_STDOUT_DETAIL' },
          },
        ],
      },
    });
    await client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg_2',
        content: { type: 'text', text: 'Updated src/app.ts and verified tests pass.' },
      },
    });
    return { stopReason: 'end_turn' };
  });

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = app.connect(stream);
await connection.closed;
