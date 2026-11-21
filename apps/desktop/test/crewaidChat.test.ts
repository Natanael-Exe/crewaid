import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  crewaidChat,
  createRunAnnouncements,
  type CrewaidChat,
} from '../src/renderer/chat/crewaidChat';
import type { Message } from '@ag-ui/core';
import { toTranscriptMessage } from '../src/renderer/chat/uiMessage';
const clients: CrewaidChat[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});
const endpoint = {
  url: 'https://fixture.test/api/v1/bots/b/chat',
  headers: { Authorization: 'Bearer fixture', 'x-crewaid-wire-version': '2' },
};
const hydrate = (messages: Message[] = [], extra = {}) =>
  Response.json({
    messages,
    activeRun: null,
    interrupts: null,
    page: { truncated: false },
    ...extra,
  });
const events = (runId: string, text = 'Reply') => [
  { type: 'RUN_STARTED', runId, threadId: 'thread' },
  { type: 'TEXT_MESSAGE_START', messageId: 'reply', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: text },
  { type: 'TEXT_MESSAGE_END', messageId: 'reply' },
  { type: 'RUN_FINISHED', runId, threadId: 'thread', outcome: { type: 'success' } },
];
const encode = (rows: unknown[], start = 1) =>
  rows.map((row, i) => `id: ${start + i}\ndata: ${JSON.stringify(row)}\n\n`).join('');
const sse = (rows: unknown[]) =>
  new Response(encode(rows), { headers: { 'content-type': 'text/event-stream' } });
