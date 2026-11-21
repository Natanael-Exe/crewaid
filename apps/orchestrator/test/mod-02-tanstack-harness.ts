/**
 * MOD-02 — a minimal Nest server over the TanStack AI stack D-159 chose, with
 * a scripted model in place of a provider.
 *
 * It is a compatibility probe, not the product's chat route: it exists to
 * prove that the pinned packages compose the way D-159's contracts assume —
 * the run is produced in the background into a delivery log and every HTTP
 * response is a JOIN of that log, so a client that disconnects ends its join,
 * never the run. That is the shape MOD-AI-05/07 will build for real.
 *
 * The scripted adapter yields the AG-UI events a provider adapter yields (one
 * RUN_STARTED … RUN_FINISHED sequence per model call), chosen by the newest
 * message, so a test can drive text, a server tool, a policy-gated tool and a
 * slow stream without a network or a key.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  EventType,
  RUN_CANCEL_REASON,
  chat,
  chatParamsFromRequestBody,
  defineInterrupt,
  memoryStream,
  resumeServerSentEventsResponse,
  toolDefinition,
  type ChatMiddleware,
  type ModelMessage,
  type StreamChunk,
  type TextOptions,
} from '@tanstack/ai';
import { BaseTextAdapter } from '@tanstack/ai/adapters';
import { memoryPersistence, reconstructChat, withPersistence } from '@tanstack/ai-persistence';

type Options = Record<string, never>;

/** What Nest's Express platform hands a route: Node's objects plus Express's additions. */
type ExpressRequest = IncomingMessage & { body: unknown; originalUrl: string };
type ExpressResponse = ServerResponse & {
  status(code: number): ExpressResponse;
  json(body: unknown): void;
};

/** A message store may answer with a page; the memory store never does. */
function threadOf(stored: ModelMessage[] | { messages: ModelMessage[] }): ModelMessage[] {
  return Array.isArray(stored) ? stored : stored.messages;
}

/** What the scripted model saw on each call, for assertions about its input. */
export type ModelCall = { readonly runId: string | undefined; readonly messages: ModelMessage[] };

function textOf(message: ModelMessage | undefined): string {
  if (message === undefined) return '';
  if (typeof message.content === 'string') return message.content;
  if (message.content === null) return '';
  return message.content
    .map((part) => ('content' in part && typeof part.content === 'string' ? part.content : ''))
    .join('');
}

/** A text adapter that answers from a script instead of a provider. */
export class ScriptedAdapter extends BaseTextAdapter<
  'scripted',
  Options,
  readonly ['text'],
  never
> {
  readonly name = 'scripted';
  readonly calls: ModelCall[] = [];
  /** Milliseconds between streamed words; raised by tests that need a run to still be going. */
  wordDelayMs = 2;

  constructor() {
    super({}, 'scripted');
  }

  async *chatStream(options: TextOptions<Options>): AsyncIterable<StreamChunk> {
    this.calls.push({ runId: options.runId, messages: [...options.messages] });
    const runId = options.runId ?? randomUUID();
    const threadId = options.threadId ?? randomUUID();
    const signal = options.abortController?.signal;
    const last = options.messages[options.messages.length - 1];
    const said = textOf(last);
    const messageId = `asst-${randomUUID()}`;
    const now = (): number => Date.now();

    yield { type: EventType.RUN_STARTED, runId, threadId, timestamp: now() } as StreamChunk;
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: 'assistant',
      timestamp: now(),
    } as StreamChunk;

    const toolName =
      last?.role !== 'user'
        ? null
        : said.includes('gated')
          ? 'send_email'
          : said.includes('tool')
            ? 'get_time'
            : null;
    if (toolName !== null) {
      const toolCallId = `call-${randomUUID()}`;
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: 'checking',
        timestamp: now(),
      } as StreamChunk;
      yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: now() } as StreamChunk;
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: toolName,
        parentMessageId: messageId,
        index: 0,
        timestamp: now(),
      } as StreamChunk;
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: JSON.stringify({ to: 'ops@example.test' }),
        timestamp: now(),
      } as StreamChunk;
      yield { type: EventType.TOOL_CALL_END, toolCallId, timestamp: now() } as StreamChunk;
      yield {
        type: EventType.RUN_FINISHED,
        runId,
        threadId,
        finishReason: 'tool_calls',
        usage: { promptTokens: 11, completionTokens: 4, totalTokens: 15 },
        timestamp: now(),
      } as StreamChunk;
      return;
    }

    const words =
      last?.role === 'tool'
        ? ['done']
        : said.includes('slow')
          ? Array.from({ length: 30 }, (_, i) => `w${i} `)
          : said.includes('markup')
            ? // D-198: a call written as text, the way MOD-AI-13's real model did.
              ['<tool_call>', 'capture_screen({})']
            : ['hello ', 'from ', 'the ', 'script'];
    for (const word of words) {
      await new Promise((resolve) => setTimeout(resolve, this.wordDelayMs));
      if (signal?.aborted === true) return;
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: word,
        timestamp: now(),
      } as StreamChunk;
    }
    yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: now() } as StreamChunk;
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      finishReason: 'stop',
      usage: { promptTokens: 7, completionTokens: words.length, totalTokens: 7 + words.length },
      timestamp: now(),
    } as StreamChunk;
  }

  structuredOutput(): Promise<never> {
    return Promise.reject(new Error('the scripted adapter has no structured output'));
  }
}

