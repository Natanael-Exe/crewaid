import { describe, expect, it } from 'vitest';
import type { RecordingStatusResponse, ServerFrame } from '@crewaid/shared';
import { chatReducer, initialChatState, type ChatState } from '../src/renderer/state/chatReducer';
import { approvalBinding } from './approvalBinding';
import { formatDateLabel, toBotRowView } from '../src/renderer/state/viewTypes';

/**
 * What the reducer still decides, now that the transcript is not its business.
 *
 * D-192 moved a thread's messages, the reply in flight, the page cursor and
 * the approval prompts onto the chat client, which reads them from the run's
 * own durable log and from the server's history. So this suite is about
 * everything a conversation is NOT: the roster and its sandbox rows, the wake
 * a card asked for, the teaching flow, the Work revisions, the plan notice,
 * the activity clock a bot with no client is judged by, and the one sentence a
 * failure leaves the operator.
 *
 * The `message.*` and `approval.*` arms are covered here only where they still
 * do something — the activity clock, and the reason a refusal gives — plus one
 * case per group pinning that the rest of the frame changes nothing. Writing
 * the transcript from a frame as well as from the log is how a reply would be
 * painted twice, so "changes nothing" is the property worth holding.
 */

const BOT = 'clx1a2b3c4d5e6f7g8h9i0j1';
const OTHER = 'clxccccccccccccccccccc1';
const CONV = 'clx9z8y7x6w5v4u3t2s1r0q9';
const MSG_1 = 'clxaaaaaaaaaaaaaaaaaaaa1';
const MSG_2 = 'clxaaaaaaaaaaaaaaaaaaaa2';
const UUID = '3f1a5c2e-9b47-4d81-a6f2-0e5c7b8d1234';

function messageRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    conversationId: CONV,
    author: 'BOT' as const,
    fromBotId: BOT,
    content: '',
    parts: null,
    stopReason: null,
    chainId: null,
    hopCount: 0,
    taskId: null,
    routineId: null,
    startsTopic: false,
    createdAt: '2026-09-01T12:00:00.000Z',
    attachments: [],
    ...overrides,
  };
}

function frame(type: string, payload: unknown, botId: string | undefined = BOT): ServerFrame {
  return {
    id: UUID,
    type,
    ...(botId === undefined ? {} : { botId }),
    ts: 1_759_000_000_000,
    payload,
  } as ServerFrame;
}

function apply(state: ChatState, ...frames: ServerFrame[]): ChatState {
  return frames.reduce((acc, f) => chatReducer(acc, { type: 'ws/frame', frame: f }), state);
}

/** A bot the reducer agrees is mid-turn, which is the state most arms act on. */
function working(): ChatState {
  return apply(initialChatState, frame('bot.status', { botId: BOT, status: 'ACTING' }));
}

describe('the message frames the transcript no longer comes from (D-192)', () => {
  it('leaves state identical for an attachment claim', () => {
    // The reply and its files reach the window on the run's delivery log, and
    // a reducer that also folded them in would be the second writer of the
    // same news. Identity, not deep equality — a copy re-renders every
    // memoized consumer for no change.
    const before = working();
    const after = apply(
      before,
      frame('message.attachments', {
        messageId: MSG_1,
        attachments: [
          {
            id: 'clxattach00000000000001',
            messageId: MSG_1,
            filename: 'shot.png',
            mimeType: 'image/png',
            sizeBytes: 2048,
            storageKey: '2026-09-01/shot.png',
          },
        ],
      }),
    );
    expect(after).toBe(before);
  });

  it('starts the clock for a bot drafting a reply, and not for a message delivered to it', () => {
    // CC-44, the one thing `message.created` is still read for. A draft means
    // a turn is under way — including one this window did not start, which is
    // the case no composer knows about. A teammate's row is a BOT message with
    // a FOREIGN sender: it is complete on arrival and says nothing about
    // anyone working, so a spinner for it would never be taken down.
    const drafting = apply(initialChatState, frame('message.created', messageRow(MSG_1)));
    expect(drafting.activityByBot[BOT]?.startedAt).toBeTypeOf('number');

    const delivered = apply(
      initialChatState,
      frame('message.created', messageRow(MSG_2, { fromBotId: OTHER })),
    );
    expect(delivered.activityByBot[BOT]).toBeUndefined();
  });
});

