import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@heroui/react';
import {
  speakable,
  type RunSettledPayload,
  type StartCallResponse,
  type UpdateCallBody,
} from '@crewaid/shared';
import {
  ANSWER_PAUSE_MS,
  CHECK_IN_QUIET_MS,
  CallSession,
  IDLE_CALL,
  IDLE_GIVE_UP_MS,
  PROGRESS_EVERY_MS,
  QUIET_ACTIVITY_MS,
  captionOf,
  checkInLine,
  relayLine,
  type CallDeps,
  type CallEvents,
} from '../src/renderer/voice/callSession';
import { CallBar, CallButton, callOffer } from '../src/renderer/components/call/CallControls';
import type { BotCall } from '../src/renderer/voice/useBotCall';
import type { TranscriptMessage } from '../src/renderer/state/viewTypes';
import { liveBotProgress } from '../src/renderer/voice/callProgress';

const BOT = 'clxbot00000000000000001a';

const STARTED: StartCallResponse = {
  callId: 'clxcall0000000000000001a',
  signedUrl: 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=a&conversation_signature=s',
  remainingSeconds: 600,
  overrides: {
    prompt: 'You are the voice of Quill.',
    firstMessage: "Hi, it's Quill.",
    voiceId: 'voice-quill',
    maxDurationSeconds: 600,
  },
};

type Timer = { fn: () => void; due: number; every: number | null; cleared: boolean };

