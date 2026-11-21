import { describe, expect, it } from 'vitest';
import type { ToolDefinition as Tool } from '../src/agent/tool-contract.js';

import type { ToolContext } from '../src/agent/tool-registry.js';
import type { BotMessageJobData } from '../src/interbot/bot-message.queue.js';
import { effectiveTokenBudget, nextHop } from '../src/interbot/chain.js';
import { describePeers, resolvePeer, sendMessageTool } from '../src/interbot/send-message.tool.js';

/**
 * M7-BE-01 — what `send_message` does with what the model typed.
 *
 * The cases are about the two things this tool decides: WHO a name refers to,
 * and WHETHER the hop is allowed. Everything after that is the queue's job,
 * so the assertions are on what was enqueued rather than on what happened
 * next — a delivery is `bot-message-delivery` and the round trip is M7-QA-02.
 */

const SENDER = 'bot_sender';
const QUILL = { id: 'bot_quill', name: 'Quill' };
const ATLAS = { id: 'bot_atlas', name: 'Atlas' };

function harness(options: {
  peers?: { id: string; name: string }[];
  trigger?: { id: string; chainId: string | null; hopCount: number };
  enqueue?: (job: BotMessageJobData) => Promise<void>;
  /** D-047 ships these off; a case proving a limit fires configures one. */
  maxHops?: number;
  maxTokens?: number;
  spentTokens?: number;
  maxRepeatSends?: number;
  alreadySent?: number;
  /** Whether the addressed peer has already taken part in this chain. */
  peerParticipated?: boolean;
}) {
  const sent: BotMessageJobData[] = [];
  const notices: Array<{ botId: string; chainId: string; content: string }> = [];
  let budgetQueries = 0;
  const entry = sendMessageTool({
    queue: {
      enqueue: async (job) => {
        if (options.enqueue !== undefined) return options.enqueue(job);
        sent.push(job);
      },
    },
    directory: { peers: async () => options.peers ?? [QUILL, ATLAS] },
    notice: {
      post: async (botId, chainId, content) => {
        notices.push({ botId, chainId, content });
      },
    },
    budget: {
      spentTokens: async () => {
        budgetQueries += 1;
        return options.spentTokens ?? 0;
      },
      sendsBetween: async () => options.alreadySent ?? 0,
      participatedInChain: async () => options.peerParticipated ?? false,
    },
    limits: {
      maxHops: options.maxHops ?? 0,
      maxTokens: options.maxTokens ?? 0,
      maxRepeatSends: options.maxRepeatSends ?? 0,
    },
  });
  const context = {
    userId: 'usr_1',
    botId: SENDER,
    messageId: 'msg_draft',
    trigger: options.trigger ?? { id: 'msg_trigger', chainId: null, hopCount: 0 },
  } as unknown as ToolContext;
  const built = entry.build(context) as Tool & {
    execute: (input: unknown, options: unknown) => Promise<string>;
  };
  return {
    sent,
    notices,
    budgetQueries: () => budgetQueries,
    call: (input: { toBot: string; content: string }) =>
      built.execute(input, { toolCallId: 'c1', messages: [], context: undefined }),
  };
}