describe('approval frames (D-192)', () => {
  const TURN = 'clxbbbbbbbbbbbbbbbbbbbb1';

  it('leaves state identical for the question and for an answer that granted it', () => {
    // The prompt is the run's own interrupt, raised and resolved by the chat
    // client. Holding a second copy here is how one question becomes two
    // prompts, the later answer refused as stale.
    const before = working();
    const after = apply(
      before,
      frame('approval.requested', {
        binding: approvalBinding(),
        botId: BOT,
        turnId: TURN,
        toolCallId: 'tc-1',
        toolName: 'shell',
        args: { command: 'rm -rf /' },
      }),
      frame('approval.resolved', { botId: BOT, turnId: TURN, toolCallId: 'tc-1', approved: true }),
    );
    expect(after).toBe(before);
  });

  it('keeps the reason a refusal gives, which the interrupt does not carry', () => {
    // A policy said no, or the turn ended under the question. The operator
    // pressed Approve and something else decided; without this they are left
    // with a prompt that simply vanished.
    const refused = apply(
      initialChatState,
      frame('approval.resolved', {
        botId: BOT,
        turnId: TURN,
        toolCallId: 'tc-1',
        approved: false,
        reason: 'APPROVAL_STALE',
      }),
    );
    expect(refused.errorByBot[BOT]).toEqual({
      code: 'APPROVAL_REFUSED',
      message: 'APPROVAL_STALE',
    });

    // A refusal with no reason leaves nothing to say, so nothing is said.
    const silent = apply(
      initialChatState,
      frame('approval.resolved', { botId: BOT, turnId: TURN, toolCallId: 'tc-1', approved: false }),
    );
    expect(silent).toBe(initialChatState);
  });
});

describe('the sentence a failure leaves (D-192)', () => {
  const runStarted = (botId: string) =>
    frame('run.started', { botId, threadId: CONV, runId: 'run-next' }, botId);

  it('stays until the bot’s next run starts, then goes', () => {
    // The send that used to clear it is the chat client's now, so the clear
    // moved to the one announcement every run makes. Left alone, a failure
    // would stay on screen for the life of the window — under every later
    // reply, describing a turn that is long over.
    const failed = apply(
      working(),
      frame('error', { code: 'PROVIDER_ERROR', message: 'The model could not answer.' }),
    );
    expect(failed.errorByBot[BOT]?.code).toBe('PROVIDER_ERROR');
    expect(apply(failed, runStarted(BOT)).errorByBot[BOT]).toBeNull();
  });

  it('is cleared by a run nobody in this window started', () => {
    // A routine's run is just as much the bot's next turn. The sentence is
    // about the turn that failed, not about who asked for the next one.
    const refused = apply(
      initialChatState,
      frame('approval.resolved', {
        botId: BOT,
        turnId: 'clxbbbbbbbbbbbbbbbbbbbb1',
        toolCallId: 'tc-1',
        approved: false,
        reason: 'APPROVAL_STALE',
      }),
    );
    expect(apply(refused, runStarted(BOT)).errorByBot[BOT]).toBeNull();
  });

  it('is one bot’s, and a run elsewhere changes nothing', () => {
    const failed = apply(
      working(),
      frame('error', { code: 'PROVIDER_ERROR', message: 'The model could not answer.' }),
    );
    const after = apply(failed, runStarted(OTHER));
    expect(after.errorByBot[BOT]?.code).toBe('PROVIDER_ERROR');
    // A run on a bot with nothing to clear is not a state change at all.
    expect(after).toBe(failed);
  });
});

describe('sidebar preview', () => {
  it('reads the line off the roster row, and says what the bot is FOR when the thread is empty', () => {
    // D-192: the server flattens the newest spoken message in one query, so
    // the line is right for a bot nobody has opened — the old reading took it
    // from whatever transcript this window happened to hold, which left every
    // row but the one on screen showing the bot's role.
    const spoken = toBotRowView({
      id: BOT,
      role: 'Outbound Writer',
      thread: {
        id: CONV,
        preview: { text: 'Sent the follow-ups.', createdAt: new Date('2026-09-01T10:00:00.000Z') },
      },
    } as never);
    expect(spoken.preview).toBe('Sent the follow-ups.');
    expect(spoken.timeLabel).not.toBe('');

    const silent = toBotRowView({
      id: BOT,
      role: 'Outbound Writer',
      thread: { id: CONV, preview: null },
    } as never);
    expect(silent.preview).toBe('Outbound Writer');
    expect(silent.timeLabel).toBe('');
  });
});

