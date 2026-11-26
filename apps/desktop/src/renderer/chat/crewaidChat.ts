import {
  AbstractAgent,
  buildResumeArray,
  runHttpRequest,
  transformHttpEventStream,
} from '@ag-ui/client';
import { EventType } from '@ag-ui/core';
import type { BaseEvent, Interrupt, Message, RunAgentInput, ResumeEntry } from '@ag-ui/core';
import { InterruptSchema, MessageSchema } from '@ag-ui/core/schemas';
import { concatWith, defer, EMPTY, retry, tap, throwError, timer, type Observable } from 'rxjs';
import {
  ChatHydrationSchema,
  ToolApprovalAnswerSchema,
  type TranscriptAttachment,
} from '@crewaid/shared';
import type { ChatError } from '../state/chatReducer';
import type { ChatEndpoint } from './chatEndpoint';
import { admissionFailure, conflictActiveRunId, runFailure } from './chatFailure';
import { t } from '../i18n/i18n';

export type RunAnnouncements = {
  readonly subscribe: (listener: (runId: string) => void) => () => void;
};
export type CrewaidChatOptions = {
  readonly endpoint: ChatEndpoint;
  readonly runs: RunAnnouncements;
  readonly threadId: string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly onHydrated?: () => void;
};

class AdmissionError extends Error {}
class StreamDisconnected extends Error {}
/** A send or an answer the server refused, with the sentence the person reads. */
class RefusedAdmission extends AdmissionError {
  constructor(
    readonly failure: ChatError,
    readonly activeRunId: string | null = null,
  ) {
    super(failure.message);
  }
}

/** Raised when "Stop and send" targets a run that already changed. */
export class TargetRunChangedError extends Error {
  constructor(
    message: string,
    readonly activeRunId: string | null,
  ) {
    super(message);
    this.name = 'TargetRunChangedError';
  }
}

/** Track only SSE delivery ids; protocol parsing and application belong to AG-UI. */
function trackOffsets(response: Response, received: (offset: string) => void): Response {
  if (response.body === null) return response;
  const decoder = new TextDecoder();
  let line = '';
  let id: string | undefined;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        for (const character of decoder.decode(bytes, { stream: true })) {
          if (character === '\n') {
            const finished = line.replace(/\r$/, '');
            if (finished.startsWith('id:')) id = finished.slice(3).trim();
            else if (finished === '' && id !== undefined) {
              received(id);
              id = undefined;
            }
            line = '';
          } else if (line.length < 512) line += character;
        }
        controller.enqueue(bytes);
      },
    }),
  );
  return new Response(body, { status: response.status, headers: response.headers });
}

class ChatAgent extends AbstractAgent {
  source: ((input: RunAgentInput) => Observable<BaseEvent>) | undefined;
  run(input: RunAgentInput): Observable<BaseEvent> {
    if (this.source === undefined) return throwError(() => new Error('No run reader'));
    return this.source(input);
  }
  protected override connect(input: RunAgentInput): Observable<BaseEvent> {
    return this.run(input);
  }
}

export type ChatInterrupt = {
  readonly kind: 'generic';
  readonly definitionId: string | undefined;
  readonly payload: unknown;
  readonly status: 'pending' | 'error';
  readonly resolveInterrupt: (answer: unknown) => void;
};
/** Failure codes that retrying the exact same request cannot resolve on its own. */
const NON_RETRYABLE_ERRORS: ReadonlySet<string> = new Set([
  'PAYMENT_REQUIRED',
  'PAYLOAD_TOO_LARGE',
  'INSUFFICIENT_STORAGE',
  'NOT_FOUND',
  'THREAD_AWAITING_APPROVAL',
  'RUN_BUSY',
  'INTERRUPT_NOT_PENDING',
  'TARGET_RUN_CHANGED',
]);

export type SendMessageOptions = {
  readonly body: { readonly attachmentIds: string[]; readonly interruptRunId?: string };
  readonly attachments?: readonly TranscriptAttachment[];
  /** Client-supplied stable id so reconnects and retries are idempotent. */
  readonly messageId?: string;
  /** Suppress the global transcript error banner on TARGET_RUN_CHANGED conflicts. */
  readonly quietConflict?: boolean;
};

type FailedSend = {
  readonly text: string;
  readonly data?: SendMessageOptions | undefined;
};