/** A line, a clock and a server that do what the test says, when it says. */
function harness(
  options: {
    readonly startFails?: boolean;
    readonly sendToBot?: (text: string) => Promise<string | null>;
  } = {},
) {
  const said: string[] = [];
  const context: string[] = [];
  const updates: UpdateCallBody[] = [];
  const sentToBot: string[] = [];
  const timers: Timer[] = [];
  let events: CallEvents | null = null;
  let askBot: ((request: string) => string) | null = null;
  let ended = 0;
  let activity = 0;
  let clock = 1_000;
  const schedule = (fn: () => void, ms: number, every: number | null): Timer => {
    const timer = { fn, due: clock + ms, every, cleared: false };
    timers.push(timer);
    return timer;
  };
  const clear = (handle: unknown) => {
    (handle as Timer).cleared = true;
  };
  const deps: CallDeps = {
    start: async () => {
      if (options.startFails) {
        throw Object.assign(new Error('402'), {
          failure: { code: 'PLAN_REQUIRED', message: 'Calls come with Pro.' },
        });
      }
      return STARTED;
    },
    update: async (_id, body) => {
      updates.push(body);
    },
    connect: async (input) => {
      events = input.events;
      askBot = input.askBot;
      return {
        sendUserMessage: (text) => said.push(text),
        sendContextualUpdate: (text) => context.push(text),
        sendUserActivity: () => {
          activity += 1;
        },
        setMicMuted: () => undefined,
        endSession: async () => {
          ended += 1;
        },
      };
    },
    sendToBot: async (text) => {
      sentToBot.push(text);
      if (options.sendToBot) return options.sendToBot(text);
      return `m-${sentToBot.length}`;
    },
    now: () => clock,
    setTimeoutFn: (fn, ms) => schedule(fn, ms, null),
    clearTimeoutFn: clear,
    setIntervalFn: (fn, ms) => schedule(fn, ms, ms),
    clearIntervalFn: clear,
  };
  const session = new CallSession(deps, { id: BOT, name: 'Quill' }, () => undefined);
  /** Moves the clock, firing every timer that falls due on the way. */
  const advance = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const next = timers
        .filter((t) => !t.cleared && t.due <= end)
        .sort((a, b) => a.due - b.due)[0];
      if (next === undefined) break;
      clock = next.due;
      if (next.every === null) next.cleared = true;
      else next.due += next.every;
      next.fn();
    }
    clock = end;
  };
  return {
    session,
    said,
    context,
    updates,
    sentToBot,
    timers,
    events: () => events!,
    ask: (request: string) => askBot!(request),
    ended: () => ended,
    activity: () => activity,
    advance,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function settled(
  messageIds: string[],
  outcome: RunSettledPayload['outcome'] = 'completed',
  reply: string | null = 'Done.',
): RunSettledPayload {
  return { botId: BOT, threadId: 'thread-1', runId: 'run-1', messageIds, outcome, reply };
}

async function live(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  await h.session.start();
  h.events().connected('conv_1');
  return h;
}

describe('D-222 — a call is the bot’s voice, relayed', () => {
  it('connects, reports the conversation, and arms the hang-up at the call’s budget', async () => {
    const h = harness();
    await h.session.start();
    expect(h.session.state.phase).toBe('connecting');
    h.events().connected('conv_1');
    expect(h.session.state).toMatchObject({ phase: 'live', maxDurationSeconds: 600 });
    expect(h.updates).toEqual([{ conversationId: 'conv_1' }]);
    expect(h.timers.find((t) => t.every === null)?.due).toBe(1_000 + 600_000);
  });

  it('hands a spoken request to the bot, and reads back the answer the server settles for it', async () => {
    const h = await live();
    expect(h.ask('How much disk is free?')).toBe('Sent.');
    await flush();
    expect(h.sentToBot).toEqual(['How much disk is free?']);
    expect(h.session.state.waitingOnBot).toBe(true);

    const reply = '**42 GB** free. See [the report](https://x.example/r).';
    h.session.runSettled(settled(['m-1'], 'completed', reply));
    // Rewritten for the ear on the way: no markdown reaches the voice.
    expect(h.said).toEqual([relayLine('Quill', speakable(reply))]);
    expect(h.said[0]).toContain('42 GB free. See the report.');
    expect(h.session.state.waitingOnBot).toBe(false);
    expect(h.context.at(-1)).toContain('finished "How much disk is free?"');
  });

  it('ignores runs that answered somebody else’s message', async () => {
    const h = await live();
    h.ask('Check the build');
    await flush();
    // A routine's run, or a message typed in the composer during the call.
    h.session.runSettled(settled(['someone-else'], 'completed', 'An unrelated answer.'));
    expect(h.said).toEqual([]);
    expect(h.session.state.waitingOnBot).toBe(true);
    h.session.runSettled(settled(['m-1'], 'completed', 'The build is green.'));
    expect(h.said).toEqual([relayLine('Quill', 'The build is green.')]);
  });

  it('keeps waiting for a second request after the first is answered', async () => {
    const h = await live();
    h.ask('Summarise the report');
    h.ask('And book the room');
    await flush();
    h.session.runSettled(settled(['m-1'], 'completed', 'The report says sales are up.'));
    expect(h.said).toEqual([relayLine('Quill', 'The report says sales are up.')]);
    expect(h.session.state.waitingOnBot).toBe(true);
    h.session.runSettled(settled(['m-2'], 'completed', 'The room is booked.'));
    expect(h.said.at(-1)).toBe(relayLine('Quill', 'The room is booked.'));
    expect(h.session.state.waitingOnBot).toBe(false);
  });

  it('answers every request one run folded together, once', async () => {
    const h = await live();
    h.ask('Find the invoice');
    h.ask('Also the receipt');
    await flush();
    // The newer message's run answered both: the server names each.
    h.session.runSettled(settled(['m-2', 'm-1'], 'completed', 'Both are in Downloads.'));
    expect(h.said).toEqual([relayLine('Quill', 'Both are in Downloads.')]);
    expect(h.session.state.waitingOnBot).toBe(false);
  });

  it('says how a run ended when it did not answer', async () => {
    const h = await live();
    h.ask('One');
    h.ask('Two');
    h.ask('Three');
    await flush();
    h.session.runSettled(settled(['m-1'], 'failed', 'half an answer'));
    h.session.runSettled(settled(['m-2'], 'stopped', null));
    h.session.runSettled(settled(['m-3'], 'completed', null));
    expect(h.said).toEqual([
      relayLine('Quill', 'I couldn’t finish that. The details are on screen.'),
      relayLine('Quill', 'I stopped working on that.'),
      relayLine('Quill', 'I’ve finished. The details are on screen.'),
    ]);
  });

  it('answers a request whose run settled before its send came back', async () => {
    let resolve: (id: string) => void = () => undefined;
    const h = await live({ sendToBot: () => new Promise((r) => (resolve = r)) });
    h.ask('Quick one');
    h.session.runSettled(settled(['m-early'], 'completed', 'Quick answer.'));
    expect(h.said).toEqual([]);
    resolve('m-early');
    await flush();
    expect(h.said).toEqual([relayLine('Quill', 'Quick answer.')]);
    expect(h.session.state.waitingOnBot).toBe(false);
  });

  it('stops waiting when the bot goes idle and no answer ever comes', async () => {
    const h = await live();
    h.ask('Long job');
    await flush();
    // A continuation passes through idle on its way to the next run.
    h.session.botStatusChanged('IDLE');
    h.advance(IDLE_GIVE_UP_MS / 2);
    h.session.botStatusChanged('THINKING');
    h.advance(IDLE_GIVE_UP_MS);
    expect(h.said).toEqual([]);
    // Stopped, or a worker that died: idle, and nothing settles.
    h.session.botStatusChanged('IDLE');
    h.advance(IDLE_GIVE_UP_MS);
    expect(h.said.filter((line) => line !== checkInLine('Quill'))).toEqual([
      relayLine('Quill', 'I’ve stopped working on that. The details are on screen.'),
    ]);
    expect(h.session.state.waitingOnBot).toBe(false);
  });

  it('keeps the voice from filling a quiet wait, and checks in after a long one', async () => {
    const h = await live();
    h.ask('Research flights');
    await flush();
    h.advance(QUIET_ACTIVITY_MS - 1_000);
    expect(h.activity()).toBe(0);
    h.advance(2_000);
    expect(h.activity()).toBe(1);
    // Never over the voice.
    h.events().mode(true);
    h.advance(20_000);
    const during = h.activity();
    h.events().mode(false);
    h.advance(QUIET_ACTIVITY_MS - 1_000);
    expect(h.activity()).toBe(during);
    expect(h.said).toEqual([]);
    h.advance(CHECK_IN_QUIET_MS);
    expect(h.said).toEqual([checkInLine('Quill')]);
    // One check-in per quiet stretch, not one a tick.
    h.events().mode(true);
    h.advance(3_000);
    h.events().mode(false);
    h.advance(CHECK_IN_QUIET_MS - 5_000);
    expect(h.said).toHaveLength(1);
    h.advance(10_000);
    expect(h.said).toHaveLength(2);
  });

  it('tells the voice what the bot is doing without making it speak', async () => {
    const h = await live();
    h.ask('Fix the bug');
    await flush();
    h.session.runProgress('Doing: Run command (running).');
    h.advance(1_000);
    expect(h.context.at(-1)).toBe('Work status: in progress. Doing: Run command (running).');
    // A change inside the interval waits; the same line is never repeated.
    h.session.runProgress('Doing: Edit file (running).');
    h.advance(1_000);
    expect(h.context.at(-1)).toContain('Run command');
    h.advance(PROGRESS_EVERY_MS);
    expect(h.context.at(-1)).toContain('Edit file');
    const sent = h.context.length;
    h.advance(PROGRESS_EVERY_MS * 2);
    expect(h.context).toHaveLength(sent);
    expect(h.said).toEqual([]);
  });

  it('holds an answer while the voice is talking, then reads it', async () => {
    const h = await live();
    h.ask('What’s on my calendar?');
    await flush();
    h.events().mode(true);
    h.session.runSettled(settled(['m-1'], 'completed', 'Two meetings today.'));
    expect(h.said).toEqual([]);
    h.events().mode(false);
    h.advance(ANSWER_PAUSE_MS - 100);
    expect(h.said).toEqual([]);
    h.advance(200);
    expect(h.said).toEqual([relayLine('Quill', 'Two meetings today.')]);
  });

  it('sends one request once, however often the voice asks', async () => {
    const h = await live();
    h.ask('Open the report');
    expect(h.ask('Open the report')).toBe('Already in progress.');
    await flush();
    expect(h.ask('Open the report')).toBe('Already in progress.');
    expect(h.sentToBot).toEqual(['Open the report']);
  });

  it('sends a person to the screen for an approval, and pauses check-ins until it is answered', async () => {
    const h = await live();
    h.ask('Email the team');
    await flush();
    h.session.approvalWaiting();
    expect(h.said).toEqual([
      relayLine('Quill', 'I need you to approve something on screen before I can carry on.'),
    ]);
    h.advance(CHECK_IN_QUIET_MS * 2);
    expect(h.said).toHaveLength(1);
    h.session.approvalsAnswered();
    expect(h.context.at(-1)).toContain('approval was answered');
    h.session.approvalsAnswered();
    expect(h.context.filter((line) => line.includes('approval was answered'))).toHaveLength(1);
  });

  it('asks again aloud when the request never reached the bot', async () => {
    const h = await live({ sendToBot: async () => null });
    h.ask('Open the report');
    await flush();
    expect(h.said).toEqual([relayLine('Quill', 'That didn’t reach me. Could you say it again?')]);
    expect(h.session.state.waitingOnBot).toBe(false);
  });

  it('treats a rejected send like a refused one, and relays nothing after hang-up', async () => {
    const rejected = await live({ sendToBot: () => Promise.reject(new Error('offline')) });
    rejected.ask('Open the report');
    await flush();
    expect(rejected.said).toEqual([
      relayLine('Quill', 'That didn’t reach me. Could you say it again?'),
    ]);

    const h = await live();
    h.ask('Long job');
    await flush();
    await h.session.hangUp();
    h.session.runSettled(settled(['m-1'], 'completed', 'Too late.'));
    expect(h.said).toEqual([]);
  });

  it('at its limit, lets the voice finish its sentence, then hangs up and reports it', async () => {
    const h = await live();
    h.events().mode(true);
    h.advance(600_000);
    expect(h.session.state.phase).toBe('live');
    h.advance(5_000);
    await flush();
    expect(h.ended()).toBe(1);
    expect(h.updates.at(-1)).toEqual({ ended: true });
    expect(h.session.state.phase).toBe('idle');
  });

  it('ends when the far side does, without ending the line twice', async () => {
    const h = await live();
    h.events().disconnected();
    await flush();
    expect(h.ended()).toBe(0);
    expect(h.updates.at(-1)).toEqual({ ended: true });
    await h.session.hangUp();
    expect(h.updates.filter((u) => u.ended === true)).toHaveLength(1);
  });

  it('shows the server’s reason when a call cannot start, and opens nothing', async () => {
    const h = harness({ startFails: true });
    await h.session.start();
    expect(h.session.state).toEqual({ ...IDLE_CALL, error: 'Calls come with Pro.' });
    expect(h.updates).toEqual([]);
  });
});

describe('D-222 — a caption is what was said', () => {
  it('drops the delivery tags an expressive voice performs but does not say', () => {
    expect(captionOf('I’m on it! [happy] I’ll let you know.')).toBe(
      'I’m on it! I’ll let you know.',
    );
    expect(captionOf('[thinking] Please hold on.')).toBe('Please hold on.');
    // Brackets that are words stay.
    expect(captionOf('Reply with [1] or [2].')).toBe('Reply with [1] or [2].');
  });
});

describe('D-227 — what the voice is told the bot is doing', () => {
  const message = (author: 'BOT' | 'USER', text: string): TranscriptMessage =>
    ({
      id: `m-${text}`,
      author,
      parts: [{ type: 'text', text }],
      timeLabel: '',
      createdAt: 0,
      stopReason: null,
    }) as unknown as TranscriptMessage;

  it('uses only live public narration and action status', () => {
    const current = message('BOT', 'Setting up **your support bot**.');
    current.live = true;
    current.parts.push(
      { type: 'reasoning', text: 'private reasoning must not be spoken' },
      {
        type: 'tool-activity',
        calls: [
          {
            type: 'tool-call',
            toolName: 'create_bot',
            status: 'running',
            input: { token: 'private-token' },
            output: 'private-result',
          },
        ],
      },
    );
    const progress = liveBotProgress([message('BOT', 'An older answer.'), current]);
    expect(progress).toBe(
      'Doing: Create bot (running). Latest words: Setting up your support bot.',
    );
    expect(progress).not.toMatch(/private|older/);
    expect(liveBotProgress([message('BOT', 'Old')])).toBeNull();
    expect(liveBotProgress([{ ...current, fromBotId: 'another-bot' }])).toBeNull();
  });

  it('reads only the tail of a long reply', () => {
    const current = message('BOT', `${'early words '.repeat(200)}the latest sentence.`);
    current.live = true;
    const progress = liveBotProgress([current])!;
    expect(progress.length).toBeLessThan(500);
    expect(progress).toContain('the latest sentence.');
  });
});

function call(overrides: Partial<BotCall>): BotCall {
  return {
    snapshot: IDLE_CALL,
    availability: { kind: 'available', allowance: { limitSeconds: 1800, usedSeconds: 60 } },
    start: () => undefined,
    hangUp: () => undefined,
    setMuted: () => undefined,
    dismissError: () => undefined,
    runProgress: () => undefined,
    approvalWaiting: () => undefined,
    approvalsAnswered: () => undefined,
    ...overrides,
  };
}
const render = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);