describe('M7-BE-01 resolving who to message', () => {
  it('takes a name, because nothing puts an id in the prompt', () => {
    expect(resolvePeer([QUILL, ATLAS], 'Quill')).toEqual({ kind: 'ok', peer: QUILL });
    // Case and stray spacing are how a model writes a name it read in prose.
    expect(resolvePeer([QUILL, ATLAS], '  quill ')).toEqual({ kind: 'ok', peer: QUILL });
  });

  it('takes an id, and an id wins over a name that looks like one', () => {
    const impostor = { id: 'bot_real', name: 'bot_quill' };
    // The name of `impostor` is the ID of `QUILL`. Matching ids first is what
    // stops a bot named after someone else's id from receiving their mail.
    expect(resolvePeer([QUILL, impostor], 'bot_quill')).toEqual({ kind: 'ok', peer: QUILL });
  });

  it('refuses rather than guesses when two bots share a name', () => {
    const twin = { id: 'bot_other', name: 'Quill' };
    const resolved = resolvePeer([QUILL, twin], 'Quill');
    expect(resolved.kind).toBe('ambiguous');
    // The ids are what the model needs to say which one it meant, so they
    // have to come back with the refusal rather than only in a log.
    expect(resolved.kind === 'ambiguous' && resolved.candidates).toEqual([QUILL, twin]);
  });

  it('takes the tag the user typed, because a mention is how a teammate is named', () => {
    // The shape this exists for: the user writes "@Quill, can you check the
    // invoice" in another bot's conversation, and the model forwarding the
    // address copies the tag it just read. Refusing "@Quill" here would tell
    // the model a teammate it can see in its own roster does not exist.
    expect(resolvePeer([QUILL, ATLAS], '@Quill')).toEqual({ kind: 'ok', peer: QUILL });
    expect(resolvePeer([QUILL, ATLAS], ' @quill ')).toEqual({ kind: 'ok', peer: QUILL });
    // Sentential punctuation rides along when a model quotes the address.
    expect(resolvePeer([QUILL, ATLAS], '@Quill,')).toEqual({ kind: 'ok', peer: QUILL });
    expect(resolvePeer([QUILL, ATLAS], '@Quill:')).toEqual({ kind: 'ok', peer: QUILL });
  });

  it('never lets the mention form shadow a peer whose name really starts with @', () => {
    // A name is still matched exactly first, so the tolerant pass is only
    // ever reached by a token that matched nothing. A bot actually named
    // "@Atlas" keeps its own mail.
    const atAtlas = { id: 'bot_at_atlas', name: '@Atlas' };
    expect(resolvePeer([ATLAS, atAtlas], '@Atlas')).toEqual({ kind: 'ok', peer: atAtlas });
  });

  it('keeps refusing an unknown tag rather than guessing at one', () => {
    // The tolerance is for the SPELLING of a name that is on the team, not a
    // reason to deliver to the nearest match.
    expect(resolvePeer([QUILL, ATLAS], '@Nobody')).toEqual({ kind: 'unknown' });
    expect(resolvePeer([QUILL, ATLAS], '@')).toEqual({ kind: 'unknown' });
  });

  it('keeps ambiguity ambiguous through the tag as well', () => {
    const twin = { id: 'bot_other', name: 'Quill' };
    const resolved = resolvePeer([QUILL, twin], '@Quill');
    expect(resolved.kind).toBe('ambiguous');
    expect(resolved.kind === 'ambiguous' && resolved.candidates).toEqual([QUILL, twin]);
  });

  it('resolves the trimmed name the prompt shows, spacing in the row or not', () => {
    // teamInstructions renders a teammate's name TRIMMED, so a row stored as
    // "Quill " must still answer to the "Quill" the model read in the roster.
    const spaced = { id: 'bot_quill', name: 'Quill ' };
    expect(resolvePeer([spaced], 'Quill')).toEqual({ kind: 'ok', peer: spaced });
    expect(resolvePeer([spaced], '@Quill')).toEqual({ kind: 'ok', peer: spaced });
  });

  it('says there is nobody rather than naming an empty list', () => {
    expect(describePeers([])).toContain('no other bots');
    expect(describePeers([QUILL, ATLAS])).toContain('Quill, Atlas');
  });
});

describe('M7-BE-01 the hop a send occupies', () => {
  it('starts a chain at the trigger that began it, on hop 1', () => {
    expect(nextHop({ id: 'msg_a', chainId: null, hopCount: 0 })).toEqual({
      chainId: 'msg_a',
      hopCount: 1,
    });
  });

  it('continues an existing chain and counts up', () => {
    expect(nextHop({ id: 'msg_b', chainId: 'chain_1', hopCount: 3 })).toEqual({
      chainId: 'chain_1',
      hopCount: 4,
    });
  });

  it('keeps two sends from one turn in the same chain', () => {
    const trigger = { id: 'msg_a', chainId: null, hopCount: 0 };
    // §6/M7's budget is "across all participants", so a fan-out has to
    // accumulate against one total rather than starting two chains at zero.
    expect(nextHop(trigger).chainId).toBe(nextHop(trigger).chainId);
  });
});