/**
 * D-159's one generic approval interrupt. Its payload and response are plain
 * Zod, which is what lets the renderer register the same definition without a
 * server dependency.
 */
export const toolApproval = defineInterrupt({
  id: 'crewaid.tool-approval',
  payloadSchema: z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  responseSchema: z.object({
    approved: z.boolean(),
    editedArgs: z.record(z.string(), z.unknown()).optional(),
  }),
});

const getTime = toolDefinition({
  name: 'get_time',
  description: 'Read the time.',
  inputSchema: z.object({ to: z.string() }),
  outputSchema: z.object({ now: z.string() }),
}).server(() => Promise.resolve({ now: '2026-10-03T00:00:00.000Z' }));

/** A tool with an external effect; whether it runs is the policy's call, per call. */
const sendEmail = toolDefinition({
  name: 'send_email',
  description: 'Send an email.',
  inputSchema: z.object({ to: z.string() }),
  outputSchema: z.object({ sent: z.boolean(), to: z.string() }),
}).server(({ to }) => Promise.resolve({ sent: true, to }));

type Decision = { approved: boolean; editedArgs?: Record<string, unknown> | undefined };

/**
 * The per-call policy shape D-159 §3.6 chose: ask at the `beforeTools`
 * boundary, re-check at dispatch. Decisions are held in a map here; the product
 * keeps them in `RunInterrupt` rows.
 */
function approvalPolicy(
  decisions: Map<string, Decision>,
  asked: string[],
): ChatMiddleware<unknown, typeof toolApproval> {
  return {
    name: 'mod-02-approval-policy',
    onInterruptBoundary(ctx) {
      if (ctx.phase !== 'beforeTools') return undefined;
      const assistant = [...ctx.messages].reverse().find((message) => message.role === 'assistant');
      const pending = (assistant?.toolCalls ?? []).filter(
        (call) => call.function.name === 'send_email' && !decisions.has(call.id),
      );
      if (pending.length === 0) return undefined;
      asked.push(...pending.map((call) => call.id));
      return {
        interrupts: pending.map((call) =>
          toolApproval.interrupt({
            key: call.id,
            reason: 'policy',
            message: `Allow ${call.function.name}?`,
            payload: {
              toolCallId: call.id,
              toolName: call.function.name,
              args: z
                .record(z.string(), z.unknown())
                .parse(JSON.parse(call.function.arguments || '{}')),
            },
          }),
        ),
      };
    },
    onInterruptResolution(_ctx, resolutions) {
      for (const resolution of resolutions.for(toolApproval)) {
        const payload = resolution.request.payload;
        if (payload === undefined) continue;
        decisions.set(
          payload.toolCallId,
          resolution.status === 'resolved' ? resolution.response : { approved: false },
        );
      }
      return { toolResume: 'continue' };
    },
    onBeforeToolCall(_ctx, hook) {
      if (hook.toolName !== 'send_email') return undefined;
      const decision = decisions.get(hook.toolCallId);
      if (decision?.approved !== true) return { type: 'skip', result: { sent: false, to: '' } };
      if (decision.editedArgs !== undefined)
        return { type: 'transformArgs', args: decision.editedArgs };
      return undefined;
    },
  };
}