describe('other frames', () => {
  it('updates a bot status in place', () => {
    const seeded: ChatState = {
      ...initialChatState,
      bots: [{ id: BOT, status: 'IDLE' } as never],
    };
    const next = apply(seeded, frame('bot.status', { botId: BOT, status: 'THINKING' }));
    expect(next.bots[0]?.status).toBe('THINKING');
  });

  it('keeps only the neutral half of an error frame — detail is for logs (D-006)', () => {
    const next = apply(
      initialChatState,
      frame('error', {
        code: 'RATE_LIMIT',
        message: 'The model is busy.',
        detail: { vendor: 'do not render this' },
      }),
    );
    expect(next.errorByBot[BOT]).toEqual({ code: 'RATE_LIMIT', message: 'The model is busy.' });
    expect(JSON.stringify(next.errorByBot[BOT])).not.toContain('do not render');
  });

  it('files a bot-less error frame under lastError — the gateway sends those for a bad envelope', () => {
    // Built inline, not via `frame`: passing `undefined` for its botId
    // parameter would just re-select the default.
    const botless = {
      id: UUID,
      type: 'error',
      ts: 1_759_000_000_000,
      payload: { code: 'VALIDATION_ERROR', message: 'Frame is not a §4.2 envelope' },
    } as ServerFrame;
    const next = apply(initialChatState, botless);
    expect(next.lastError).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Frame is not a §4.2 envelope',
    });
    expect(next.errorByBot[BOT]).toBeUndefined();
  });

  it('leaves state untouched for a roster change — the refetch is not a reducer job', () => {
    // `bots.changed` says the ROSTER moved; `useChat` answers it with a
    // `GET /bots` (that read owns the full row, `sandbox` included). Deriving
    // anything here from an id and a verb would be a second, weaker copy.
    const before = apply(
      initialChatState,
      frame('bots.changed', {
        botId: BOT,
        change: 'created',
      }),
    );
    expect(before).toBe(initialChatState);
  });

  it('returns the same state object for frames this shell holds nothing for', () => {
    // `run.started` is the chat client's — it is how a window joins a run it
    // did not start (D-188) — and reaches it through `ChatThread`, not here.
    const next = apply(
      initialChatState,
      frame('turn.step', { botId: BOT, turnId: CONV, stepIndex: 0 }),
      frame('mcp.status', { serverId: CONV, status: 'CONNECTED', toolCount: 3 }),
      frame('run.started', { botId: BOT, threadId: CONV, runId: 'run-1' }),
    );
    expect(next).toBe(initialChatState);
  });
});

describe('date labels', () => {
  it('names today and yesterday, and dates anything older', () => {
    const now = new Date('2026-09-04T12:00:00.000Z');
    expect(formatDateLabel('2026-09-04T09:00:00.000Z', now)).toBe('Today');
    expect(formatDateLabel('2026-09-03T09:00:00.000Z', now)).toBe('Yesterday');
    expect(formatDateLabel('2026-08-28T09:00:00.000Z', now)).toMatch(/Aug 2[78], 2026/);
  });

  it('returns an empty label for an unparseable timestamp rather than "Invalid Date"', () => {
    expect(formatDateLabel('not-a-date')).toBe('');
  });
});

describe('sandbox.state (M2-FE-01)', () => {
  const botRow = (sandbox: unknown) =>
    ({
      id: BOT,
      name: 'Quill',
      sandbox,
    }) as never;

  const frame = (state: string, widthPx = 1280, heightPx = 800): ServerFrame =>
    ({
      id: UUID,
      type: 'sandbox.state',
      ts: 1,
      payload: { botId: BOT, state, widthPx, heightPx },
    }) as ServerFrame;

  const withBot = (sandbox: unknown): ChatState =>
    chatReducer(initialChatState, { type: 'bots/loaded', bots: [botRow(sandbox)] });

  it('patches the row the screen card reads', () => {
    // Without this the sandbox only ever reflects the GET /bots fetch, so a
    // desktop that came up after the app did is unwatchable until a reload.
    const before = withBot({ state: 'STOPPED', widthPx: 1280, heightPx: 800, lastError: null });
    const after = chatReducer(before, { type: 'ws/frame', frame: frame('RUNNING') });
    expect(after.bots[0]?.sandbox?.state).toBe('RUNNING');
  });

  it('carries the geometry, which the synthetic ServerInit declares', () => {
    const before = withBot({ state: 'STOPPED', widthPx: 1280, heightPx: 800, lastError: null });
    const after = chatReducer(before, { type: 'ws/frame', frame: frame('RUNNING', 1024, 768) });
    expect(after.bots[0]?.sandbox?.widthPx).toBe(1024);
    expect(after.bots[0]?.sandbox?.heightPx).toBe(768);
  });

  it('keeps the fields the payload does not carry', () => {
    // `Sandbox` has columns this frame knows nothing about, and the card reads
    // some of them. Replacing the row would blank them.
    const before = withBot({
      state: 'RUNNING',
      widthPx: 1280,
      heightPx: 800,
      lastError: 'earlier failure',
      sessionId: 'sess-1',
    });
    const after = chatReducer(before, { type: 'ws/frame', frame: frame('UNHEALTHY') });
    expect(after.bots[0]?.sandbox).toMatchObject({
      state: 'UNHEALTHY',
      sessionId: 'sess-1',
      lastError: 'earlier failure',
    });
  });

  it('does not invent a row for a bot that has never been started', () => {
    // A half-built row would reach a component that reads containerId and the
    // port fields, none of which this payload carries.
    const before = withBot(null);
    const after = chatReducer(before, { type: 'ws/frame', frame: frame('RUNNING') });
    expect(after.bots[0]?.sandbox).toBeNull();
  });

  it('returns the same state when nothing matched', () => {
    // Identity matters here: the bots array feeds memoized sidebar rows, and a
    // new array per frame would re-render every one of them for no change.
    const before = withBot(null);
    const after = chatReducer(before, { type: 'ws/frame', frame: frame('RUNNING') });
    expect(after).toBe(before);
  });
});

