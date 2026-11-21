import { tool } from '../agent/tool-contract.js';
import { NativeToolInputs } from '@crewaid/shared';

import { CONTAINED_BUILTIN } from '../agent/tool-registry.js';
import type { RegisteredTool, ToolContext } from '../agent/tool-registry.js';
import type { BotMessageQueue } from './bot-message.queue.js';
import {
  effectiveTokenBudget,
  hopLimitNotice,
  isWithinHopLimit,
  isWithinRepeatCap,
  isWithinTokenBudget,
  nextHop,
  repeatCapNotice,
  tokenBudgetNotice,
} from './chain.js';
import type { ChainLimits } from './chain.config.js';

/** A bot the sender is allowed to message: the principal's, and not itself. */
export interface Peer {
  readonly id: string;
  readonly name: string;
}

/**
 * How a refusal reaches the operator watching the sending bot.
 *
 * The tool result already tells the MODEL, and M5-FE-01 renders it — but a
 * tool part is the execution log, and §6/M7 asks for a system message. The
 * person who can raise `CHAIN_MAX_HOPS` is reading the transcript, not the
 * tool parts, so the sentence naming the key goes where they are looking.
 */
export interface ChainNoticePort {
  post(botId: string, chainId: string, content: string): Promise<void>;
}

/** What one chain has already used up, in tokens and in messages. */
export interface ChainBudgetPort {
  spentTokens(userId: string, chainId: string): Promise<number>;
  sendsBetween(
    userId: string,
    chainId: string,
    fromBotId: string,
    toBotId: string,
  ): Promise<number>;
  participatedInChain(userId: string, chainId: string, botId: string): Promise<boolean>;
}

/**
 * Who this bot may message.
 *
 * A port rather than a Prisma call inside the tool, for the reason every
 * other tool has one: the tool is where the MODEL's input is interpreted, and
 * keeping the query behind a seam is what lets this file be tested without a
 * database and what keeps the R7 scoping in one auditable place.
 */
export interface PeerDirectoryPort {
  /** Every bot `userId` owns except `senderBotId`, by id and name. */
  peers(userId: string, senderBotId: string): Promise<Peer[]>;
}

/** The task context a delegated message carries. */
export interface TaskContextPort {
  ofMessage(userId: string, messageId: string): Promise<string | null>;
  owned(userId: string, taskId: string): Promise<string | null>;
}

/** How long a message may be. Tool inputs are persisted; a book is not one. */

/**
 * Resolve what the model typed into a bot it may message.
 *
 * Why a name works and not only an id
 *
 * Because the model has no way to know an id. Nothing puts a roster in the
 * prompt — the system prompt is the bot's own role, and the memory block
 * is about what it knows, not who it works with — so a tool that accepts only
 * `cm3x…` is a tool no model can call correctly on its first try. A name is
 * what the operator gave the bot and what its teammates are called in
 * conversation.
 *
 * Ids are still matched first, and exactly, so a name that happens to look
 * like an id can never shadow the real row.
 *
 * Ambiguity is a refusal, not a guess
 *
 * Two bots may share a name — nothing in §3 says otherwise. Picking either is
 * a message delivered to the wrong bot with nothing to notice it; refusing
 * and naming both ids lets the model say which it meant.
 *
 * A tag is the same name
 *
 * The user addresses a teammate the way a person does — "@Quill, can you check
 * the invoice" — and a model forwarding that address copies the tag it read.
 * A roster in the prompt (teamInstructions) makes "@Quill" legible, so the
 * resolver has to agree: without this, the model is told a teammate it can see
 * by name does not exist, and the delegation the user asked for stops there.
 *
 * The tolerance is confined to the MENTION SPELLING of a name that is already
 * on the team. A plain name is still matched exactly and then refused, because
 * the leniency is for `@`-addressing, not for delivering to the nearest match.
 * Names are compared trimmed on both sides, because the roster renders them
 * trimmed: a row stored as "Quill " must answer to the "Quill" the model read.
 */
export type PeerResolution =
  | { readonly kind: 'ok'; readonly peer: Peer }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly Peer[] };

/** How a name is spelled for comparison: plain prose, or the mention form. */
type NameKey = (value: string) => string;

const PLAIN_NAME: NameKey = (value) => value.trim().toLowerCase();

/**
 * `@Quill,` / `@Quill:` / `@Quill` — the addressing a model quotes back.
 *
 * Trailing punctuation only: `@Quill's` is left alone rather than guessed at,
 * because the apostrophe is as often part of a name as it is sentence
 * punctuation, and the exact pass above has already had its chance.
 */
