import { describe, expect, it } from 'vitest';
import { tool } from '../src/agent/tool-contract.js';
import { MockLanguageModelV4, simulateReadableStream } from './model-resolution-fake.js';
import type { ScriptPart as LanguageModelV4StreamPart } from './model-resolution-fake.js';
import { z } from 'zod';
import { executionTurn } from './execution-turn-fake.js';
import {
  createTurnLimitAccount,
  limitReached,
  turnLimitCopy,
  turnLimitSentence,
  wrapUpCopy,
  wrapUpDue,
  type TurnLimits,
} from '../src/agent/turn-limits.js';
import {
  DEFAULT_MAX_TURN_MS,
  DEFAULT_MAX_TURN_TOKENS,
  SPECIFIED_MAX_TURN_MS,
  SPECIFIED_MAX_TURN_TOKENS,
  readMaxTurnMs,
  readMaxTurnTokens,
} from '../src/agent/agent-loop.config.js';

/**
 * M5-BE-11 — §6/M5's loop safety limits.
 *
 * Three ceilings, one turn. The decision is a pure function over three
 * integers, so most of what needs pinning is fixtures; what needs a run is
 * the part a fixture cannot show — that the ceiling is consulted where the
 * loop actually ends, and that the ceiling the process read at boot is the
 * one the turn runs with. The loop is `TanStackExecutionBackend`'s: its
 * `onShouldContinue` consults the account after every checkpointed step and
 * its `onBeforeModel` consults it before every call, which is where the
 * runner used to hang `stopWhen`.
 */

const OFF: TurnLimits = { maxSteps: 0, maxTurnTokens: 0, maxTurnMs: 0 };

const pingTools = {
  ping: tool({
    description: 'answers pong',
    inputSchema: z.object({ n: z.number() }),
    execute: async ({ n }: { n: number }) => `pong ${n}`,
  }),
};

/** Two tools with different names, for a case that must suspend twice. */
const twoPingTools = {
  ...pingTools,
  ping2: tool({
    description: 'also answers pong',
    inputSchema: z.object({ n: z.number() }),
    execute: async ({ n }: { n: number }) => `pong ${n}`,
  }),
};

function streamOf(chunks: LanguageModelV4StreamPart[]) {
  return simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 });
}

/**
 * A model that asks for a tool on every call and never stops on its own, so
 * only a ceiling can end the turn. `inputTokensPerCall` is what the provider
 * reports as INPUT for each step, which is the number §6/M5 accumulates.
 */
function neverSatisfiedModel(
  inputTokensPerCall = 3,
  /**
   * Which tool the model asks for on call N. Constant by default. A case that
   * suspends more than once needs distinct names, because M5-BE-15 remembers
   * an approved tool for the rest of the turn and a repeated name would be
   * asked about exactly once however much budget was left.
   */
  toolNameFor: (call: number) => string = () => 'ping',
): {
  model: MockLanguageModelV4;
  calls: () => number;
} {
  let calls = 0;
  const model = new MockLanguageModelV4({
    provider: 'mock-provider',
    modelId: 'mock-model',
    doStream: async () => {
      calls += 1;
      return {
        stream: streamOf([
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: `call-${calls}`,
            toolName: toolNameFor(calls),
            input: JSON.stringify({ n: calls }),
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: { inputTokens: { total: inputTokensPerCall }, outputTokens: { total: 2 } },
          },
        ]),
      };
    },
  });
  return { model, calls: () => calls };
}