describe('the wake a card asks for (CC-16)', () => {
  const botRow = (sandbox: unknown) => ({ id: BOT, name: 'Quill', sandbox }) as never;

  const stopped = { state: 'STOPPED', widthPx: 1280, heightPx: 800, lastError: null };

  const withBot = (sandbox: unknown): ChatState =>
    chatReducer(initialChatState, { type: 'bots/loaded', bots: [botRow(sandbox)] });

  const status = (state: string, lastError: string | null = null) =>
    ({ botId: BOT, state, widthPx: 1280, heightPx: 800, lastError }) as never;

  const frame = (state: string): ServerFrame =>
    ({
      id: UUID,
      type: 'sandbox.state',
      ts: 1,
      payload: { botId: BOT, state, widthPx: 1280, heightPx: 800 },
    }) as ServerFrame;

  it('holds the request against the bot that made it, not the selected one', () => {
    // A wake keeps running when the operator switches away (D-041: switching
    // detaches the viewer, it does not cancel work), so its answer has to be
    // waiting on the right bot when they come back.
    const after = chatReducer(withBot(stopped), { type: 'sandbox/waking', botId: BOT });
    expect(after.wakeByBot[BOT]).toEqual({ kind: 'waking' });
    expect(after.wakeByBot['some-other-bot']).toBeUndefined();
  });

  it('merges the start response into the row rather than replacing it', () => {
    // `SandboxStatusResponse` is five columns of a table with many more, and
    // the card reads some of the others. Same rule as the §4.2 frame above.
    const before = chatReducer(withBot({ ...stopped, sessionId: 'sess-1' }), {
      type: 'sandbox/waking',
      botId: BOT,
    });

    const after = chatReducer(before, {
      type: 'sandbox/settled',
      botId: BOT,
      status: status('RUNNING'),
    });

    expect(after.bots[0]?.sandbox).toMatchObject({ state: 'RUNNING', sessionId: 'sess-1' });
    expect(after.wakeByBot[BOT]).toBeUndefined();
  });

  it('keeps the reason a start settled on something other than running', () => {
    // The response carries `lastError`, which the frame does not — so a start
    // that lands UNHEALTHY can say why without waiting for a refetch.
    const after = chatReducer(withBot(stopped), {
      type: 'sandbox/settled',
      botId: BOT,
      status: status('UNHEALTHY', 'bridge probe timed out'),
    });
    expect(after.bots[0]?.sandbox).toMatchObject({
      state: 'UNHEALTHY',
      lastError: 'bridge probe timed out',
    });
  });

  it('tells a full host apart from a broken one', () => {
    // D-039 §16.1: the same request succeeds later, so this is not a failure
    // the operator should read as their bot being broken.
    const full = chatReducer(withBot(stopped), {
      type: 'sandbox/wakeFailed',
      botId: BOT,
      error: { code: 'SANDBOX_CAPACITY', message: 'This host is already running six.' },
    });
    const broken = chatReducer(withBot(stopped), {
      type: 'sandbox/wakeFailed',
      botId: BOT,
      error: { code: 'NETWORK', message: 'Could not reach the server.' },
    });

    expect(full.wakeByBot[BOT]).toEqual({
      kind: 'capacity',
      message: 'This host is already running six.',
    });
    expect(broken.wakeByBot[BOT]).toEqual({
      kind: 'failed',
      message: 'Could not reach the server.',
    });
  });

  it('drops a stale refusal when the computer comes up by any route', () => {
    // A skill or a recording wakes the same desktop (§16). Leaving "the host
    // is full" behind would replay it the next time the computer stopped.
    const refused = chatReducer(withBot(stopped), {
      type: 'sandbox/wakeFailed',
      botId: BOT,
      error: { code: 'SANDBOX_CAPACITY', message: 'This host is already running six.' },
    });

    const up = chatReducer(refused, { type: 'ws/frame', frame: frame('RUNNING') });

    expect(up.wakeByBot[BOT]).toBeUndefined();
  });

  it('does not let a frame still in flight answer the click', () => {
    // The idle sweep may have stopped this computer a moment before the press,
    // and its STOPPED frame can land after `sandbox/waking`. Clearing on
    // anything but RUNNING would put "asleep" on screen mid-wake.
    const waking = chatReducer(withBot(stopped), { type: 'sandbox/waking', botId: BOT });

    const late = chatReducer(waking, { type: 'ws/frame', frame: frame('STOPPED') });

    expect(late.wakeByBot[BOT]).toEqual({ kind: 'waking' });
  });

  it('keeps the state identical when a RUNNING frame changes nothing', () => {
    // The wake-clearing must not cost the identity the memoized sidebar rows
    // depend on: this bot has no row to patch and no wake to drop.
    const before = withBot(null);
    expect(chatReducer(before, { type: 'ws/frame', frame: frame('RUNNING') })).toBe(before);
  });
});