async function until(check: () => boolean) {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 3000, interval: 10 });
}
async function client(fetchFn: typeof fetch) {
  const runs = createRunAnnouncements();
  let ready = false;
  const chat = crewaidChat({
    endpoint,
    threadId: 'thread',
    runs,
    fetchFn,
    onHydrated: () => {
      ready = true;
    },
  });
  clients.push(chat);
  chat.start();
  await until(() => ready);
  return { chat, runs };
}
describe('standalone AG-UI chat admission and one-reader delivery', () => {
  it.each([400, 401, 403, 409, 500])(
    'rejects HTTP %s and removes the optimistic turn',
    async (status) => {
      const { chat } = await client(
        vi.fn(async (_url, init) =>
          init?.method === 'POST' ? new Response('', { status }) : hydrate(),
        ),
      );
      await expect(
        chat.sendMessage('Keep my draft', { body: { attachmentIds: ['upload'] } }),
      ).rejects.toThrow();
      expect(chat.getSnapshot().messages).toEqual([]);
      expect(chat.getSnapshot().error).toBeDefined();
    },
  );
  it('does not report acceptance until the POST answers, and does not wait for generation', async () => {
    let accept: ((response: Response) => void) | undefined;
    const stream = new ReadableStream<Uint8Array>();
    const { chat } = await client(
      vi.fn(async (_url, init) =>
        init?.method === 'POST'
          ? new Promise<Response>((resolve) => {
              accept = resolve;
            })
          : hydrate(),
      ),
    );
    let sent = false;
    const sending = chat.sendMessage('hello').then(() => {
      sent = true;
    });
    await Promise.resolve();
    expect(sent).toBe(false);
    accept?.(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    await sending;
    expect(sent).toBe(true);
    expect(chat.getSnapshot().sessionGenerating).toBe(true);
  });
  it('accepts deferred 202 and reads the later announced run once', async () => {
    const calls: string[] = [];
    const { chat, runs } = await client(
      vi.fn(async (input, init) => {
        const url = new URL(String(input));
        calls.push(init?.method ?? url.searchParams.get('runId') ?? 'hydrate');
        return init?.method === 'POST'
          ? new Response(null, { status: 202 })
          : url.searchParams.has('runId')
            ? sse(events('background'))
            : hydrate();
      }),
    );
    await chat.sendMessage('queued');
    expect(chat.getSnapshot().sessionGenerating).toBe(false);
    runs.announce('background');
    runs.announce('background');
    await until(() => chat.getSnapshot().messages.some((message) => message.content === 'Reply'));
    expect(calls).toEqual(['hydrate', 'POST', 'background']);
  });
  it('sends only the current user message, the owned ids and attachment claims', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchFn = vi.fn(async (_input, init) => {
      if (init?.method !== 'POST')
        return hydrate([{ id: 'old', role: 'assistant', content: 'History' }]);
      body = JSON.parse(String(init.body));
      expect(init.headers).toMatchObject(endpoint.headers);
      return sse(events(String(body?.runId)));
    });
    const { chat, runs } = await client(fetchFn);
    const id = await chat.sendMessage('hello', { body: { attachmentIds: ['upload'] } });
    // D-227: the id the server stores it under, which `run.settled` names.
    expect((body?.messages as Message[] | undefined)?.[0]?.id).toBe(id);
    runs.announce(String(body?.runId));
    await until(() => !chat.getSnapshot().sessionGenerating);
    expect(body).toMatchObject({
      threadId: 'thread',
      forwardedProps: { attachmentIds: ['upload'] },
      tools: [],
      state: {},
      context: [],
    });
    expect(body?.messages).toHaveLength(1);
    expect(chat.getSnapshot().messages.map((message) => message.content)).toEqual([
      'History',
      'hello',
      'Reply',
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it('keeps a newly sent voice note in the local row while sending only text and attachment ids to the server', async () => {
    let outgoing: { messages: Message[]; forwardedProps: unknown } | undefined;
    const fetchFn = vi.fn(async (_input, init) => {
      if (init?.method !== 'POST') return hydrate();
      outgoing = JSON.parse(String(init.body));
      return new Response(null, { status: 202 });
    });
    const { chat } = await client(fetchFn);
    const attachment = {
      id: 'voice-upload',
      filename: 'voice.webm',
      mimeType: 'audio/webm',
      sizeBytes: 2000,
      kind: 'VOICE_NOTE' as const,
      durationMs: 1000,
    };
    await chat.sendMessage('Hello by voice', {
      body: { attachmentIds: [attachment.id] },
      attachments: [attachment],
    });
    const displayed = chat.getSnapshot().messages[0];
    if (displayed === undefined) throw new Error('Missing sent voice note');
    expect(toTranscriptMessage(displayed, 'bot').attachments).toEqual([attachment]);
    expect(outgoing?.messages[0]?.metadata).toBeUndefined();
    expect(outgoing?.forwardedProps).toEqual({ attachmentIds: [attachment.id] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('replays an active run without duplicating its hydrated partial text', async () => {
    const { chat } = await client(
      vi.fn(async (input) =>
        new URL(String(input)).searchParams.has('runId')
          ? sse(events('active', 'Complete'))
          : hydrate(
              [
                {
                  id: 'reply',
                  role: 'assistant',
                  content: 'Partial',
                  metadata: { tanstack: { run: { id: 'active' } } },
                },
              ],
              { activeRun: { runId: 'active' } },
            ),
      ),
    );
    await until(() => !chat.getSnapshot().sessionGenerating);
    expect(chat.getSnapshot().messages).toMatchObject([{ id: 'reply', content: 'Complete' }]);
  });
  it('keeps the admitted start time across remounts and later recovery openers', async () => {
    const startedAt = Date.now() - 600_000;
    const fetchFn = vi.fn(async (input) => {
      if (!new URL(String(input)).searchParams.has('runId'))
        return hydrate([], { activeRun: { runId: 'active', startedAt } });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                encode([
                  {
                    type: 'RUN_STARTED',
                    runId: 'active',
                    threadId: 'thread',
                    timestamp: Date.now(),
                  },
                  { type: 'TEXT_MESSAGE_START', messageId: 'waiting', role: 'assistant' },
                  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'waiting', delta: 'Still working' },
                ]),
              ),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const first = await client(fetchFn);
    await until(() =>
      first.chat.getSnapshot().messages.some((message) => message.content === 'Still working'),
    );
    expect(first.chat.getSnapshot().startedAt).toBe(startedAt);
    first.chat.dispose();
    const second = await client(fetchFn);
    await until(() =>
      second.chat.getSnapshot().messages.some((message) => message.content === 'Still working'),
    );
    expect(second.chat.getSnapshot().startedAt).toBe(startedAt);
  });
  it('loads older native messages, keeps cursor order and deduplicates overlapping ids', async () => {
    const { chat } = await client(
      vi.fn(async (input) =>
        new URL(String(input)).searchParams.has('before')
          ? hydrate([
              { id: 'old', role: 'user', content: 'older' },
              { id: 'new', role: 'assistant', content: 'overlap' },
            ])
          : hydrate([{ id: 'new', role: 'assistant', content: 'latest' }], {
              page: { truncated: true, cursor: 'new' },
            }),
      ),
    );
    expect(chat.getSnapshot().hasOlderMessages).toBe(true);
    await chat.loadOlderMessages();
    expect(chat.getSnapshot().messages.map((message) => message.content)).toEqual([
      'older',
      'latest',
    ]);
    expect(chat.getSnapshot().hasOlderMessages).toBe(false);
  });
  it('follows an admitted continuation while its parent interrupt is still being consumed', async () => {
    const { chat } = await client(
      vi.fn(async (input) =>
        new URL(String(input)).searchParams.has('runId')
          ? sse(events('continuation', 'Approved elsewhere'))
          : hydrate([], {
              activeRun: { runId: 'continuation' },
              interrupts: {
                runId: 'parent',
                pending: [{ id: 'old-question', reason: 'approval' }],
              },
            }),
      ),
    );
    await until(() => !chat.getSnapshot().sessionGenerating);
    expect(chat.getSnapshot().interrupts).toEqual([]);
    expect(chat.getSnapshot().messages).toMatchObject([{ content: 'Approved elsewhere' }]);
    expect(chat.getSnapshot().error).toBeUndefined();
  });
  it('reads an existing interrupted run without submitting an answer or starting work', async () => {
    const interrupt = { id: 'question', reason: 'approval' };
    const fetchFn = vi.fn(async (input, init?: RequestInit) => {
      expect(init?.method).not.toBe('POST');
      return new URL(String(input)).searchParams.has('runId')
        ? sse([
            events('paused')[0],
            {
              type: 'RUN_FINISHED',
              runId: 'paused',
              threadId: 'thread',
              outcome: { type: 'interrupt', interrupts: [interrupt] },
            },
          ])
        : hydrate([], { interrupts: { runId: 'paused', pending: [interrupt] } });
    });
    const { chat, runs } = await client(fetchFn);
    runs.announce('paused');
    await until(() => !chat.getSnapshot().sessionGenerating);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(chat.agent.pendingInterrupts).toEqual([interrupt]);
    expect(chat.getSnapshot().error).toBeUndefined();
  });
  it('preserves interrupt binding and edited args on resume, and permits retry after refusal', async () => {
    const interrupt = {
      id: 'approval',
      reason: 'approval',
      metadata: {
        'tanstack:interruptBinding': {
          definitionId: 'crewaid.tool-approval',
          interruptedRunId: 'paused',
          generation: 0,
        },
        'tanstack:interruptPayload': { toolCallId: 'call', toolName: 'run_command' },
      },
    };
    const posts: unknown[] = [];
    const { chat } = await client(
      vi.fn(async (_input, init) => {
        if (init?.method !== 'POST')
          return hydrate([], {
            activeRun: { runId: 'paused' },
            interrupts: { runId: 'paused', pending: [interrupt] },
          });
        const body = JSON.parse(String(init.body));
        posts.push(body);
        return posts.length === 1 ? new Response('', { status: 409 }) : sse(events(body.runId));
      }),
    );
    expect(chat.getSnapshot().sessionGenerating).toBe(false);
    chat
      .getSnapshot()
      .interrupts[0]?.resolveInterrupt({ approved: true, editedArgs: { cmd: 'pwd' } });
    await until(() => chat.getSnapshot().interrupts[0]?.status === 'error');
    chat
      .getSnapshot()
      .interrupts[0]?.resolveInterrupt({ approved: true, editedArgs: { cmd: 'ls' } });
    await until(
      () =>
        posts.length === 2 &&
        !chat.getSnapshot().isLoading &&
        !chat.getSnapshot().resuming &&
        !chat.getSnapshot().sessionGenerating,
    );
    expect(posts[1]).toMatchObject({
      messages: [],
      parentRunId: 'paused',
      resume: [
        {
          interruptId: 'approval',
          status: 'resolved',
          payload: { approved: true, editedArgs: { cmd: 'ls' } },
          metadata: interrupt.metadata,
        },
      ],
    });
    expect(chat.getSnapshot().interrupts).toEqual([]);
  });
  it('reconnects from the last delivered SSE id without replaying text twice', async () => {
    let joins = 0;
    const { chat, runs } = await client(
      vi.fn(async (input) => {
        const url = new URL(String(input));
        if (!url.searchParams.has('runId')) return hydrate();
        joins++;
        if (joins === 1)
          return new Response(encode(events('reconnect').slice(0, 3)), {
            headers: { 'content-type': 'text/event-stream' },
          });
        expect(url.searchParams.get('offset')).toBe('3');
        return new Response(encode(events('reconnect').slice(3), 4), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }),
    );
    runs.announce('reconnect');
    await until(() => joins === 2 && !chat.getSnapshot().sessionGenerating);
    expect(chat.getSnapshot().messages).toMatchObject([{ content: 'Reply' }]);
  });
  it('disposes the subscription and HTTP reader without posting a cancellation', async () => {
    let signal: AbortSignal | null | undefined;
    const fetchFn = vi.fn(async (_url, init) => {
      signal = init?.signal;
      return hydrate();
    });
    const { chat, runs } = await client(fetchFn);
    chat.dispose();
    runs.announce('late');
    expect(signal?.aborted).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('adds a stored row it did not send once, and never a second copy of its own', async () => {
    const { chat } = await client(
      vi.fn(async (_input, init) =>
        init?.method === 'POST' ? new Response(null, { status: 202 }) : hydrate(),
      ),
    );
    const sent = await chat.sendMessage('typed here');
    chat.appendStored({ id: sent, role: 'user', content: 'typed here' });
    chat.appendStored({ id: 'from-phone', role: 'user', content: 'sent from Telegram' });
    chat.appendStored({ id: 'from-phone', role: 'user', content: 'sent from Telegram' });
    expect(chat.getSnapshot().messages.map((row) => row.content)).toEqual([
      'typed here',
      'sent from Telegram',
    ]);
  });
  it('holds a row announced while a run is read, and adds it when the read ends', async () => {
    let finish = () => {};
    const fetchFn = vi.fn(async (input) => {
      if (!new URL(String(input)).searchParams.has('runId')) return hydrate();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const rows = events('live', 'Partial');
            controller.enqueue(new TextEncoder().encode(encode(rows.slice(0, 3))));
            finish = () => {
              const more = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: ' and more' };
              controller.enqueue(new TextEncoder().encode(encode([more, ...rows.slice(3)], 4)));
              controller.close();
            };
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const { chat, runs } = await client(fetchFn);
    runs.announce('live');
    await until(() => chat.getSnapshot().messages.some((row) => row.content === 'Partial'));
    chat.appendStored({ id: 'mid-reply', role: 'user', content: 'sent while it replied' });
    finish();
    await until(() => !chat.getSnapshot().sessionGenerating);
    expect(chat.getSnapshot().messages.map((row) => row.content)).toEqual([
      'Partial and more',
      'sent while it replied',
    ]);
  });
  it('detaches a live SDK reader while retaining its partial reply without a run error', async () => {
    const fetchFn = vi.fn(async (input, init?: RequestInit) => {
      if (!new URL(String(input)).searchParams.has('runId')) return hydrate();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(encode(events('live', 'Partial').slice(0, 3))),
            );
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('Detached', 'AbortError')),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const { chat, runs } = await client(fetchFn);
    runs.announce('live');
    await until(() => chat.getSnapshot().messages.some((row) => row.content === 'Partial'));
    chat.stop();
    await until(() => !chat.getSnapshot().sessionGenerating);
    expect(chat.agent.isRunning).toBe(false);
    expect(chat.getSnapshot().messages).toMatchObject([{ content: 'Partial' }]);
    expect(chat.getSnapshot().error).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('what a person reads when the chat fails (D-228)', () => {
  const failedRun = (runId: string, extra: Record<string, unknown> = {}) => [
    { type: 'RUN_STARTED', runId, threadId: 'thread' },
    {
      type: 'RUN_ERROR',
      runId,
      threadId: 'thread',
      code: 'AUTH_FAILED',
      message: 'The provider would not let the bot use this model.',
      ...extra,
    },
  ];
  async function readRun(rows: unknown[]) {
    const { chat, runs } = await client(
      vi.fn(async (input) =>
        new URL(String(input)).searchParams.has('runId') ? sse(rows) : hydrate(),
      ),
    );
    runs.announce('failed');
    await until(() => !chat.getSnapshot().sessionGenerating);
    return chat.getSnapshot().error;
  }

  it('shows the server’s sentence and the provider’s reason, not a stand-in', async () => {
    const explanation = {
      source: 'OpenCode',
      text: "OpenCode's free tier can only be used from within OpenCode.",
    };
    expect(await readRun(failedRun('failed', { metadata: { crewaid: { explanation } } }))).toEqual({
      code: 'AUTH_FAILED',
      message: 'The provider would not let the bot use this model.',
      explanation,
    });
  });

  it('drops an explanation that is not the contract’s shape', async () => {
    const error = await readRun(
      failedRun('failed', { metadata: { crewaid: { explanation: { text: 'no source' } } } }),
    );
    expect(error?.message).toBe('The provider would not let the bot use this model.');
    expect(error?.explanation).toBeUndefined();
  });

  it('shows no failure for a run someone stopped', async () => {
    expect(
      await readRun([
        { type: 'RUN_STARTED', runId: 'failed', threadId: 'thread' },
        {
          type: 'RUN_ERROR',
          runId: 'failed',
          threadId: 'thread',
          code: 'RUN_CANCELLED',
          message: 'The bot was stopped.',
        },
      ]),
    ).toBeUndefined();
  });

  it('names the pending approval when a send is refused for it', async () => {
    const { chat } = await client(
      vi.fn(async (_url, init) =>
        init?.method === 'POST'
          ? Response.json({ code: 'THREAD_AWAITING_APPROVAL' }, { status: 409 })
          : hydrate(),
      ),
    );
    await expect(chat.sendMessage('hello')).rejects.toThrow();
    expect(chat.getSnapshot().error).toEqual({
      code: 'THREAD_AWAITING_APPROVAL',
      message: 'The bot is waiting for your answer above. Answer it first, then send this.',
    });
  });

  it('says the server was not reached when the send never arrives', async () => {
    const { chat } = await client(
      vi.fn(async (_url, init) => {
        if (init?.method === 'POST') throw new TypeError('Failed to fetch');
        return hydrate();
      }),
    );
    await expect(chat.sendMessage('hello')).rejects.toThrow();
    expect(chat.getSnapshot().error?.code).toBe('NETWORK');
    expect(chat.getSnapshot().error?.message).toMatch(/^Could not reach the server/);
  });
});