type RunHandle = { readonly abort: AbortController; readonly done: Promise<void> };

export type ProbeHarness = {
  readonly adapter: ScriptedAdapter;
  readonly persistence: ReturnType<typeof memoryPersistence>;
  readonly runs: Map<string, RunHandle>;
  /** The client's proposed run id, kept as the idempotency key (D-159 §3.1). */
  readonly proposedRunIds: Map<string, string>;
  readonly asked: string[];
  /** Raw POST bodies, in arrival order. */
  readonly posts: unknown[];
  /** Mint run ids server-side instead of taking the client's; see the run handler. */
  mintRunIds: boolean;
  /** Every RUN_ERROR a run emitted or exception it threw; empty in a healthy suite. */
  readonly runErrors: Array<{ runId: string; chunk?: unknown; error?: unknown }>;
  /** Admit a user message server-side and produce a run nobody requested (a routine, a chain). */
  startBackgroundRun(threadId: string, text: string): Promise<string>;
  /** `bot.cancel`: durable intent plus an in-process abort (D-159 §3.9). */
  cancel(runId: string): Promise<void>;
};

type InternalHarness = ProbeHarness & {
  produce(input: {
    threadId: string;
    runId: string;
    resume?: Parameters<typeof chat>[0]['resume'];
  }): void;
  admitUserMessage(threadId: string, message: ModelMessage): Promise<void>;
};

export function createProbeHarness(): ProbeHarness {
  const adapter = new ScriptedAdapter();
  const persistence = memoryPersistence();
  const decisions = new Map<string, Decision>();
  const asked: string[] = [];
  const runs = new Map<string, RunHandle>();
  const proposedRunIds = new Map<string, string>();
  const runErrors: Array<{ runId: string; chunk?: unknown; error?: unknown }> = [];
  const posts: unknown[] = [];

  /** Produce one run into its delivery log. The log, not the request, carries the events. */
  function produce(input: {
    threadId: string;
    runId: string;
    resume?: Parameters<typeof chat>[0]['resume'];
  }): void {
    const abort = new AbortController();
    const stream = chat({
      adapter,
      messages: [],
      threadId: input.threadId,
      runId: input.runId,
      ...(input.resume !== undefined && { resume: input.resume }),
      tools: [getTime, sendEmail],
      interrupts: [toolApproval],
      middleware: [withPersistence(persistence), approvalPolicy(decisions, asked)],
      abortController: abort,
    });
    const log = memoryStream({ runId: input.runId });
    const done = (async (): Promise<void> => {
      try {
        for await (const chunk of stream) {
          if (chunk.type === 'RUN_ERROR') runErrors.push({ runId: input.runId, chunk });
          await log.append([chunk]);
        }
      } catch (error) {
        runErrors.push({ runId: input.runId, error });
        throw error;
      } finally {
        await log.close();
      }
    })();
    runs.set(input.runId, { abort, done });
  }

  async function admitUserMessage(threadId: string, message: ModelMessage): Promise<void> {
    const list = threadOf(await persistence.stores.messages.loadThread(threadId));
    if (message.id !== undefined && list.some((existing) => existing.id === message.id)) return;
    await persistence.stores.messages.saveThread(threadId, [...list, message]);
  }

  const harness: InternalHarness = {
    adapter,
    persistence,
    runs,
    proposedRunIds,
    asked,
    runErrors,
    posts,
    mintRunIds: false,
    produce,
    admitUserMessage,
    async startBackgroundRun(threadId, text) {
      await admitUserMessage(threadId, { id: `user-${randomUUID()}`, role: 'user', content: text });
      const runId = `srv-${randomUUID()}`;
      produce({ threadId, runId });
      return runId;
    },
    async cancel(runId) {
      await persistence.stores.runs.update(runId, { cancelRequested: true });
      runs.get(runId)?.abort.abort(RUN_CANCEL_REASON);
      await runs.get(runId)?.done.catch(() => undefined);
    },
  };
  return harness;
}