describe('recording (M3-FE-01)', () => {
  const REC = 'clxrecording00000000001';
  const REC_2 = 'clxrecording00000000002';
  const SKILL = 'clxskill000000000000001';

  const event = (
    counts: { x11: number; cdp: number },
    type = 'pointer',
    recordingId = REC,
    botId: string | undefined = BOT,
  ): ServerFrame => frame('recording.event', { recordingId, layer: 'X11', type, counts }, botId);

  const stateFrame = (state: string, recordingId = REC, botId: string | undefined = BOT) =>
    frame('recording.state', { recordingId, state }, botId);

  const statusBody = (over: Partial<RecordingStatusResponse> = {}): RecordingStatusResponse => ({
    id: REC,
    state: 'READY',
    intent: null,
    cdpAvailable: false,
    warning: null,
    error: null,
    counts: { x11: 9, cdp: 0, atspi: 0 },
    skillId: null,
    ...over,
  });

  const settled = (over: Partial<RecordingStatusResponse> = {}, botId = BOT) =>
    chatReducer(
      chatReducer(initialChatState, {
        type: 'ws/frame',
        frame: event({ x11: 9, cdp: 0 }, 'pointer'),
      }),
      { type: 'recording/settled', botId, status: statusBody(over) },
    );

  it('adopts a recording from its first event frame, so a reload cannot hide a live capture', () => {
    // The window that reloaded mid-recording has no row for it, but the tee is
    // still writing — the frame IS the evidence the capture is live.
    const next = apply(initialChatState, event({ x11: 3, cdp: 0 }, 'type'));

    expect(next.recordingByBot[BOT]).toEqual({
      kind: 'recording',
      recordingId: REC,
      counts: { x11: 3, cdp: 0 },
      lastType: 'type',
      error: null,
    });
  });

  it("the counter follows the tee's cumulative counts", () => {
    const next = apply(
      initialChatState,
      event({ x11: 3, cdp: 0 }, 'type'),
      event({ x11: 5, cdp: 1 }, 'key'),
    );

    expect(next.recordingByBot[BOT]).toEqual({
      kind: 'recording',
      recordingId: REC,
      counts: { x11: 5, cdp: 1 },
      lastType: 'key',
      error: null,
    });
  });

  it('ignores a late event frame for a recording that already settled', () => {
    // The throttled frame was queued while capture was ending; it must not
    // resurrect a counter next to a finished recording.
    const ready = settled();
    expect(ready.recordingByBot[BOT]?.kind).toBe('ready');

    const after = chatReducer(ready, { type: 'ws/frame', frame: event({ x11: 10, cdp: 0 }) });

    expect(after).toBe(ready);
  });

  it('starts the view from a RECORDING state frame when nothing is on screen', () => {
    const next = apply(initialChatState, stateFrame('RECORDING'));

    expect(next.recordingByBot[BOT]).toEqual({
      kind: 'recording',
      recordingId: REC,
      counts: { x11: 0, cdp: 0 },
      lastType: null,
      error: null,
    });
  });

  it('does not let a queued RECORDING frame undo the stop the operator pressed', () => {
    // The frame was emitted when capture began; the stop came later. A view
    // that snapped back to `recording` would offer Stop for a call already out.
    const started = apply(initialChatState, stateFrame('RECORDING'));
    const stopping = chatReducer(started, { type: 'recording/stopping', botId: BOT });

    const late = chatReducer(stopping, { type: 'ws/frame', frame: stateFrame('RECORDING') });

    expect(late).toBe(stopping);
  });

  it('settles to compiling and then ready as the state frames arrive', () => {
    const started = apply(initialChatState, stateFrame('RECORDING'));
    const compiling = chatReducer(started, { type: 'ws/frame', frame: stateFrame('COMPILING') });
    expect(compiling.recordingByBot[BOT]?.kind).toBe('compiling');

    const ready = chatReducer(compiling, { type: 'ws/frame', frame: stateFrame('READY') });
    expect(ready.recordingByBot[BOT]).toEqual({
      kind: 'ready',
      recordingId: REC,
      counts: { x11: 0, cdp: 0 },
      skillId: null,
      skillName: null,
      warning: null,
      error: null,
    });
  });

  it('settles a FAILED frame with readable copy', () => {
    const started = apply(initialChatState, stateFrame('RECORDING'));

    const failed = chatReducer(started, { type: 'ws/frame', frame: stateFrame('FAILED') });

    // The frame carries `{recordingId, state}` and nothing else (D-042), so
    // this is the only place the constant is the right answer.
    expect(failed.recordingByBot[BOT]).toEqual({
      kind: 'failed',
      recordingId: REC,
      message: 'The recording failed and no skill was produced.',
    });
  });

  it('shows the reason the READ carries, not the fallback (D-044)', () => {
    const started = apply(initialChatState, stateFrame('RECORDING'));
    const reason = 'the compiler refused the trace: it ends mid-task';

    const failed = chatReducer(started, {
      type: 'recording/settled',
      botId: BOT,
      status: statusBody({ state: 'FAILED', error: reason }),
    });

    // §6/M3 asks for "a FAILED recording with a readable error", and D-044 put
    // it on `Recording.error` already normalized (D-006). Substituting the
    // constant here would spend the round trip and still leave the operator
    // with nothing but the word FAILED.
    expect(failed.recordingByBot[BOT]).toEqual({
      kind: 'failed',
      recordingId: REC,
      message: reason,
    });
  });

  it('falls back when a FAILED read carries no reason', () => {
    const started = apply(initialChatState, stateFrame('RECORDING'));

    const failed = chatReducer(started, {
      type: 'recording/settled',
      botId: BOT,
      status: statusBody({ state: 'FAILED', error: null }),
    });

    expect(failed.recordingByBot[BOT]).toEqual({
      kind: 'failed',
      recordingId: REC,
      message: 'The recording failed and no skill was produced.',
    });
  });

  it('clears the view when the recording is discarded', () => {
    const started = apply(initialChatState, stateFrame('RECORDING'));

    const cleared = chatReducer(started, { type: 'ws/frame', frame: stateFrame('DISCARDED') });

    expect(cleared.recordingByBot[BOT]).toBeUndefined();
  });

  it('clears the view on the discard response, for every phase that has one', () => {
    // D-098's press answers with the settled `DISCARDED` status, which the same
    // fold that handles a stop already removes the view for.
    const discarded = statusBody({ state: 'DISCARDED' });
    for (const view of ['recording', 'compiling'] as const) {
      const started =
        view === 'recording'
          ? apply(initialChatState, stateFrame('RECORDING'))
          : chatReducer(apply(initialChatState, stateFrame('RECORDING')), {
              type: 'ws/frame',
              frame: stateFrame('COMPILING'),
            });
      const cleared = chatReducer(started, {
        type: 'recording/settled',
        botId: BOT,
        status: discarded,
      });
      expect(cleared.recordingByBot[BOT]).toBeUndefined();
    }
  });

  it('clears a failed start locally — there is no row to discard', () => {
    const failing = chatReducer(initialChatState, { type: 'recording/starting', botId: BOT });
    const failed = chatReducer(failing, {
      type: 'recording/startFailed',
      botId: BOT,
      error: { code: 'NETWORK', message: 'Could not reach the server.' },
    });

    const cleared = chatReducer(failed, { type: 'recording/discarded', botId: BOT });

    expect(cleared.recordingByBot[BOT]).toBeUndefined();
  });

  it('keeps the view, with the reason, when the discard itself fails', () => {
    const starter = apply(initialChatState, stateFrame('RECORDING'));
    const compiling = chatReducer(starter, { type: 'ws/frame', frame: stateFrame('COMPILING') });

    const refused = chatReducer(compiling, {
      type: 'recording/discardFailed',
      botId: BOT,
      error: { code: 'NETWORK', message: 'Could not reach the server.' },
    });

    expect(refused.recordingByBot[BOT]).toEqual({
      kind: 'compiling',
      recordingId: REC,
      counts: { x11: 0, cdp: 0 },
      error: 'Could not discard the recording. Could not reach the server.',
    });

    // A live capture keeps counting and stays discardable — the failure is one
    // press that did not land, not a state the recording moved into.
    const live = chatReducer(starter, {
      type: 'recording/discardFailed',
      botId: BOT,
      error: { code: 'NETWORK', message: 'Could not reach the server.' },
    });
    expect(live.recordingByBot[BOT]).toMatchObject({
      kind: 'recording',
      error: 'Could not discard the recording. Could not reach the server.',
    });

    // A failed row keeps the compile's own reason; there is nothing to
    // discard but the card, and the press stays on offer.
    const failed = chatReducer(starter, { type: 'ws/frame', frame: stateFrame('FAILED') });
    const after = chatReducer(failed, {
      type: 'recording/discardFailed',
      botId: BOT,
      error: { code: 'NETWORK', message: 'Could not reach the server.' },
    });
    expect(after).toBe(failed);
  });

  it('names the draft from skill.compiled — the frame settles the compiling view', () => {
    const compiling = chatReducer(apply(initialChatState, stateFrame('RECORDING')), {
      type: 'ws/frame',
      frame: stateFrame('COMPILING'),
    });

    const named = chatReducer(compiling, {
      type: 'ws/frame',
      frame: frame('skill.compiled', { recordingId: REC, skillId: SKILL, name: 'open_chrome' }),
    });

    expect(named.recordingByBot[BOT]).toEqual({
      kind: 'ready',
      recordingId: REC,
      counts: { x11: 0, cdp: 0 },
      skillId: SKILL,
      skillName: 'open_chrome',
      warning: null,
      error: null,
    });
    // A repeat of the same frame must not cost the identity memoized
    // consumers rely on.
    const again = chatReducer(named, {
      type: 'ws/frame',
      frame: frame('skill.compiled', { recordingId: REC, skillId: SKILL, name: 'open_chrome' }),
    });
    expect(again).toBe(named);
  });

  it('a start failure lands as a readable failed view', () => {
    const starting = chatReducer(initialChatState, { type: 'recording/starting', botId: BOT });

    const failed = chatReducer(starting, {
      type: 'recording/startFailed',
      botId: BOT,
      error: { code: 'NETWORK', message: 'Could not reach the server.' },
    });

    expect(failed.recordingByBot[BOT]).toEqual({
      kind: 'failed',
      recordingId: null,
      message: 'Could not reach the server.',
    });
  });

  it('a new start replaces the previous outcome', () => {
    const ready = settled();

    const starting = chatReducer(ready, { type: 'recording/starting', botId: BOT });

    expect(starting.recordingByBot[BOT]).toEqual({ kind: 'starting' });
  });

  it('a start response adopts the id, and merges with a frame that raced it', () => {
    const starting = chatReducer(initialChatState, { type: 'recording/starting', botId: BOT });

    const started = chatReducer(starting, {
      type: 'recording/started',
      botId: BOT,
      recordingId: REC,
    });
    expect(started.recordingByBot[BOT]).toEqual({
      kind: 'recording',
      recordingId: REC,
      counts: { x11: 0, cdp: 0 },
      lastType: null,
      error: null,
    });

    // The RECORDING frame and the HTTP response race; whichever is second
    // must not reset a counter the first one started.
    const raced = chatReducer(apply(initialChatState, event({ x11: 4, cdp: 0 }, 'type')), {
      type: 'recording/started',
      botId: BOT,
      recordingId: REC,
    });
    expect(raced.recordingByBot[BOT]).toEqual({
      kind: 'recording',
      recordingId: REC,
      counts: { x11: 4, cdp: 0 },
      lastType: 'type',
      error: null,
    });
  });

  it('puts the counter back with the reason when the stop call fails', () => {
    const recording = apply(initialChatState, event({ x11: 3, cdp: 0 }, 'type'));
    const stopping = chatReducer(recording, { type: 'recording/stopping', botId: BOT });

    const reverted = chatReducer(stopping, {
      type: 'recording/stopFailed',
      botId: BOT,
      error: { code: 'NETWORK', message: 'Could not reach the server.' },
    });

    expect(reverted.recordingByBot[BOT]).toEqual({
      kind: 'recording',
      recordingId: REC,
      counts: { x11: 3, cdp: 0 },
      lastType: 'type',
      error: 'Could not stop the recording. Could not reach the server.',
    });
  });

  it('fills warning, final counts and the skill id from a status read (D-042)', () => {
    // The auto-stop path: the frame says READY, and the sentence's reason is
    // read from GET /recordings/:id because §4.2 deliberately does not carry it.
    const stopping = chatReducer(apply(initialChatState, event({ x11: 4998, cdp: 0 }, 'pointer')), {
      type: 'recording/stopping',
      botId: BOT,
    });

    const settledReady = chatReducer(stopping, {
      type: 'recording/settled',
      botId: BOT,
      status: statusBody({
        state: 'READY',
        warning: 'EVENT_LIMIT',
        counts: { x11: 5000, cdp: 0, atspi: 0 },
        skillId: SKILL,
      }),
    });

    expect(settledReady.recordingByBot[BOT]).toEqual({
      kind: 'ready',
      recordingId: REC,
      counts: { x11: 5000, cdp: 0 },
      skillId: SKILL,
      skillName: null,
      warning: 'EVENT_LIMIT',
      error: null,
    });
  });

  it('a second recording replaces the first one’s outcome', () => {
    const ready = settled();

    const second = chatReducer(ready, {
      type: 'ws/frame',
      frame: event({ x11: 1, cdp: 0 }, 'key', REC_2),
    });

    expect(second.recordingByBot[BOT]).toEqual({
      kind: 'recording',
      recordingId: REC_2,
      counts: { x11: 1, cdp: 0 },
      lastType: 'key',
      error: null,
    });
  });

  it('routes a frame that arrives without a botId by its recording id', () => {
    const started = apply(initialChatState, stateFrame('RECORDING'));

    // Built inline: the `frame` helper re-selects its BOT default for an
    // explicit `undefined`, and this test is about a frame that carries none.
    const botless = {
      id: UUID,
      type: 'recording.state',
      ts: 1_759_000_000_000,
      payload: { recordingId: REC, state: 'COMPILING' },
    } as ServerFrame;
    const compiling = chatReducer(started, { type: 'ws/frame', frame: botless });

    expect(compiling.recordingByBot[BOT]?.kind).toBe('compiling');
  });

  it('keeps the state identical when a settled read repeats what is on screen', () => {
    const ready = settled({ skillId: SKILL, warning: null, counts: { x11: 9, cdp: 0, atspi: 0 } });

    const again = chatReducer(ready, {
      type: 'recording/settled',
      botId: BOT,
      status: statusBody({ skillId: SKILL, warning: null, counts: { x11: 9, cdp: 0, atspi: 0 } }),
    });

    expect(again).toBe(ready);
  });

  it('adopts the row a save answered with, so the review reopens on the current version (M3-FE-02)', () => {
    // A save creates a NEW version row; without this the card would keep
    // pointing at the superseded script the recording originally compiled.
    const SKILL_V2 = 'clxskill000000000000002';

    const adopted = chatReducer(settled({ skillId: SKILL }), {
      type: 'recording/skillVersion',
      botId: BOT,
      skillId: SKILL_V2,
    });

    expect(adopted.recordingByBot[BOT]).toEqual({
      kind: 'ready',
      recordingId: REC,
      counts: { x11: 9, cdp: 0 },
      skillId: SKILL_V2,
      skillName: null,
      warning: null,
      error: null,
    });
    // Repeating the same id must not cost the identity memoized consumers
    // rely on.
    expect(
      chatReducer(adopted, { type: 'recording/skillVersion', botId: BOT, skillId: SKILL_V2 }),
    ).toBe(adopted);
  });

  it('ignores a version adoption when no settled draft is on screen', () => {
    // Only a ready card carries a draft id to update: a capture in flight
    // and an unknown bot must both pass through untouched.
    const recording = apply(initialChatState, event({ x11: 1, cdp: 0 }));
    const stopping = chatReducer(recording, { type: 'recording/stopping', botId: BOT });

    expect(
      chatReducer(recording, { type: 'recording/skillVersion', botId: BOT, skillId: SKILL }),
    ).toBe(recording);
    expect(
      chatReducer(stopping, { type: 'recording/skillVersion', botId: BOT, skillId: SKILL }),
    ).toBe(stopping);
    expect(
      chatReducer(initialChatState, { type: 'recording/skillVersion', botId: BOT, skillId: SKILL }),
    ).toBe(initialChatState);
  });
});