type FailedResume = {
  readonly resume: ResumeEntry[];
  readonly parentRunId: string | undefined;
};

export type ChatSnapshot = {
  readonly messages: Message[];
  readonly interrupts: ChatInterrupt[];
  readonly sessionGenerating: boolean;
  /** Currently streaming or queued run id on this thread, or null when idle. */
  readonly activeRunId: string | null;
  readonly startedAt: number | undefined;
  readonly isLoading: boolean;
  readonly resuming: boolean;
  readonly retrying: boolean;
  readonly canRetry: boolean;
  readonly hasOlderMessages: boolean;
  /** Already worded for the person; rendered as given. */
  readonly error: ChatError | undefined;
};
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** One AG-UI state owner and one sequential run reader per mounted thread. */
export class CrewaidChat {
  readonly agent: ChatAgent;
  private lifetime = new AbortController();
  private reader: AbortController | undefined;
  private readonly opened = new Set<string>();
  private readonly waiting: Array<{
    runId: string;
    response?: Response;
    resume?: ResumeEntry[];
    controller?: AbortController;
  }> = [];
  private reading = false;
  private readingRunId: string | undefined;
  // Stored rows announced while a run is read, added once the read ends.
  private readonly held: Message[] = [];
  // This window's own sends made while a run is read. Unlike `held` they show
  // at once, layered over the SDK's list, because the SDK's write-back would
  // erase them from it; they join that list once the read ends.
  private readonly sentWhileReading: Message[] = [];
  private readonly runStarts = new Map<string, number>();
  private hydrated = false;
  private hydration: Promise<void> | undefined;
  private admitting = 0;
  private resuming = false;
  private resumeError = false;
  private retrying = false;
  private lastFailedSend: FailedSend | null = null;
  private lastFailedResume: FailedResume | null = null;
  private error: ChatError | undefined;
  private cursor: string | undefined;
  private pausedRunId: string | undefined;
  private readonly listeners = new Set<() => void>();
  private notification: ReturnType<typeof setTimeout> | undefined;
  private snapshot: ChatSnapshot;
  private readonly answers: Record<string, { status: 'resolved'; payload: unknown }> = {};
  private unsubscribeRuns: (() => void) | undefined;