describe('M7-BE-01 sending', () => {
  it('queues the message and says so without promising a reply', async () => {
    const { call, sent } = harness({});

    const result = await call({ toBot: 'Quill', content: 'please check the invoice' });

    expect(sent).toEqual([
      {
        userId: 'usr_1',
        fromBotId: SENDER,
        toBotId: QUILL.id,
        toBotName: QUILL.name,
        content: 'please check the invoice',
        chainId: 'msg_trigger',
        hopCount: 1,
      },
    ]);
    expect(result).toContain('queued for Quill');
  });

  it('carries the chain it is already part of rather than starting a new one', async () => {
    const { call, sent } = harness({
      trigger: { id: 'msg_inbound', chainId: 'chain_7', hopCount: 2 },
    });

    await call({ toBot: 'Atlas', content: 'over to you' });

    expect(sent[0]?.chainId).toBe('chain_7');
    expect(sent[0]?.hopCount).toBe(3);
  });

  it('tells the model who it CAN message, and sends nothing', async () => {
    const { call, sent } = harness({});

    const result = await call({ toBot: 'Nobody', content: 'hello?' });

    // The list is the whole point: a model that named the wrong bot can fix
    // it on the next step instead of failing the turn (§6/M5).
    expect(result).toContain('Quill, Atlas');
    expect(sent).toEqual([]);
  });

  it('delivers to the bot the user tagged, with the tag on the address only', async () => {
    const { call, sent } = harness({});

    const result = await call({ toBot: '@Quill', content: 'check the invoice' });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.toBotId).toBe(QUILL.id);
    // The operator reading the delivery sees a name, not the tag the user
    // typed — the tag is addressing syntax, not part of who Quill is.
    expect(sent[0]?.toBotName).toBe('Quill');
    expect(result).toContain('queued for Quill');
  });

  it('stops the chain at a CONFIGURED hop limit and tells both readers why', async () => {
    const { call, sent, notices } = harness({
      maxHops: 4,
      trigger: { id: 'msg_x', chainId: 'chain_9', hopCount: 4 },
    });

    const result = await call({ toBot: 'Quill', content: 'again' });

    expect(sent).toEqual([]);
    // The model, so it does something else.
    expect(result).toContain('limit of 4');
    expect(result).toContain('nothing was sent');
    // The operator, so they can raise it. Only the SENDER here: this peer
    // has not taken part in the chain, so a note in its transcript would be
    // the first it heard of a conversation it was never in.
    expect(notices).toEqual([
      { botId: SENDER, chainId: 'chain_9', content: expect.stringContaining('CHAIN_MAX_HOPS') },
    ]);
  });

  it('tells BOTH bots when the peer is a participant in the chain', async () => {
    // §6/M7's sentence. M7-QA-03 found this missing: a chain can only reach
    // its hop limit by conversing, so the bot on the other end of that
    // conversation is exactly who the section means by "both bots".
    const { call, notices } = harness({
      maxHops: 4,
      peerParticipated: true,
      trigger: { id: 'msg_x', chainId: 'chain_9', hopCount: 4 },
    });

    await call({ toBot: 'Quill', content: 'again' });

    expect(notices.map((notice) => notice.botId)).toEqual([SENDER, QUILL.id]);
    expect(notices.every((notice) => notice.content.includes('CHAIN_MAX_HOPS'))).toBe(true);
  });

  it('explains the stop once per turn, however often the model retries', async () => {
    const { call, notices } = harness({
      maxHops: 2,
      trigger: { id: 'msg_x', chainId: 'chain_loud', hopCount: 2 },
    });

    const first = await call({ toBot: 'Quill', content: 'again' });
    const second = await call({ toBot: 'Atlas', content: 'and again' });

    // The model is told every time — that result is what makes it stop.
    expect(first).toContain('nothing was sent');
    expect(second).toContain('nothing was sent');
    // The operator reads the sentence once, not once per retry.
    expect(notices).toHaveLength(1);
  });

  it('allows the last hop under a configured limit', async () => {
    const { call, sent } = harness({
      maxHops: 4,
      trigger: { id: 'msg_x', chainId: 'chain_9', hopCount: 3 },
    });

    await call({ toBot: 'Quill', content: 'one more' });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.hopCount).toBe(4);
  });

  it('never stops a chain when no limit is configured, which is the default', async () => {
    // D-047: the accounting stays, the default stops being a refusal. The
    // reading that matters is that 0 means NO ceiling rather than "refuse
    // everything" — getting it backwards ships a product that cannot deliver
    // a single message.
    const { call, sent, notices } = harness({
      trigger: { id: 'msg_x', chainId: 'chain_long', hopCount: 999 },
    });

    await call({ toBot: 'Quill', content: 'still going' });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.hopCount).toBe(1000);
    expect(notices).toEqual([]);
  });

  it('turns a queue that refuses into a result, not a failed turn', async () => {
    const { call } = harness({
      enqueue: () => Promise.reject(new Error('REDIS_URL is not set')),
    });

    const result = await call({ toBot: 'Quill', content: 'anyone home' });

    // The operator's missing variable has to reach the model, because the
    // model is the one that has to do the work itself instead.
    expect(result).toContain('send_message failed');
    expect(result).toContain('REDIS_URL');
  });

  it('tells the sender to confirm in one sentence, because the alternative is an essay about delivery mechanics (CC-51)', () => {
    // Measured on a real conversation: the send itself worked, and what the
    // operator read was three paragraphs about queuing, whether the peer can
    // browse, and what would happen if it could not. The tool result says the
    // message is queued; the description has to say what the USER gets.
    const entry = sendMessageTool({
      queue: { enqueue: async () => undefined },
      directory: { peers: async () => [QUILL] },
      notice: { post: async () => undefined },
      budget: {
        spentTokens: async () => 0,
        sendsBetween: async () => 0,
        participatedInChain: async () => false,
      },
      limits: { maxHops: 0, maxTokens: 0, maxRepeatSends: 0 },
    });
    const built = entry.build({ userId: 'usr_1', botId: SENDER } as unknown as ToolContext);
    expect(built.description).toContain('confirm it to the user in one short sentence');
    expect(built.description).toContain('never explain queuing, delivery timing');
    // And the payload itself is told to carry the reason, which is the half
    // of a good delegation the receiving bot otherwise has to guess at.
    const shape = built.inputSchema as unknown as {
      shape: Record<string, { description?: string }>;
    };
    expect(shape.shape.content?.description).toContain('what it is for');
  });
});