/** A clock a test drives, so a ten-minute ceiling costs no real time. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000_000;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

describe('M5-BE-11 the limit decision', () => {
  it('reports the ceiling a turn reached, with both numbers', () => {
    const limits: TurnLimits = { maxSteps: 25, maxTurnTokens: 150_000, maxTurnMs: 600_000 };

    expect(limitReached(limits, { steps: 25, tokens: 0, elapsedMs: 0 })).toEqual({
      kind: 'steps',
      limit: 25,
      observed: 25,
    });
    expect(limitReached(limits, { steps: 2, tokens: 150_001, elapsedMs: 0 })).toEqual({
      kind: 'tokens',
      limit: 150_000,
      observed: 150_001,
    });
    expect(limitReached(limits, { steps: 2, tokens: 10, elapsedMs: 600_000 })).toEqual({
      kind: 'duration',
      limit: 600_000,
      observed: 600_000,
    });
  });

  it('leaves a turn one under every ceiling alone', () => {
    const limits: TurnLimits = { maxSteps: 25, maxTurnTokens: 150_000, maxTurnMs: 600_000 };
    expect(
      limitReached(limits, { steps: 24, tokens: 149_999, elapsedMs: 599_999 }),
    ).toBeUndefined();
  });

  it('treats 0 on an axis as no ceiling there', () => {
    // The D-047 shape: the accounting runs, the refusal does not. A turn a
    // million steps and a billion tokens deep is inside a limit of 0.
    expect(
      limitReached(OFF, { steps: 1_000_000, tokens: 1_000_000_000, elapsedMs: 86_400_000 }),
    ).toBeUndefined();
  });

  it('reports the first of several ceilings crossed on one step', () => {
    const limits: TurnLimits = { maxSteps: 25, maxTurnTokens: 100, maxTurnMs: 1 };
    expect(limitReached(limits, { steps: 25, tokens: 999, elapsedMs: 999 })?.kind).toBe('steps');
    expect(
      limitReached({ ...limits, maxSteps: 0 }, { steps: 25, tokens: 999, elapsedMs: 999 })?.kind,
    ).toBe('tokens');
  });

  it('explains an actual stop without internal counters or deployment settings', () => {
    const steps = turnLimitCopy({ kind: 'steps', limit: 25, observed: 25 });
    expect(steps).toContain('paused before finishing');
    expect(steps).toContain('send a message to carry on');
    expect(steps).not.toContain('AGENT_MAX_STEPS');

    const tokens = turnLimitCopy({ kind: 'tokens', limit: 150_000, observed: 151_200 });
    expect(tokens).not.toMatch(/\d|tokens/);
    expect(tokens).not.toContain('AGENT_MAX_TURN_TOKENS');

    const duration = turnLimitCopy({ kind: 'duration', limit: 600_000, observed: 603_000 });
    expect(duration).not.toMatch(/\d/);
    expect(duration).not.toContain('AGENT_MAX_TURN_MS');
  });

  it('keeps the key, and the exclusion, in the sentence the MODEL reads', () => {
    // The model is the reader that needs the identifier: naming the ceiling is
    // what stops it re-planning from the same starting point and hitting the
    // same wall on the same step (M5-BE-19).
    expect(turnLimitSentence({ kind: 'steps', limit: 25, observed: 25 })).toContain(
      'AGENT_MAX_STEPS',
    );
    const duration = turnLimitSentence({ kind: 'duration', limit: 600_000, observed: 603_000 });
    expect(duration).toContain('AGENT_MAX_TURN_MS');
    // The exclusion is surprising enough to be worth saying out loud.
    expect(duration).toContain('waiting for an approval does not count');
  });
});

describe('M5-BE-11 the turn account', () => {
  it('accumulates across rounds, because the ceiling is the turn’s', () => {
    const account = createTurnLimitAccount({ ...OFF, maxSteps: 5 });
    account.recordRound({ steps: 3, tokens: 100 });
    expect(account.check()).toBeUndefined();
    account.recordRound({ steps: 2, tokens: 100 });
    expect(account.check()?.kind).toBe('steps');
    expect(account.tokens()).toBe(200);
  });

  it('counts the round in flight without folding it in twice', () => {
    const account = createTurnLimitAccount({ ...OFF, maxSteps: 4 });
    account.recordRound({ steps: 2, tokens: 0 });
    expect(account.check({ steps: 2, tokens: 0 })?.kind).toBe('steps');
    // The in-flight round is an argument, not a mutation: the account still
    // reports the rounds that actually settled, which is what R9's step
    // offset reads while a round is running.
    expect(account.steps()).toBe(2);
  });

  it('runs the clock only while the turn is working', () => {
    const clock = fakeClock();
    const account = createTurnLimitAccount({ ...OFF, maxTurnMs: 1000 }, clock.now);

    account.resume();
    clock.advance(400);
    account.suspend();

    // A suspended turn is waiting on a person. This is the gap M5-BE-09 left
    // open and D-051 asked this task to close deliberately rather than by
    // starting a clock nobody configured.
    clock.advance(60_000);
    expect(account.check()).toBeUndefined();
    expect(account.elapsedMs()).toBe(400);

    account.resume();
    clock.advance(600);
    expect(account.check()).toEqual({ kind: 'duration', limit: 1000, observed: 1000 });
  });

  it('never lets a backwards clock un-fire a limit', () => {
    // Date.now() is not monotonic; an NTP step mid-turn would otherwise
    // subtract from the elapsed total.
    let value = 1_000_000;
    const account = createTurnLimitAccount({ ...OFF, maxTurnMs: 100 }, () => value);
    account.resume();
    value -= 5_000;
    expect(account.elapsedMs()).toBe(0);
    account.suspend();
    expect(account.elapsedMs()).toBe(0);
  });

  it('reports the ceiling that stopped the turn, not the last one measured', () => {
    const account = createTurnLimitAccount({ maxSteps: 2, maxTurnTokens: 10, maxTurnMs: 0 });
    expect(account.stopped()).toBeUndefined();
    account.recordRound({ steps: 2, tokens: 5 });
    expect(account.check()?.kind).toBe('steps');
    account.recordRound({ steps: 5, tokens: 50 });
    account.check();
    expect(account.stopped()).toEqual({ kind: 'steps', limit: 2, observed: 2 });
  });
});

describe('AGENT_MAX_TURN_TOKENS / AGENT_MAX_TURN_MS', () => {
  it('ship off, and say what §6/M5 specifies separately', () => {
    expect(DEFAULT_MAX_TURN_TOKENS).toBe(0);
    expect(DEFAULT_MAX_TURN_MS).toBe(0);
    expect(readMaxTurnTokens(undefined)).toBe(0);
    expect(readMaxTurnTokens('')).toBe(0);
    expect(readMaxTurnMs(undefined)).toBe(0);
    expect(readMaxTurnMs('   ')).toBe(0);

    // D-047 keeps the accounting and drops the default refusal, so the number
    // the PRD names still has to exist somewhere an operator can copy.
    expect(SPECIFIED_MAX_TURN_TOKENS).toBe(150_000);
    expect(SPECIFIED_MAX_TURN_MS).toBe(600_000);
  });

  it('reads a configured ceiling, and 0 as an explicit off', () => {
    expect(readMaxTurnTokens('150000')).toBe(150_000);
    expect(readMaxTurnMs('600000')).toBe(600_000);
    expect(readMaxTurnTokens('0')).toBe(0);
    expect(readMaxTurnMs('0')).toBe(0);
  });

  it('refuses a value that would read as NaN', () => {
    for (const raw of ['-1', 'abc', '2.5', 'Infinity', '1e400']) {
      expect(() => readMaxTurnTokens(raw), raw).toThrow(/AGENT_MAX_TURN_TOKENS/);
      expect(() => readMaxTurnMs(raw), raw).toThrow(/AGENT_MAX_TURN_MS/);
    }
  });
});

describe('M5-BE-11 the ceilings in a real run', () => {
  it('stops on the step ceiling and says so', async () => {
    const { model, calls } = neverSatisfiedModel();
    const turn = executionTurn({ model, tools: pingTools });

    const output = await turn.execute({ maxSteps: 3 });

    expect(calls()).toBe(3);
    expect(output.stoppedBy).toEqual({ kind: 'steps', limit: 3, observed: 3 });
    // The engine's own reason for a loop cut short, unchanged (D-009). It is
    // why `stoppedBy` has to exist: this value cannot tell a ceiling from a
    // model that asked for a tool nobody could run.
    expect(output.finishReason).toBe('tool_calls');
    expect(output.status).toBe('completed');
  });

  it('stops on the accumulated-input-token ceiling', async () => {
    const { model, calls } = neverSatisfiedModel(100);
    const turn = executionTurn({ model, tools: pingTools });

    const output = await turn.execute({ maxSteps: 25, maxTurnTokens: 250 });

    // 100 + 100 + 100: the third step is the one that reaches 250, and the
    // ceiling is checked after it rather than before, because a step's input
    // cost is not known until the provider has counted it.
    expect(calls()).toBe(3);
    expect(output.stoppedBy).toEqual({ kind: 'tokens', limit: 250, observed: 300 });
  });

  it('measures the same tokens the turn’s usage row records', async () => {
    // Two accumulators reaching one number by different routes: the limit
    // folds each checkpointed step into its account, and the run's usage
    // accumulates each settled model call in the `onUsage` hook. If they can
    // disagree, one of them is lying about what the turn spent.
    const { model, calls } = neverSatisfiedModel(100);
    const turn = executionTurn({ model, tools: pingTools });

    const output = await turn.execute({ maxSteps: 4 });

    expect(output.stoppedBy?.kind).toBe('steps');
    expect(calls()).toBe(4);
    expect(turn.usagePersisted[0]?.inputTokens).toBe(400);
  });

  it('stops on the clock, counting only time the turn was working', async () => {
    const clock = fakeClock();
    // The clock advances where a real provider call spends time: inside the
    // call itself, which is the only work the turn is waiting on.
    let calls = 0;
    const model = new MockLanguageModelV4({
      provider: 'mock-provider',
      modelId: 'mock-model',
      doStream: async () => {
        calls += 1;
        clock.advance(200);
        return {
          stream: streamOf([
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: `call-${calls}`,
              toolName: 'ping',
              input: JSON.stringify({ n: calls }),
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } },
            },
          ]),
        };
      },
    });
    const turn = executionTurn({ model, tools: pingTools, now: clock.now });

    const output = await turn.execute({ maxSteps: 25, maxTurnMs: 500 });

    expect(output.stoppedBy).toEqual({ kind: 'duration', limit: 500, observed: 600 });
    expect(calls).toBe(3);
  });

  it('leaves a turn the model finished with no limit recorded', async () => {
    const model = new MockLanguageModelV4({
      provider: 'mock-provider',
      modelId: 'mock-model',
      doStream: async () => ({
        stream: streamOf([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'done' },
          { type: 'text-end', id: 't' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 999_999 }, outputTokens: { total: 2 } },
          },
        ]),
      }),
    });
    const turn = executionTurn({ model, tools: pingTools });

    const output = await turn.execute({ maxSteps: 25, maxTurnTokens: 10 });

    // The turn blew past a 10-token ceiling and is still not a limit stop: the
    // account is consulted after a step that produced tool results (and before
    // each model call), so a model's closing answer is never refused
    // retroactively — the finish path only RECORDS the round.
    expect(output.status).toBe('completed');
    expect(output.finishReason).toBe('stop');
    expect(output.stoppedBy).toBeUndefined();
  });
});

/**
 * The other side of a ceiling: the round that SUSPENDS. The engine turns an
 * `ask` decision into the run's approval interrupt, the answer arrives as a
 * resume, and the budget has to gate that resume — a turn with nothing left
 * has no work for whichever way the operator answers.
 */