  constructor(private readonly options: CrewaidChatOptions) {
    this.agent = new ChatAgent({ threadId: options.threadId });
    this.agent.subscribe({
      onMessagesChanged: () => this.changed(),
      onRunInitialized: () => this.changed(true),
      onRunFinalized: () => {
        if (this.agent.pendingInterrupts.length === 0)
          for (const id of Object.keys(this.answers)) delete this.answers[id];
        this.changed(true);
      },
      onRunFinishedEvent: ({ event, input }) => {
        if (event.outcome?.type === 'interrupt') this.pausedRunId = input.runId;
      },
      onRunErrorEvent: ({ event }) => {
        // A stop leaves no banner: the reply's own note says it was stopped.
        this.error = runFailure(event) ?? this.error;
      },
      onRunStartedEvent: ({ event, input }) => {
        if (typeof event.timestamp !== 'number') return;
        const previous = this.runStarts.get(input.runId);
        this.runStarts.set(
          input.runId,
          previous === undefined ? event.timestamp : Math.min(previous, event.timestamp),
        );
        this.changed(true);
      },
    });
    this.snapshot = this.capture();
  }
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly getSnapshot = (): ChatSnapshot => this.snapshot;
  private visibleMessages(): Message[] {
    const messages = this.agent.messages;
    if (this.sentWhileReading.length === 0) return messages;
    const ids = new Set(messages.map((row) => row.id));
    return [...messages, ...this.sentWhileReading.filter((row) => !ids.has(row.id))];
  }
  private capture(): ChatSnapshot {
    return {
      messages: this.visibleMessages(),
      interrupts: this.agent.pendingInterrupts.map((interrupt) => {
        const metadata: unknown = interrupt.metadata;
        const fields = object(metadata);
        const binding = object(fields?.['tanstack:interruptBinding']);
        return {
          kind: 'generic',
          definitionId:
            typeof binding?.['definitionId'] === 'string' ? binding['definitionId'] : undefined,
          payload: fields?.['tanstack:interruptPayload'],
          status: this.resumeError ? 'error' : 'pending',
          resolveInterrupt: (answer: unknown) => this.resolve(interrupt, answer),
        };
      }),
      sessionGenerating: this.reading || this.waiting.length > 0,
      activeRunId: this.readingRunId ?? this.waiting[0]?.runId ?? null,
      startedAt:
        this.readingRunId === undefined ? undefined : this.runStarts.get(this.readingRunId),
      isLoading: this.admitting > 0,
      resuming: this.resuming,
      retrying: this.retrying,
      canRetry:
        this.error !== undefined &&
        (this.lastFailedSend !== null ||
          this.lastFailedResume !== null ||
          !NON_RETRYABLE_ERRORS.has(this.error.code)),
      hasOlderMessages: this.cursor !== undefined,
      error: this.error,
    };
  }
  private changed(immediate = false): void {
    if (!immediate && this.notification !== undefined) return;
    const publish = () => {
      this.notification = undefined;
      this.snapshot = this.capture();
      for (const listener of this.listeners) listener();
    };
    if (immediate) {
      clearTimeout(this.notification);
      publish();
    } else this.notification = setTimeout(publish, 16);
  }
  start(): void {
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    const signal = this.lifetime.signal;
    this.unsubscribeRuns = this.options.runs.subscribe((runId) => this.enqueue(runId));
    this.hydration = this.hydrate()
      .catch(() => {
        if (!signal.aborted) {
          this.error = { code: 'HISTORY_FAILED', message: t('chat.chatFailure.historyFailed') };
          this.changed(true);
        }
      })
      .finally(() => {
        if (!signal.aborted) {
          this.hydrated = true;
          this.options.onHydrated?.();
          void this.drain();
        }
      });
  }
  dispose(): void {
    this.unsubscribeRuns?.();
    void this.agent.detachActiveRun();
    this.lifetime.abort();
    this.reader?.abort();
    clearTimeout(this.notification);
    for (const pending of this.waiting) {
      pending.controller?.abort();
      void pending.response?.body?.cancel();
    }
    this.hydrated = false;
    this.waiting.length = 0;
    this.held.length = 0;
    this.sentWhileReading.length = 0;
    this.opened.clear();
    this.runStarts.clear();
  }
  readonly stop = (): void => {
    void this.agent.detachActiveRun();
    this.reader?.abort();
  };
  readonly setMessages = (messages: Message[]): void => {
    this.agent.setMessages(messages);
    this.changed(true);
  };
  /**
   * A stored row this window did not send: a message from Telegram or another
   * window, a teammate's, a routine's prompt, a notice. While a run is read the
   * SDK writes back the list it copied when the read began, so a row set then
   * would vanish with the run's next event; it waits for the read to end.
   */
  readonly appendStored = (message: Message): void => {
    if (this.readingRunId !== undefined) {
      this.held.push(message);
      return;
    }
    if (this.agent.messages.some((row) => row.id === message.id)) return;
    this.setMessages([...this.agent.messages, message]);
  };
  private fetch(url: string, init?: RequestInit): Promise<Response> {
    return (this.options.fetchFn ?? globalThis.fetch)(url, {
      ...init,
      headers: { ...this.options.endpoint.headers, ...init?.headers },
      signal:
        init?.signal == null
          ? this.lifetime.signal
          : AbortSignal.any([init.signal, this.lifetime.signal]),
    });
  }
  private async hydrate(before?: string): Promise<void> {
    const url = new URL(this.options.endpoint.url);
    url.searchParams.set('threadId', this.options.threadId);
    url.searchParams.set('limit', '150');
    if (before !== undefined) url.searchParams.set('before', before);
    const lifetime = this.lifetime.signal;
    const response = await this.fetch(url.toString(), { signal: lifetime });
    if (!response.ok) throw new AdmissionError('History could not load.');
    const hydration = ChatHydrationSchema.parse(await response.json());
    if (lifetime.aborted) return;
    const messages = hydration.messages.map((message) => MessageSchema.parse(message) as Message);
    this.cursor = hydration.page?.truncated === true ? hydration.page.cursor : undefined;
    if (before !== undefined) {
      const ids = new Set(this.agent.messages.map((message) => message.id));
      this.setMessages([
        ...messages.filter((message) => !ids.has(message.id)),
        ...this.agent.messages,
      ]);
      return;
    }
    const active = hydration.activeRun?.runId;
    if (active !== undefined && hydration.activeRun?.startedAt !== undefined)
      this.runStarts.set(active, hydration.activeRun.startedAt);
    const paused =
      (hydration.interrupts?.pending.length ?? 0) > 0 &&
      (active === undefined || hydration.interrupts?.runId === active);
    // Replay supplies current-run content. Seeding its partial snapshot would append it twice.
    this.setMessages(
      active !== undefined && !paused
        ? messages.filter((message) => {
            const metadata: unknown = message.metadata;
            const run = object(object(object(metadata)?.['tanstack'])?.['run']);
            return run?.['id'] !== active;
          })
        : messages,
    );
    this.pausedRunId = paused ? hydration.interrupts?.runId : undefined;
    this.agent.pendingInterrupts = paused
      ? (hydration.interrupts?.pending.map(
          (interrupt) => InterruptSchema.parse(interrupt) as Interrupt,
        ) ?? [])
      : [];
    this.changed(true);
    if (active !== undefined && !paused) this.enqueue(active);
  }
  readonly loadOlderMessages = async (): Promise<void> => {
    if (this.cursor !== undefined) await this.hydrate(this.cursor);
  };
  readonly sendMessage = async (
    text: string,
    data?: SendMessageOptions,
  ): Promise<string> => {
    await this.hydration;
    if (this.lifetime.signal.aborted) throw new AdmissionError('The conversation was closed.');
    const message: Message = {
      id: data?.messageId ?? crypto.randomUUID(),
      role: 'user',
      content: text,
    };
    // Uploads already exist before Send. Keep their display metadata locally
    // so a fresh voice note is a player immediately, without a history reload.
    const displayed: Message = data?.attachments?.length
      ? {
          ...message,
          metadata: {
            tanstack: { createdAt: Date.now() },
            crewaid: {
              author: 'USER',
              fromBotId: null,
              runId: null,
              sequence: 0,
              stopReason: null,
              taskId: null,
              routineId: null,
              chainId: null,
              hopCount: 0,
              startsTopic: false,
              attachments: data.attachments,
            },
          },
        }
      : message;
    // Mid-run, the server stores the message and answers it after the turn
    // (202). Set into the SDK's list now, it would vanish with the run's next
    // event, so it is layered on top until the read ends.
    if (this.readingRunId !== undefined) {
      if (!this.sentWhileReading.some((row) => row.id === displayed.id)) {
        this.sentWhileReading.push(displayed);
      }
      this.changed(true);
    } else if (!this.agent.messages.some((row) => row.id === displayed.id)) {
      this.setMessages([...this.agent.messages, displayed]);
    }
    try {
      await this.admit(
        [message],
        data?.body ?? {},
        undefined,
        undefined,
        data?.quietConflict === true,
      );
      this.lastFailedSend = null;
    } catch (error) {
      const at = this.sentWhileReading.findIndex((row) => row.id === message.id);
      if (at !== -1) this.sentWhileReading.splice(at, 1);
      this.setMessages(this.agent.messages.filter((row) => row.id !== message.id));
      const refusal = error instanceof RefusedAdmission ? error.failure.code : undefined;
      if (
        error instanceof RefusedAdmission &&
        error.failure.code === 'TARGET_RUN_CHANGED'
      ) {
        this.lastFailedSend = null;
        this.changed(true);
        throw new TargetRunChangedError(error.failure.message, error.activeRunId);
      }
      this.lastFailedSend =
        refusal !== undefined && NON_RETRYABLE_ERRORS.has(refusal)
          ? null
          : data === undefined
            ? { text, data: { body: { attachmentIds: [] }, messageId: message.id } }
            : { text, data: { ...data, messageId: message.id } };
      this.changed(true);
      throw error;
    }
    // The id the server stores the message under, which is how a
    // caller recognises the run that answers it.
    return message.id;
  };
  /**
   * Retry the last failed operation: replay a rejected/offline send (with its
   * attachments), resubmit a failed approval answer, re-hydrate a disconnected
   * stream or failed history load, or ask the bot to retry a failed run.
   * Returns claimed attachment ids when a failed send succeeds on retry.
   */
  readonly retry = async (): Promise<readonly string[] | null> => {
    if (
      this.retrying ||
      this.admitting > 0 ||
      this.resuming ||
      this.lifetime.signal.aborted ||
      this.error === undefined
    ) {
      return null;
    }
    this.retrying = true;
    this.changed(true);
    try {
      if (this.lastFailedSend !== null) {
        const failed = this.lastFailedSend;
        this.lastFailedSend = null;
        try {
          await this.sendMessage(failed.text, failed.data);
          return failed.data?.body.attachmentIds ?? [];
        } catch {
          return null;
        }
      }
      if (this.lastFailedResume !== null) {
        const failed = this.lastFailedResume;
        this.lastFailedResume = null;
        this.resuming = true;
        this.resumeError = false;
        this.changed(true);
        try {
          await this.admit([], {}, failed.resume, failed.parentRunId);
        } catch (error) {
          this.resumeError = true;
          const refusal = error instanceof RefusedAdmission ? error.failure.code : undefined;
          if (refusal === undefined || !NON_RETRYABLE_ERRORS.has(refusal)) {
            this.lastFailedResume = failed;
          }
        } finally {
          this.resuming = false;
          this.changed(true);
        }
        return null;
      }
      if (this.error.code === 'HISTORY_FAILED' || this.error.code === 'RUN_DISCONNECTED') {
        this.error = undefined;
        this.changed(true);
        try {
          await this.hydrate();
          this.hydrated = true;
          this.options.onHydrated?.();
          void this.drain();
        } catch {
          if (!this.lifetime.signal.aborted) {
            this.error = { code: 'HISTORY_FAILED', message: t('chat.chatFailure.historyFailed') };
            this.changed(true);
          }
        }
        return null;
      }
      if (!NON_RETRYABLE_ERRORS.has(this.error.code)) {
        try {
          await this.sendMessage(t('chat.retryPrompt'));
        } catch {
          // sendMessage already surfaced the new error.
        }
      }
      return null;
    } finally {
      this.retrying = false;
      this.changed(true);
    }
  };
  private async admit(
    messages: Message[],
    forwardedProps: unknown,
    resume?: ResumeEntry[],
    parentRunId?: string,
    quietConflict = false,
  ): Promise<void> {
    const runId = crypto.randomUUID();
    const controller = new AbortController();
    const sending = resume === undefined ? 'message' : 'answer';
    this.opened.add(runId); // Reserve before HTTP: the announcement may beat the response.
    this.admitting++;
    if (!quietConflict) this.error = undefined;
    this.changed(true);
    try {
      const response = await this.fetch(this.options.endpoint.url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: this.options.threadId,
          runId,
          messages,
          tools: [],
          state: {},
          context: [],
          forwardedProps,
          ...(resume === undefined ? {} : { resume, parentRunId }),
        }),
      });
      if (!response.ok) {
        // The body names the refusals a person can act on.
        const body = await response.text().catch(() => undefined);
        throw new RefusedAdmission(
          admissionFailure(response.status, body, sending),
          conflictActiveRunId(body),
        );
      }
      if (response.status === 202) {
        void response.body?.cancel();
        return;
      }
      this.waiting.push({
        runId,
        response,
        controller,
        ...(resume === undefined ? {} : { resume }),
      });
      void this.drain();
    } catch (error) {
      controller.abort();
      this.opened.delete(runId);
      const isQuietTargetChanged =
        quietConflict &&
        error instanceof RefusedAdmission &&
        error.failure.code === 'TARGET_RUN_CHANGED';
      if (!isQuietTargetChanged) {
        // Anything but a refusal is the request never arriving.
        this.error =
          error instanceof RefusedAdmission
            ? error.failure
            : admissionFailure(undefined, undefined, sending);
      }
      throw error;
    } finally {
      this.admitting--;
      this.changed(true);
    }
  }
  private resolve(interrupt: Interrupt, answer: unknown): void {
    const parsed = ToolApprovalAnswerSchema.safeParse(answer);
    if (!parsed.success || this.resuming) return;
    this.answers[interrupt.id] = { status: 'resolved', payload: parsed.data };
    const pending = this.agent.pendingInterrupts;
    if (!pending.every((entry) => this.answers[entry.id] !== undefined)) return;
    this.resuming = true;
    this.resumeError = false;
    this.changed(true);
    const responses = Object.fromEntries(
      pending.map((entry) => [
        entry.id,
        { ...this.answers[entry.id]!, metadata: entry.metadata ?? {} },
      ]),
    );
    const resume = buildResumeArray(pending, responses);
    const parentRunId = this.pausedRunId;
    void this.admit([], {}, resume, parentRunId)
      .then(() => {
        this.lastFailedResume = null;
      })
      .catch((error) => {
        this.resumeError = true;
        const refusal = error instanceof RefusedAdmission ? error.failure.code : undefined;
        this.lastFailedResume =
          refusal !== undefined && NON_RETRYABLE_ERRORS.has(refusal)
            ? null
            : { resume, parentRunId };
        for (const key of Object.keys(this.answers)) delete this.answers[key];
      })
      .finally(() => {
        this.resuming = false;
        this.changed(true);
      });
  }
  private enqueue(runId: string): void {
    if (this.opened.has(runId)) return;
    this.opened.add(runId);
    this.waiting.push({ runId });
    void this.drain();
  }
  private async drain(): Promise<void> {
    if (this.reading || !this.hydrated || this.lifetime.signal.aborted) return;
    const lifetime = this.lifetime.signal;
    this.reading = true;
    this.changed(true);
    try {
      while (this.waiting.length > 0 && !lifetime.aborted) {
        const next = this.waiting.shift()!;
        this.readingRunId = next.runId;
        const reader = next.controller ?? new AbortController();
        this.reader = reader;
        let response = next.response;
        let offset = '-1';
        let terminal = false;
        this.agent.source = () =>
          defer<Observable<BaseEvent>>(() =>
            transformHttpEventStream(
              runHttpRequest(async () => {
                const url = new URL(this.options.endpoint.url);
                url.searchParams.set('runId', next.runId);
                url.searchParams.set('offset', offset);
                const result =
                  response ?? (await this.fetch(url.toString(), { signal: reader.signal }));
                response = undefined;
                if (!result.ok) throw new AdmissionError('The run could not be read.');
                return trackOffsets(result, (id) => {
                  offset = id;
                });
              }),
            ),
          ).pipe(
            tap<BaseEvent>((event) => {
              if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR)
                terminal = true;
            }),
            concatWith(
              defer<Observable<BaseEvent>>(() =>
                terminal || reader.signal.aborted
                  ? EMPTY
                  : throwError(() => new StreamDisconnected()),
              ),
            ),
            retry<BaseEvent>({
              count: 3,
              delay: (error: unknown, attempt) =>
                error instanceof AdmissionError ||
                reader.signal.aborted ||
                this.lifetime.signal.aborted
                  ? throwError(() => error)
                  : timer(attempt * 250),
            }),
          );
        try {
          const parameters = {
            runId: next.runId,
            ...(next.resume === undefined ? {} : { resume: next.resume }),
          };
          // Joining a durable run reads history; it must not require answers
          // to a question the SDK would enforce when starting a new run.
          if (next.response === undefined) await this.agent.connectAgent(parameters);
          else await this.agent.runAgent(parameters);
        } catch {
          // A run that reached its own end already said why; only a stream cut
          // short is a lost connection.
          if (!terminal && !reader.signal.aborted && !this.lifetime.signal.aborted)
            this.error = {
              code: 'RUN_DISCONNECTED',
              message: t('chat.chatFailure.runDisconnected'),
            };
        } finally {
          reader.abort();
          this.reader = undefined;
          this.readingRunId = undefined;
          // Own sends first: they were typed before any held row could be
          // announced for them, and the held copy of one then dedupes by id.
          const sent = this.sentWhileReading.splice(0);
          if (sent.length > 0) {
            const ids = new Set(this.agent.messages.map((row) => row.id));
            this.agent.setMessages([
              ...this.agent.messages,
              ...sent.filter((row) => !ids.has(row.id)),
            ]);
          }
          for (const message of this.held.splice(0)) this.appendStored(message);
          this.changed(true);
        }
      }
    } finally {
      this.reading = false;
      this.changed(true);
      if (this.waiting.length > 0 && !this.lifetime.signal.aborted) void this.drain();
    }
  }
}
export function crewaidChat(options: CrewaidChatOptions): CrewaidChat {
  return new CrewaidChat(options);
}
export function createRunAnnouncements(): RunAnnouncements & { announce: (runId: string) => void } {
  const listeners = new Set<(runId: string) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    announce(runId) {
      for (const listener of listeners) listener(runId);
    },
  };
}