describe('M7-BE-03 the chain token budget', () => {
  it('stops a chain that has spent its budget and reports what it spent', async () => {
    const { call, sent, notices } = harness({ maxTokens: 200_000, spentTokens: 200_001 });

    const result = await call({ toBot: 'Quill', content: 'keep going' });

    expect(sent).toEqual([]);
    // §6/M7's acceptance criterion: "terminates and reports ACTUAL tokens
    // spent" — the ceiling alone does not tell an operator how far past it
    // the work was.
    expect(result).toContain('200,001');
    expect(result).toContain('200,000');
    expect(notices[0]?.content).toContain('CHAIN_MAX_TOKENS');
    expect(notices[0]?.content).toContain('200,001');
  });

  it('lets a chain spend right up to its budget', async () => {
    const { call, sent } = harness({ maxTokens: 1_000, spentTokens: 999 });

    await call({ toBot: 'Quill', content: 'one more' });

    expect(sent).toHaveLength(1);
  });

  it('does not query the budget at all when none is configured', async () => {
    // The default (D-047), and the reason the query is behind the ceiling:
    // an aggregate per message is a real cost to pay for a wall nobody set.
    const { call, sent, budgetQueries } = harness({ spentTokens: 10_000_000 });

    await call({ toBot: 'Quill', content: 'unbounded' });

    expect(sent).toHaveLength(1);
    expect(budgetQueries()).toBe(0);
  });
});

describe('M7-BE-03 resolving which budget binds', () => {
  it('lets the chain bound a bot that declares nothing', () => {
    // The failure this exists to prevent: read the bot's own field and one
    // bot with no opinion is the hole the whole chain budget drains through.
    expect(effectiveTokenBudget(200_000, undefined)).toBe(200_000);
    expect(effectiveTokenBudget(200_000, 0)).toBe(200_000);
  });

  it('takes the tighter of the two when both are declared', () => {
    expect(effectiveTokenBudget(200_000, 50_000)).toBe(50_000);
    expect(effectiveTokenBudget(50_000, 200_000)).toBe(50_000);
  });

  it('is uncapped only when nobody declared anything', () => {
    expect(effectiveTokenBudget(0, undefined)).toBe(0);
    expect(effectiveTokenBudget(0, 0)).toBe(0);
    // A bot's own ceiling still binds a chain that has none.
    expect(effectiveTokenBudget(0, 25_000)).toBe(25_000);
  });
});

describe('M7-BE-04 the per-pair repeat cap', () => {
  it('refuses the message past the cap and names the peer, not the chain', async () => {
    const { call, sent, notices } = harness({ maxRepeatSends: 3, alreadySent: 3 });

    const result = await call({ toBot: 'Quill', content: 'and another thing' });

    expect(sent).toEqual([]);
    expect(result).toContain('Quill');
    expect(result).toContain('3 messages');
    // The peer is in the notice too: the chain may have hops and budget to
    // spare, and the operator needs to know WHICH conversation stopped.
    expect(notices[0]?.content).toContain('Quill');
    expect(notices[0]?.content).toContain('CHAIN_MAX_REPEAT_SENDS');
  });

  it('allows the message that reaches the cap', async () => {
    // §6/M7 is "may not send MORE THAN 3", so the third is allowed and the
    // fourth is not. Off by one here and the cap silently means two.
    const { call, sent } = harness({ maxRepeatSends: 3, alreadySent: 2 });

    await call({ toBot: 'Quill', content: 'third' });

    expect(sent).toHaveLength(1);
  });

  it('counts per peer, so a different bot is not blocked by it', async () => {
    const { call, sent } = harness({ maxRepeatSends: 1, alreadySent: 0 });

    await call({ toBot: 'Atlas', content: 'first to atlas' });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.toBotId).toBe(ATLAS.id);
  });

  it('does not apply when no cap is configured, which is the default', async () => {
    const { call, sent } = harness({ alreadySent: 99 });

    await call({ toBot: 'Quill', content: 'again and again' });

    expect(sent).toHaveLength(1);
  });
});