function toWebRequest(req: ExpressRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  return new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.originalUrl}`, { headers });
}

async function send(res: ExpressResponse, response: Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (response.body === null) {
    res.end();
    return;
  }
  // `pipeline` destroys the web stream when the client goes away, which is
  // what ends a JOIN — and only the join: the producer is not attached to it.
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    res,
  ).catch(() => undefined);
}

/**
 * The two handlers, mounted on the Nest application's own HTTP adapter.
 *
 * Not a `@Controller`: parameter decorators only compile under `src/`'s
 * tsconfig, and the probe has to live beside the tests. Mounting on the
 * adapter still runs Nest's Express platform and its JSON body parser, which
 * is the integration being proved.
 */
function chatHandlers(harness: InternalHarness): {
  run: (req: ExpressRequest, res: ExpressResponse) => Promise<void>;
  read: (req: ExpressRequest, res: ExpressResponse) => Promise<void>;
} {
  return {
    async run(req, res) {
      harness.posts.push(req.body);
      const params = await chatParamsFromRequestBody(req.body);
      const stored = threadOf(
        await harness.persistence.stores.messages.loadThread(params.threadId),
      );
      const known = new Set(stored.map((message) => message.id));
      // D-159 §3.3: stored ids are ignored, and new messages must be the user's.
      const fresh = params.messages.filter((m) => m.id === undefined || !known.has(m.id));
      if (fresh.some((m) => m.role !== 'user')) {
        res.status(400).json({ error: 'only new user messages are admitted' });
        return;
      }
      const resume = params.resume;
      if (fresh.length === 0 && resume === undefined) {
        res.status(400).json({ error: 'nothing to run' });
        return;
      }
      for (const message of fresh) {
        const content =
          'parts' in message
            ? (message.parts.find((part) => part.type === 'text')?.content ?? '')
            : message.content;
        await harness.admitUserMessage(params.threadId, {
          role: 'user',
          content: typeof content === 'string' ? content : '',
          ...(message.id !== undefined && { id: message.id }),
        });
      }
      // MOD-02 finding: the client keeps its own run id for interrupt resume,
      // so the server takes the proposed id, insert-if-absent, and refuses one
      // that already names a run on another thread. `mintRunIds` exists only to
      // demonstrate why the server-minted alternative breaks.
      const runId = harness.mintRunIds ? `srv-${randomUUID()}` : params.runId;
      const existing = await harness.persistence.stores.runs.get(runId);
      if (existing !== null && existing.threadId !== params.threadId) {
        res.status(409).json({ error: 'run id unavailable' });
        return;
      }
      harness.proposedRunIds.set(runId, params.runId);
      harness.produce({
        threadId: params.threadId,
        runId,
        ...(resume !== undefined && { resume }),
      });
      await send(
        res,
        resumeServerSentEventsResponse({
          adapter: memoryStream({ runId, offset: '-1' }),
          headers: { 'X-Accel-Buffering': 'no' },
        }),
      );
    },
    async read(req, res) {
      const request = toWebRequest(req);
      const url = new URL(request.url);
      if (url.searchParams.has('runId')) {
        await send(res, resumeServerSentEventsResponse({ adapter: memoryStream(request) }));
        return;
      }
      await send(
        res,
        await reconstructChat(harness.persistence, request, {
          authorize: () => Promise.resolve(true),
        }),
      );
    },
  };
}

export async function startProbeServer(
  harness: ProbeHarness,
): Promise<{ app: INestApplication; base: string }> {
  const moduleRef = await Test.createTestingModule({}).compile();
  // Nest's own parser, registered explicitly so it sits ahead of these routes:
  // the default one is added during `init`, after anything mounted here, and
  // `init` also appends the catch-all 404 that would shadow a later route.
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  app.useBodyParser('json');
  const handlers = chatHandlers(harness as InternalHarness);
  const adapter = app.getHttpAdapter();
  const fail = (res: ExpressResponse, error: unknown): void => {
    if (!res.headersSent) res.status(500).json({ error: String(error) });
  };
  adapter.post('/chat', (req: ExpressRequest, res: ExpressResponse) => {
    handlers.run(req, res).catch((error: unknown) => fail(res, error));
  });
  adapter.get('/chat', (req: ExpressRequest, res: ExpressResponse) => {
    handlers.read(req, res).catch((error: unknown) => fail(res, error));
  });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return { app, base: `http://127.0.0.1:${address.port}/chat` };
}
