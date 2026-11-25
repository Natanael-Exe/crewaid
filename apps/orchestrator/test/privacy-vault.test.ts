import { describe, expect, it, vi } from 'vitest';
import { EventType, type ModelMessage } from '@tanstack/ai';
import type { Json } from '@crewaid/shared';
import { z } from 'zod';
import { PrivacyVault } from '../src/agent/execution/privacy-vault.js';
import { executionSystemPrompts } from '../src/agent/execution/provider-context.js';
import {
  TanStackExecutionBackend,
  type TanStackExecutionPersistence,
} from '../src/agent/execution/tanstack-execution-backend.js';
import type {
  ExecutionPorts,
  ExecutionRequest,
} from '../src/agent/execution/execution-backend.port.js';
import { tool } from '../src/agent/tool-contract.js';
import { OBSERVING_BUILTIN, type RegisteredTool } from '../src/agent/tool-registry.js';
import { toolFixture, ToolScriptAdapter } from './mod-ai02-harness.js';

describe('PrivacyVault', () => {
  it('masks public consumer emails with a hint and keeps private/corporate domains opaque', () => {
    const vault = new PrivacyVault();
    const redacted = vault.redactText(
      'Personal: blackexe9@gmail.com, Work: alice.smith@acme-internal.io',
    );
    expect(redacted).toBe('Personal: [[EMAIL_1:b.....9@gmail.com]], Work: [[EMAIL_2]]');
    expect(redacted).not.toContain('blackexe9');
    expect(redacted).not.toContain('alice.smith');
    expect(redacted).not.toContain('acme-internal.io');

    // Case-insensitive reuse produces the exact same token.
    expect(vault.redactText('Reply to BLACKEXE9@GMAIL.COM')).toBe(
      'Reply to [[EMAIL_1:b.....9@gmail.com]]',
    );
    expect(vault.resolveText(redacted)).toBe(
      'Personal: blackexe9@gmail.com, Work: alice.smith@acme-internal.io',
    );
  });

  it('resolves bare consumer email hints and stripped bracket IDs when a model drops the suffix', () => {
    const vault = new PrivacyVault();
    vault.redactText('Reach me at blackexe9@gmail.com');
    expect(vault.resolveText('Sent to [[EMAIL_1]]')).toBe('Sent to blackexe9@gmail.com');
    expect(vault.resolveText('Your b.....9@gmail.com address will work.')).toBe(
      'Your blackexe9@gmail.com address will work.',
    );
    expect(vault.resolveText('Sent to b.....9@gmail.com.')).toBe('Sent to blackexe9@gmail.com.');
    expect(vault.redactText('Call +1 415-555-0192. Email blackexe9@gmail.com.')).toBe(
      'Call [[PHONE_1]]. Email [[EMAIL_1:b.....9@gmail.com]].',
    );
  });

  it('redacts phones, Luhn-valid cards, SSNs, contextual OTPs, and API secrets without false positives', () => {
    const vault = new PrivacyVault();
    const input = [
      'Phone: +1 (415) 555-0192 or 212-555-0148',
      'Card: 4532 0151 1283 0366',
      'Not a card (fails Luhn): 4532 0151 1283 0367',
      'SSN: 123-45-6789',
      'Your verification code is 482910',
      'Key: sk-proj-abcdefghijklmnopqrstuvwxyz1234',
      'Asset: hero@2x.png, Date: 2026-11-25, Path: /home/bot/agents/cmww0x3xr/patch.py',
    ].join('\n');

    const redacted = vault.redactText(input);
    expect(redacted).toContain('Phone: [[PHONE_1]] or [[PHONE_2]]');
    expect(redacted).toContain('Card: [[CARD_1]]');
    expect(redacted).toContain('Not a card (fails Luhn): 4532 0151 1283 0367');
    expect(redacted).toContain('SSN: [[SSN_1]]');
    expect(redacted).toContain('Your verification code is [[OTP_1]]');
    expect(redacted).toContain('Key: [[SECRET_1]]');
    expect(redacted).toContain('Asset: hero@2x.png');
    expect(redacted).toContain('Date: 2026-11-25');
    expect(redacted).toContain('Path: /home/bot/agents/cmww0x3xr/patch.py');

    // Idempotent when scanned a second time.
    expect(vault.redactText(redacted)).toBe(redacted);

    // Full resolution restores real values for tools and user display.
    expect(vault.resolveText(redacted)).toBe(input);

    // Masked display mode keeps secrets/OTPs/cards/SSNs hidden while restoring phones.
    const masked = vault.resolveText(redacted, { maskSecrets: true });
    expect(masked).toContain('Phone: +1 (415) 555-0192 or 212-555-0148');
    expect(masked).toContain('Card: •••• 0366');
    expect(masked).toContain('SSN: •••-••-6789');
    expect(masked).toContain('Your verification code is ••••••');
    expect(masked).toContain('Key: sk-p••••');
    expect(masked).not.toContain('482910');
    expect(masked).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('redacts provider message copies and resolves nested tool arguments without mutating canonical input', () => {
    const vault = new PrivacyVault();
    const canonical: ModelMessage[] = [
      { role: 'user', content: 'Email blackexe9@gmail.com about the invoice.' },
      {
        role: 'assistant',
        content: 'Drafting it now.',
        toolCalls: [
          {
            id: 'tc-1',
            type: 'function',
            function: {
              name: 'use_plugin_tool',
              arguments: JSON.stringify({
                tool: 'gmail__GMAIL_SEND_EMAIL',
                arguments: { recipient_email: 'blackexe9@gmail.com', subject: 'Invoice' },
              }),
            },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'tc-1',
        content: JSON.stringify({ to: 'blackexe9@gmail.com', status: 'sent' }),
      },
    ];

    const providerCopy = vault.redactMessages(canonical);
    // Original canonical messages are never mutated.
    expect(canonical[0]?.content).toContain('blackexe9@gmail.com');
    // Provider copy contains zero plaintext email.
    expect(JSON.stringify(providerCopy)).not.toContain('blackexe9@gmail.com');
    expect(providerCopy[0]?.content).toContain('[[EMAIL_1:b.....9@gmail.com]]');

    // Model calls tool using the vault token; resolver restores real email before dispatch.
    const resolvedArgs = vault.resolveValue({
      tool: 'gmail__GMAIL_SEND_EMAIL',
      arguments: {
        recipient_email: '[[EMAIL_1:b.....9@gmail.com]]',
        subject: 'Invoice',
      },
    });
    expect(resolvedArgs).toEqual({
      tool: 'gmail__GMAIL_SEND_EMAIL',
      arguments: {
        recipient_email: 'blackexe9@gmail.com',
        subject: 'Invoice',
      },
    });

    // Persisting assistant output resolves tokens back to canonical form.
    const persisted = vault.resolveMessages([
      {
        role: 'assistant',
        content: 'I sent the invoice to [[EMAIL_1:b.....9@gmail.com]].',
        toolCalls: [
          {
            id: 'tc-2',
            type: 'function',
            function: {
              name: 'gmail__GMAIL_SEND_EMAIL',
              arguments: JSON.stringify({ recipient_email: '[[EMAIL_1:b.....9@gmail.com]]' }),
            },
          },
        ],
      },
    ]);
    expect(persisted[0]?.content).toBe('I sent the invoice to blackexe9@gmail.com.');
    expect(persisted[0]?.toolCalls?.[0]?.function.arguments).toBe(
      JSON.stringify({ recipient_email: 'blackexe9@gmail.com' }),
    );
  });

  it('rehydrates streamed deltas cleanly across arbitrary chunk splits', () => {
    const vault = new PrivacyVault();
    vault.redactText('Email blackexe9@gmail.com and call +1 415-555-0192');

    const stream = vault.createStreamRehydrator();
    const raw = 'Sending to [[EMAIL_1:b.....9@gmail.com]] and calling [[PHONE_1]] now [done].';
    let out = '';
    for (let i = 0; i < raw.length; i += 3) {
      out += stream.push(raw.slice(i, i + 3));
    }
    out += stream.flush();
    expect(out).toBe('Sending to blackexe9@gmail.com and calling +1 415-555-0192 now [done].');
  });

  it('redacts PII in memory blocks sent via executionSystemPrompts', () => {
    const vault = new PrivacyVault();
    const prompts = executionSystemPrompts(
      {
        instructions: {
          botPrompt: 'You are Clara.',
          memory: '<memory>\n- User personal email is blackexe9@gmail.com\n</memory>',
        },
      } as ExecutionRequest,
      'anthropic',
      vault,
    );
    const serialized = JSON.stringify(prompts);
    expect(serialized).not.toContain('blackexe9@gmail.com');
    expect(serialized).toContain('[[EMAIL_1:b.....9@gmail.com]]');
  });

  it('end-to-end: hides PII from provider, restores real email for tool execution, and rehydrates streamed & persisted replies', async () => {
    const receivedToolArgs: unknown[] = [];
    const sendMail: RegisteredTool = {
      name: 'send_mail_fixture',
      behavior: OBSERVING_BUILTIN,
      build: () =>
        tool({
          inputSchema: z.object({ recipient: z.string().email() }),
          execute: (args) => {
            receivedToolArgs.push(args);
            return `sent to ${args.recipient}`;
          },
        }),
    };

    const calls = [
      {
        id: 'call-email-1',
        name: sendMail.name,
        args: { recipient: '[[EMAIL_1:b.....9@gmail.com]]' } as Json,
      },
    ];
    const f = toolFixture([sendMail], calls, { mode: 'FULL' });
    const adapter = new ToolScriptAdapter(calls, f.resolved.toolSet, false);
    const observedProviderMessages: unknown[] = [];
    adapter.chatStream = async function* (options) {
      observedProviderMessages.push(structuredClone(options.messages));
      const step = observedProviderMessages.length;
      const runId = options.runId ?? 'run-pv';
      const threadId = options.threadId ?? f.threadId;
      if (step === 1) {
        const messageId = 'asst-1';
        yield { type: EventType.RUN_STARTED, runId, threadId, timestamp: Date.now() };
        yield {
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: 'assistant',
          timestamp: Date.now(),
        };
        yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: Date.now() };
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId: 'call-email-1',
          toolCallName: sendMail.name,
          parentMessageId: messageId,
          index: 0,
          timestamp: Date.now(),
        };
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: 'call-email-1',
          delta: '{"recipient":"[[EMAIL_1:b.....9@gmail.com]]"}',
          timestamp: Date.now(),
        };
        yield {
          type: EventType.TOOL_CALL_END,
          toolCallId: 'call-email-1',
          toolCallName: sendMail.name,
          input: { recipient: '[[EMAIL_1:b.....9@gmail.com]]' },
          timestamp: Date.now(),
        };
        yield {
          type: EventType.RUN_FINISHED,
          runId,
          threadId,
          finishReason: 'tool_calls',
          timestamp: Date.now(),
        };
        return;
      }
      const messageId = 'asst-2';
      yield { type: EventType.RUN_STARTED, runId, threadId, timestamp: Date.now() };
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: 'assistant',
        timestamp: Date.now(),
      };
      // Split the vault token across multiple SSE chunks to verify streaming rehydration.
      for (const delta of ['Sent to [[EMA', 'IL_1:b.....9@gm', 'ail.com]]!']) {
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta, timestamp: Date.now() };
      }
      yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: Date.now() };
      yield {
        type: EventType.RUN_FINISHED,
        runId,
        threadId,
        finishReason: 'stop',
        timestamp: Date.now(),
      };
    };

    const events: Json[] = [];
    const ports: ExecutionPorts = {
      appendEvent: async (event) => {
        events.push(event);
      },
      checkpoint: async () => undefined,
      persistUsage: vi.fn(async () => undefined),
      status: vi.fn(),
      releaseForApproval: vi.fn(async () => undefined),
    };
    const backend = new TanStackExecutionBackend({
      resolveModel: vi.fn(async () => ({
        adapter,
        modelId: 'fixture-model',
        connectionId: 'connection',
        connectionName: 'Owned',
        kind: 'custom' as const,
        upstreamModelId: 'fixture',
        label: 'Fixture',
        contextWindow: 10000,
        capabilities: { tools: true, vision: false, reasoning: false },
      })),
      openPersistence: vi.fn(
        async (input: ExecutionRequest): Promise<TanStackExecutionPersistence> => {
          await f.persistence.stores.runs.createOrResume({
            runId: input.runId,
            threadId: input.threadId,
            startedAt: Date.now(),
          });
          return {
            persistence: f.persistence,
            reserve: vi.fn(async () => undefined),
            withdraw: vi.fn(async () => undefined),
            assertLive: vi.fn(async () => undefined),
            boundary: async (_next, op) => op(),
            progress: async () => undefined,
            authorizeResume: f.authorizeResume,
            budget: {
              steps: 0,
              workingMs: 0,
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                cacheCreationTokens: 0,
                reportedCalls: 0,
                unreportedCalls: 0,
              },
            },
          };
        },
      ),
      loadAttachments: vi.fn(async () => new Map()),
      logger: { warn: vi.fn() },
    });

    await f.persistence.stores.messages.saveThread(f.threadId, [
      { id: 'u1', role: 'user', content: 'Please email blackexe9@gmail.com.' },
    ]);

    const outcome = await backend.execute(
      {
        model: { userId: 'owner', modelRef: 'fixture-model' },
        botId: 'owned-bot',
        threadId: f.threadId,
        runId: 'run-pv',
        triggerMessageId: 'u1',
        tools: f.resolved.toolSet,
        policy: f.policy,
        instructions: { botPrompt: 'Be helpful.' },
      },
      ports,
    );

    expect(outcome.status).toBe('completed');
    // 1. Provider NEVER saw plaintext email across either step (including tool results!).
    expect(JSON.stringify(observedProviderMessages)).not.toContain('blackexe9@gmail.com');
    expect(JSON.stringify(observedProviderMessages)).toContain('[[EMAIL_1:b.....9@gmail.com]]');
    // 2. Tool validation (`z.string().email()`) & execution received the REAL email.
    expect(receivedToolArgs).toEqual([{ recipient: 'blackexe9@gmail.com' }]);
    // 3. Streamed AG-UI text events delivered the real email with no raw vault tokens.
    const streamedText = events
      .filter(
        (event): event is { type: string; delta: string } =>
          typeof event === 'object' &&
          event !== null &&
          (event as { type?: unknown }).type === EventType.TEXT_MESSAGE_CONTENT &&
          typeof (event as { delta?: unknown }).delta === 'string',
      )
      .map((event) => event.delta)
      .join('');
    expect(streamedText).toBe('Sent to blackexe9@gmail.com!');
    // 4. Persisted canonical thread holds the real email (never raw vault tokens).
    const saved = await f.persistence.stores.messages.loadThread(f.threadId);
    expect(JSON.stringify(saved)).not.toContain('[[EMAIL_1');
    expect(JSON.stringify(saved)).toContain('Sent to blackexe9@gmail.com!');
  });
});