it('a screen outage says nothing about the turn it interrupts', () => {
  // Two `error` frames, one sentence each, and only one of them is news about
  // the agent: a lost display leaves the turn running, so clearing the clock
  // would tell the operator their bot had stopped working because a picture
  // went away.
  const turn = working();

  const outage = apply(
    turn,
    frame('error', { code: 'SCREEN_STREAM_LOST', message: 'Display unavailable' }),
  );
  expect(outage.errorByBot[BOT]?.code).toBe('SCREEN_STREAM_LOST');
  expect(outage.activityByBot).toBe(turn.activityByBot);

  const failure = apply(
    turn,
    frame('error', { code: 'PROVIDER_ERROR', message: 'The model is unavailable.' }),
  );
  expect(failure.activityByBot[BOT]).toBeUndefined();
});

describe('Work invalidations (D-134)', () => {
  const TASK = 'clx4m5n6o7p8q9r0s1t2u3v4';

  it('raises the revisions a task change stales, and touches nothing else', () => {
    const before = chatReducer(initialChatState, {
      type: 'bots/loaded',
      bots: [{ id: BOT, status: 'IDLE', unreadCount: 0 } as never],
    });
    const state = chatReducer(before, {
      type: 'ws/frame',
      frame: frame('task.changed', { taskId: TASK }, undefined),
    });

    expect(state.work).toEqual({ tasks: 1, projects: 1, goals: 1, deliverables: 0 });
    // A board update must not cost the identity of the slices the sidebar and
    // the rail are memoized on.
    expect(state.bots).toBe(before.bots);
    expect(state.unreadByBot).toBe(before.unreadByBot);
    expect(state.activityByBot).toBe(before.activityByBot);
  });

  it('stales cards and goals when a deliverable is filed, and everything when a project changes', () => {
    let state = chatReducer(initialChatState, {
      type: 'ws/frame',
      frame: frame('deliverable.changed', { deliverableId: TASK }, undefined),
    });
    expect(state.work).toEqual({ tasks: 1, projects: 0, goals: 1, deliverables: 1 });
    state = chatReducer(state, {
      type: 'ws/frame',
      frame: frame('project.changed', { projectId: TASK, deleted: true }, undefined),
    });
    expect(state.work).toEqual({ tasks: 2, projects: 1, goals: 2, deliverables: 2 });
    state = chatReducer(state, {
      type: 'ws/frame',
      frame: frame('goal.changed', { goalId: TASK }, undefined),
    });
    expect(state.work).toEqual({ tasks: 3, projects: 2, goals: 3, deliverables: 3 });
  });

  it('refetches every Work view after a reconnect', () => {
    const state = chatReducer(initialChatState, { type: 'work/resync' });
    expect(state.work).toEqual({ tasks: 1, projects: 1, goals: 1, deliverables: 1 });
  });
});

describe('D-157 — the plan-use notice', () => {
  const notice = { kind: 'compute', level: 80, resetsAt: '2026-11-01T00:00:00.000Z' } as const;

  it('keeps the latest notice the server sent, the newer replacing the older', () => {
    const once = apply(initialChatState, frame('usage.notice', notice, undefined));
    expect(once.usageNotice).toEqual(notice);
    const later = apply(
      once,
      frame('usage.notice', { ...notice, kind: 'model', level: 100 }, undefined),
    );
    expect(later.usageNotice).toEqual({ ...notice, kind: 'model', level: 100 });
  });

  it('forgets it when dismissed, and touches nothing else', () => {
    const shown = apply(initialChatState, frame('usage.notice', notice, undefined));
    const dismissed = chatReducer(shown, { type: 'usage/dismissed' });
    expect(dismissed).toEqual({ ...shown, usageNotice: null });
    // Nothing to dismiss is no change at all.
    expect(chatReducer(initialChatState, { type: 'usage/dismissed' })).toBe(initialChatState);
  });
});