describe('D-222 — the call button and bar', () => {
  it('is absent only on a cloud server without a voice agent', () => {
    expect(
      render(
        <CallButton
          call={call({ availability: { kind: 'absent' } })}
          botName="Quill"
          edition="cloud"
          onOpenPlan={() => undefined}
        />,
      ),
    ).toBe('');
    expect(callOffer({ kind: 'absent' }, null)).toBe('none');
  });

  it('is named for the bot, and explains instead of calling where calls are not included', () => {
    const pro = render(
      <CallButton call={call({})} botName="Quill" edition="cloud" onOpenPlan={() => undefined} />,
    );
    expect(pro).toContain('aria-label="Call Quill"');
    expect(pro).toContain('>Call Quill</span>');
    expect(pro).toContain('data-call-button="idle"');
    const starter = render(
      <CallButton
        call={call({
          availability: { kind: 'available', allowance: { limitSeconds: 0, usedSeconds: 0 } },
        })}
        botName="Quill"
        edition="cloud"
        onOpenPlan={() => undefined}
      />,
    );
    // Still a call button by name; pressing it explains the plan.
    expect(starter).toContain('aria-label="Call Quill"');
    expect(starter).toContain('data-call-button="pro"');
    const selfHosted = render(
      <CallButton
        call={call({ availability: { kind: 'absent' } })}
        botName="Quill"
        edition="selfhosted"
        onOpenPlan={() => undefined}
      />,
    );
    expect(selfHosted).toBe('');
    expect(callOffer({ kind: 'absent' }, 'selfhosted')).toBe('none');
  });

  it('collapses to the icon, keeping the name as its label', () => {
    const icon = render(
      <CallButton
        call={call({})}
        botName="Quill"
        edition="cloud"
        onOpenPlan={() => undefined}
        iconOnly
      />,
    );
    expect(icon).toContain('aria-label="Call Quill"');
    expect(icon).not.toContain('>Call Quill</span>');
  });

  it('turns into hang-up during a call, and the bar shows who and what was said', () => {
    const live = call({
      snapshot: {
        ...IDLE_CALL,
        phase: 'live',
        connectedAt: null,
        caption: 'I’m on it.',
        maxDurationSeconds: 600,
      },
    });
    expect(
      render(
        <CallButton call={live} botName="Quill" edition="cloud" onOpenPlan={() => undefined} />,
      ),
    ).toContain('aria-label="Hang up"');
    const bar = render(<CallBar call={live} botName="Quill" />);
    expect(bar).toContain('On a call with Quill');
    expect(bar).toContain('I’m on it.');
    expect(bar).toContain('aria-label="Mute"');
    expect(render(<CallBar call={call({})} botName="Quill" />)).toBe('');
  });
});