const MENTION_NAME: NameKey = (value) =>
  PLAIN_NAME(value)
    .replace(/^@+/, '')
    .replace(/[.,;:!?'")\]]+$/, '')
    .trim();

function matchByName(peers: readonly Peer[], wanted: string, key: NameKey): Peer[] {
  const target = key(wanted);
  if (target === '') return [];
  return peers.filter((peer) => key(peer.name) === target);
}

export function resolvePeer(peers: readonly Peer[], toBot: string): PeerResolution {
  const byId = peers.find((peer) => peer.id === toBot);
  if (byId !== undefined) return { kind: 'ok', peer: byId };

  const byName = matchByName(peers, toBot, PLAIN_NAME);
  if (byName.length === 1) return { kind: 'ok', peer: byName[0]! };
  // Three members with one literal each, not two with a union discriminant:
  // TypeScript narrows a union by its discriminant, so `kind: 'unknown' |
  // 'ambiguous'` on one member cannot be eliminated by testing either value
  // and every later `resolved.peer` stops compiling.
  if (byName.length > 1) return { kind: 'ambiguous', candidates: byName };

  // Only a token that is ADDRESSED is re-read as a mention. A name that
  // matched nothing is still nobody, which is what keeps this from becoming a
  // guess at whoever is closest.
  if (!toBot.trim().startsWith('@')) return { kind: 'unknown' };
  const byMention = matchByName(peers, toBot, MENTION_NAME);
  if (byMention.length === 1) return { kind: 'ok', peer: byMention[0]! };
  if (byMention.length > 1) return { kind: 'ambiguous', candidates: byMention };
  return { kind: 'unknown' };
}

/** What the model is told when it named someone who is not there. */
export function describePeers(peers: readonly Peer[]): string {
  if (peers.length === 0) return 'There are no other bots to message.';
  return `Bots you can message: ${peers.map((peer) => peer.name).join(', ')}.`;
}

/**
 * `send_message` stops being a stub.
 *
 * The M5 stub registered the NAME so that a model's plan could reference it
 * and so this task would be "a body swap rather than a new registration".
 * This is that swap. It registers from here rather than from `skill-tools.ts`
 * because a tool group registers itself from wherever its dependencies
 * already live (the rule), and the queue lives in this module.
 *
 * The tool returns when the message is queued, not when it is answered
 *
 * §6/M7 puts a queue between the two bots, so the honest thing to return is
 * that it was sent. Waiting for the reply would rebuild the direct call the
 * queue exists to prevent: bot A's turn would hold its step budget, its abort
 * signal and its container open across the whole of bot B's work, and a
 * three-hop delegation would be three nested turns that one cancel unwinds.
 * The reply arrives as a message in A's own conversation, which starts A's
 * next turn — that is what makes a round trip work at all.
 *
 * The description says so explicitly, because a model that believes the reply
 * is the return value will sit and wait for it by sending again.
 */
export function sendMessageTool(deps: {
  queue: BotMessageQueue;
  directory: PeerDirectoryPort;
  notice: ChainNoticePort;
  budget: ChainBudgetPort;
  limits: ChainLimits;
  /** Absent in a harness that predates tasks: every message is then about none. */
  tasks?: TaskContextPort;
}): RegisteredTool {
  return {
    name: 'send_message',
    // D-092 settles the question §6/M7 left open — a bot no longer needs a
    // human yes per hop to hand work to a teammate. The delegation stays
    // inside this user's own team, and what bounds it is the chain budget and
    // the hop ceiling below, which are limits that hold whether or not anyone
    // is at the keyboard. An approval per hop bounded nothing extra and made
    // a team of bots slower than one bot.
    behavior: CONTAINED_BUILTIN,
    build: (context: ToolContext) => {
      /**
       * Whether this turn has already explained that the chain is over.
       *
       * Closure-local, so its lifetime is exactly one turn — which is the
       * right scope, because a model that is told to stop and calls again
       * does so within one turn's step budget. Without it, a model that
       * ignores the refusal four times puts four identical system messages
       * in the transcript and the operator reads the same sentence four
       * times instead of the one that matters. The MODEL is still told every
       * time: the result is what makes it do something else.
       */
      let announced = false;
      return tool({
        description:
          'Send a message to another bot on this team and let it work on something ' +
          'independently. The message is delivered to that bot as if the user had sent ' +
          'it, and it answers in its own conversation. This returns as soon as the ' +
          "message is queued — it does NOT return the other bot's reply. If that bot " +
          'replies to you, it arrives as a new message and you will be asked to respond ' +
          'then, so do not wait or send again. Use it to delegate, not to look something ' +
          'up you could find yourself. When it succeeds, confirm it to the user in one ' +
          'short sentence — never explain queuing, delivery timing, or what the other ' +
          'bot will do with the message; the transcript already shows the send.',
        inputSchema: NativeToolInputs.send_message,
        execute: async (input: {
          toBot: string;
          content: string;
          taskId?: string | null | undefined;
        }) => {
          try {
            const peers = await deps.directory.peers(context.userId, context.botId);
            const resolved = resolvePeer(peers, input.toBot);
            if (resolved.kind === 'unknown') {
              // A result, not a throw: the model named someone who is not
              // there, and the list is what lets it correct itself on the
              // next step rather than failing the turn.
              return `There is no bot called ${JSON.stringify(input.toBot)}. ${describePeers(peers)}`;
            }
            if (resolved.kind === 'ambiguous') {
              const ids = resolved.candidates.map((peer) => peer.id).join(', ');
              return (
                `More than one bot is called ${JSON.stringify(input.toBot)}. ` +
                `Use one of these ids instead: ${ids}.`
              );
            }

            const position = nextHop(context.trigger);
            if (!isWithinHopLimit(position, deps.limits.maxHops)) {
              // Both halves, and they are for different readers. The OPERATOR
              // gets the system message, because they are the one who can
              // raise the limit. The MODEL gets a result, because it is the
              // one that has to do something else — this chain has gone far
              // enough and the work is now its own to finish or hand back.
              //
              // Only the sender is told. The intended receiver never saw a
              // message, and a note in its transcript about one that never
              // arrived would be a claim about a conversation it did not
              // have; the delivery path, where a message WAS in flight,
              // tells both.
              if (!announced) {
                announced = true;
                const notice = hopLimitNotice(deps.limits.maxHops);
                await deps.notice.post(context.botId, position.chainId, notice);
                // "a system message posted to BOTH bots". Both, when
                // the other bot is a participant — which is the case the
                // section is describing, and the one M7-QA-03 drives. A bot
                // being addressed for the FIRST time at a hop the chain can
                // no longer afford is not a participant, and a note in its
                // transcript would be the first it heard of a conversation
                // it was never in.
                if (
                  await deps.budget.participatedInChain(
                    context.userId,
                    position.chainId,
                    resolved.peer.id,
                  )
                ) {
                  await deps.notice.post(resolved.peer.id, position.chainId, notice);
                }
              }
              return (
                `This conversation between bots has reached its limit of ` +
                `${deps.limits.maxHops} messages, so nothing was sent to ` +
                `${resolved.peer.name}. Finish the work yourself or tell the user what is ` +
                'still needed.'
              );
            }

            // The per-pair cap, before the chain-wide budget: it is the
            // cheaper query and the more specific answer, so a bot that has
            // simply been pestering ONE peer is told that rather than being
            // told the whole chain is out of money.
            if (deps.limits.maxRepeatSends > 0) {
              const already = await deps.budget.sendsBetween(
                context.userId,
                position.chainId,
                context.botId,
                resolved.peer.id,
              );
              if (!isWithinRepeatCap(already, deps.limits.maxRepeatSends)) {
                if (!announced) {
                  announced = true;
                  await deps.notice.post(
                    context.botId,
                    position.chainId,
                    repeatCapNotice(resolved.peer.name, deps.limits.maxRepeatSends),
                  );
                }
                return (
                  `You have already sent ${resolved.peer.name} ` +
                  `${deps.limits.maxRepeatSends} messages in this conversation, which is the ` +
                  'limit, so nothing was sent. Ask someone else, finish the work yourself, or ' +
                  'tell the user what is still needed.'
                );
              }
            }

            // The budget, after the hop count and before the send. Queried
            // only when a ceiling exists: D-047 ships it off, and a chain
            // with no budget must not pay for an aggregate per message.
            const budget = effectiveTokenBudget(deps.limits.maxTokens, undefined);
            if (budget > 0) {
              const spent = await deps.budget.spentTokens(context.userId, position.chainId);
              if (!isWithinTokenBudget(spent, budget)) {
                if (!announced) {
                  announced = true;
                  await deps.notice.post(
                    context.botId,
                    position.chainId,
                    tokenBudgetNotice(spent, budget),
                  );
                }
                return (
                  `This conversation between bots has spent its token budget ` +
                  `(${spent.toLocaleString('en-US')} of ${budget.toLocaleString('en-US')}), so ` +
                  `nothing was sent to ${resolved.peer.name}. Finish the work yourself or tell ` +
                  'the user what is still needed.'
                );
              }
            }

            // Omitted inherits the task this turn's work came from; null
            // clears it; a named task must be the user's. Resolved before the
            // enqueue so a foreign id sends nothing rather than a message
            // about nothing.
            let taskId: string | null;
            if (deps.tasks === undefined || input.taskId === null) {
              taskId = null;
            } else if (input.taskId === undefined) {
              taskId = await deps.tasks.ofMessage(context.userId, context.trigger.id);
            } else {
              taskId = await deps.tasks.owned(context.userId, input.taskId);
              if (taskId === null) {
                return `There is no task ${JSON.stringify(input.taskId)}, so nothing was sent.`;
              }
            }

            await deps.queue.enqueue({
              userId: context.userId,
              fromBotId: context.botId,
              toBotId: resolved.peer.id,
              // Who the sender addressed, so a delivery that finds
              // the row deleted can still name them.
              toBotName: resolved.peer.name,
              content: input.content,
              chainId: position.chainId,
              hopCount: position.hopCount,
              ...(deps.tasks !== undefined && { taskId }),
            });

            return `Message queued for ${resolved.peer.name}. It will reply in its own time.`;
          } catch (error) {
            // Including the unconfigured-queue refusal, which is the one an
            // operator without Redis will actually hit. Its sentence names
            // the missing variable.
            const detail = error instanceof Error ? error.message : String(error);
            return `send_message failed: ${detail}`;
          }
        },
      });
    },
  };
}