describe('M5-BE-11 a ceiling reached on a suspending round', () => {
  function turnWithAskRule(tools: typeof pingTools | typeof twoPingTools) {
    const { model, calls } = neverSatisfiedModel(
      3,
      // A DIFFERENT tool each round where two rounds are expected. The
      // contrast — one ask at the ceiling, two with room to spare — is the
      // whole evidence that the budget check gates asking rather than
      // replacing it, and M5-BE-15 would collapse it to one either way if
      // both rounds called the same tool.
      (call) => (call === 1 ? 'ping' : 'ping2'),
    );
    const turn = executionTurn({
      model,
      tools,
      mode: 'AUTO',
      rules: [{ toolPattern: 'ping*', decision: 'ask' }],
    });
    return { turn, calls };
  }

  it('runs an approved continuation only while the budget holds', async () => {
    const { turn, calls } = turnWithAskRule(twoPingTools);

    const parked = await turn.execute({ maxSteps: 1 });
    expect(parked.status).toBe('interrupted');
    expect(await turn.pendingApprovals()).toBe(1);

    const resumed = await turn.resumeApproved();

    // The approved call ran, and then the turn ended on its ceiling: the step
    // that asked was the one step, charged when it paused, so no second model
    // call and no NEW question — a turn with no budget has nothing to run
    // whichever way the operator answers.
    expect(calls()).toBe(1);
    const thread = await turn.persistence.stores.messages.loadThread(turn.threadId);
    expect(thread.some((message) => message.role === 'tool' && message.content === 'pong 1')).toBe(
      true,
    );
    expect(resumed.status).toBe('completed');
    expect(resumed.stoppedBy).toEqual({ kind: 'steps', limit: 1, observed: 1 });
    expect(await turn.pendingApprovals()).toBe(0);
    expect(turn.askedProposals()).toBe(1);
  });

  it('still asks while the turn has budget left', async () => {
    const { turn, calls } = turnWithAskRule(twoPingTools);

    const first = await turn.execute({ maxSteps: 3 });
    expect(first.status).toBe('interrupted');
    expect(turn.askedProposals()).toBe(1);

    const second = await turn.resumeApproved();
    expect(second.status).toBe('interrupted');
    // The other side of the same branch: the check must not become a reason
    // never to ask. Same fixture, room to spare — and a second question went
    // out for the second tool.
    expect(turn.askedProposals()).toBe(2);

    // D-164 remembers an approval only for a seat's identity turn or an ASK
    // draft, so the third call asks too — and its answer runs the last step
    // the ceiling allows.
    const third = await turn.resumeApproved();
    expect(third.status).toBe('interrupted');
    expect(turn.askedProposals()).toBe(3);

    const last = await turn.resumeApproved();
    expect(last.status).toBe('completed');
    expect(last.stoppedBy?.kind).toBe('steps');
    expect(calls()).toBe(3);
    expect(turn.askedProposals()).toBe(3);
  });

  it('does not charge the wait to the turn’s clock', async () => {
    // D-051 asked M5-BE-11 to decide this rather than start a clock nobody
    // configured. An operator taking an hour over one prompt does not consume
    // the ceiling that bounds a runaway loop: the account suspends on the
    // interrupt and resumes with the run that answers it.
    const clock = fakeClock();
    const { model } = neverSatisfiedModel();
    const turn = executionTurn({
      model,
      tools: pingTools,
      now: clock.now,
      mode: 'AUTO',
      rules: [{ toolPattern: 'ping', decision: 'ask' }],
    });

    const parked = await turn.execute({ maxSteps: 5, maxTurnMs: 10_000 });
    expect(parked.status).toBe('interrupted');

    // Two hours of reading later, the answer arrives. The turn runs on, and
    // the ten-second clock — charged with the hour or not — is not what ends
    // it; the step ceiling it actually reached is.
    clock.advance(3_600_000 * 2);
    let later = await turn.resumeApproved();
    while (later.status === 'interrupted') later = await turn.resumeApproved();

    expect(later.status).toBe('completed');
    expect(later.stoppedBy?.kind).toBe('steps');
  });
});

/**
 * The last mile on the numbers: an axis the REQUEST leaves unset is read from
 * the environment, at execution, so the numbers the process boots with are the
 * numbers a turn runs with. (The half of the old section that asserted the
 * transcript's system message moved with the coordinator: announcing a limit
 * is now the run coordinator's `turnLimitCopy`/`turnContinuationCopy` write,
 * whose wording the pure cases above pin.)
 */
describe('the orchestrator runs with the limits it read at boot', () => {
  async function withEnv<T>(vars: Record<string, string>, build: () => Promise<T>): Promise<T> {
    const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
    Object.assign(process.env, vars);
    try {
      return await build();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  /** Calls a tool nobody offered, forever: only a ceiling can end this. */
  function unstoppableModel(inputTokensPerCall: number): MockLanguageModelV4 {
    let calls = 0;
    return new MockLanguageModelV4({
      provider: 'mock-provider',
      modelId: 'mock-model',
      doStream: async () => {
        calls += 1;
        return {
          stream: streamOf([
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: `call-${calls}`,
              toolName: 'nothing_registered',
              input: '{}',
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage: { inputTokens: { total: inputTokensPerCall }, outputTokens: { total: 2 } },
            },
          ]),
        };
      },
    });
  }

  it('stops on the step ceiling the environment sets, when the request does not override it', async () => {
    // Read at execution, not at construction: the env is what the run sees.
    const turn = executionTurn({ model: () => unstoppableModel(3), tools: pingTools });
    const output = await withEnv({ AGENT_MAX_STEPS: '2' }, () => turn.execute({}));

    expect(output.stoppedBy).toEqual({ kind: 'steps', limit: 2, observed: 2 });
  });

  it('stops on a token ceiling the operator configured', async () => {
    const turn = executionTurn({ model: () => unstoppableModel(100), tools: pingTools });
    const output = await withEnv({ AGENT_MAX_STEPS: '25', AGENT_MAX_TURN_TOKENS: '250' }, () =>
      turn.execute({}),
    );

    expect(output.stoppedBy).toEqual({ kind: 'tokens', limit: 250, observed: 300 });
  });

  it('runs a model that finished on its own to completion', async () => {
    const model = new MockLanguageModelV4({
      provider: 'mock-provider',
      modelId: 'mock-model',
      doStream: async () => ({
        stream: streamOf([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'done' },
          { type: 'text-end', id: 't' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } },
          },
        ]),
      }),
    });
    const turn = executionTurn({ model: () => model, tools: pingTools });
    const output = await withEnv({ AGENT_MAX_STEPS: '25' }, () => turn.execute({}));

    expect(output.status).toBe('completed');
    expect(output.stoppedBy).toBeUndefined();
  });
});

describe('the wrap-up notice', () => {
  it('is due at 80% of the step budget, and only when a budget exists', () => {
    expect(wrapUpDue(19, 25)).toBe(false);
    expect(wrapUpDue(20, 25)).toBe(true);
    expect(wrapUpDue(25, 25)).toBe(true);
    // D-047: an axis that ships off never warns either.
    expect(wrapUpDue(30, 0)).toBe(false);
  });

  it('tells the model to finish with what it has, not to stop', () => {
    const copy = wrapUpCopy(20, 25);
    expect(copy).toContain('20');
    expect(copy).toContain('25');
    expect(copy).toContain('produce the final answer or deliverable');
    expect(copy).toContain('Do not stop solely because of this notice');
  });
});
