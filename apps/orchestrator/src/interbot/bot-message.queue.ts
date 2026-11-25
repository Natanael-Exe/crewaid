import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import { queueRedisUrl, readWorkerEnabled } from '../common/queue-config.js';

/**
 * "Delivery goes through a BullMQ queue, never a direct call."
 *
 * Why a queue at all, when a function call would work
 *
 * Because the sender is inside a turn and the receiver starts one. A direct
 * call would run bot B's whole turn — model calls, tools, a container waking
 * up — on bot A's stack, inside A's abort signal and A's step budget, and a
 * deep enough delegation would be a stack of turns that a single cancel
 * unwinds. The queue is what makes each hop its own unit of work with its own
 * lifetime, and it is what lets M7-BE-05 drop a hop whose bot is gone without
 * unwinding anything.
 *
 * THE PORT IS THE SAME SHAPE `SkillCompileQueue` USES, FOR THE SAME REASON ─
 *
 * The `send_message` tool needs to say "deliver this", and nothing more.
 * Injecting a `Queue` into the tool would put bullmq's types on the agent's
 * tool surface and leave "no Redis configured" with nowhere to live —
 * `UNCONFIGURED_QUEUE` below is what turns that into a tool RESULT the model
 * can act on rather than a boot failure or a silent drop.
 */
export interface BotMessageQueue {
  /** Deliver `job` to its receiving bot. Rejects if it cannot be queued. */
  readonly enqueue: (job: BotMessageJobData) => Promise<void>;
}

/**
 * One delivery.
 *
 * Every field is carried rather than looked up later, with one exception, and
 * the split is deliberate. IDENTITY is carried because the job outlives the
 * turn that created it: `content` must be what the sender actually said, not
 * whatever a row says by the time a worker gets to it. AUTHORITY is not
 * carried — the delivery re-resolves both bots against `userId` when it runs,
 * because a bot may have been deleted in between and a job is not
 * a capability.
 */
export interface BotMessageJobData {
  /** The principal both bots must belong to. Re-checked at delivery. */
  readonly userId: string;
  /** The bot whose turn called `send_message`. */
  readonly fromBotId: string;
  /** The bot being messaged. */
  readonly toBotId: string;
  /**
   * What that bot was called when the message was sent.
   *
   * Carried rather than looked up, because the case that needs it is the
   * case where the lookup returns nothing: a bot deleted between send and
   * delivery has no row left to read a name from, and "the bot you messaged
   * is gone" is a worse sentence than naming it. A snapshot is also the
   * honest thing here — it is who the sender addressed, which a later rename
   * would not change.
   */
  readonly toBotName: string;
  /** What the sender said, verbatim. */
  readonly content: string;
  /** The chain this exchange belongs to. */
  readonly chainId: string;
  /** This delivery's hop, already incremented from the sending trigger. */
  readonly hopCount: number;
  /**
   * The task this message is about, owner-checked when it was sent and
   * again at delivery. Optional so a job queued before tasks existed still
   * delivers, as a message about no task.
   */
  readonly taskId?: string | null;
  /**
   * False for durable FYI notices: persist into recipient context without
   * starting a turn or triggering deferred-message recovery. Defaults to true.
   */
  readonly expectReply?: boolean;
  /**
   * Deterministic delivery idempotency key so BullMQ retries never create
   * duplicate messages or double-trigger a turn.
   */
  readonly deliveryKey?: string;
  /**
   * Set for bounded wrap-up orchestration hops so `WRAPPING_UP` chains permit
   * the single closeout prompt per owner while blocking new delegation hops.
   */
  readonly wrapUpKind?: 'request';
}

export const BOT_MESSAGE_QUEUE = 'BOT_MESSAGE_QUEUE';

/**
 * How many times a delivery that THREW is tried again.
 *
 * A refusal is not a throw: a hop over the ceiling, a spent budget and a
 * deleted bot all return from `deliver` as outcomes and never reach the retry
 * path, so this number bounds nothing the chain decided. What throws is the
 * machinery — a database away for a second, a worker restarted mid-job — and
 * `attempts: 1` made every one of those a message that vanished with a log
 * line as its only trace, on a sender that still believed it had delegated
 * the work. Three tries over half a second buys back the blip; what survives
 * all three is told to the sender by the processor's failure handler, which
 * is the receipt this count exists to make honest.
 */
export const DELIVERY_ATTEMPTS = 3;

/**
 * The job name, and so the Redis key prefix and the worker's contract.
 *
 * §6/M7 does not name it — unlike the `skill.compile`, which is written
 * down. It is named for the thing it delivers rather than for the tool that
 * asks, because M8's routines will enqueue against the same receiving path
 * and "the message send job" would then be a lie about half its callers.
 */
export const BOT_MESSAGE_JOB = 'bot.message';

/**
 * What a deployment without Redis gets.
 *
 * It REFUSES rather than silently dropping, and the refusal is phrased for
 * the model, because that is who reads it: the tool turns a rejection into a
 * tool result (§6/M5 — "a denial returns a tool result the model can react
 * to, not an exception"), so a bot on an install with no queue is told its
 * message went nowhere and can do the work itself or tell the operator. The
 * alternative — resolving as if sent — has the model believe it delegated
 * work that nobody received, which is the exact failure the M5 stub's
 * explicit refusal was written to avoid.
 *
 * Not a boot-time throw, for the reason `UNCONFIGURED_QUEUE` in
 * `skill-compile.queue.ts` is not one: everything else in the product works
 * without Redis.
 */
export const UNCONFIGURED_QUEUE: BotMessageQueue = {
  enqueue: () =>
    Promise.reject(
      new Error(
        'bot-to-bot delivery needs a job queue, and REDIS_URL is not set ' +
          '(see infra/compose/.env.example)',
      ),
    ),
};

/** The real queue, over the `Queue` `BullModule.registerQueue` provides. */
@Injectable()
export class BullBotMessageQueue implements BotMessageQueue {
  // `InjectQueue` resolves by an explicit token, which is what makes it work
  // under vitest/esbuild — no design:paramtypes is emitted there, so a
  // type-based injection would silently resolve to undefined.
  constructor(@InjectQueue(BOT_MESSAGE_JOB) private readonly queue: Queue) {}

  enqueue = async (job: BotMessageJobData): Promise<void> => {
    // NO `jobId`, deliberately — and this is the one place where copying
    // `skill-compile.queue.ts` would be wrong. There, the recording id is the
    // job id so that two stops cannot compile twice; here there is no natural
    // id that is safe to dedupe on. Two identical messages from one bot to
    // another are a legitimate thing to send ("still there?"), and keying a
    // job on their content would silently swallow the second.
    // `removeOnComplete`/`removeOnFail` still matter for the same reason they
    // do there: BullMQ keeps a finished job's hash by default, and nothing
    // evicts it. Without both, Redis grows by one hash per message ever sent.
    await this.queue.add(BOT_MESSAGE_JOB, job, {
      removeOnComplete: true,
      removeOnFail: true,
      // Retries are for the machinery, not for refusals — see DELIVERY_ATTEMPTS.
      attempts: DELIVERY_ATTEMPTS,
      backoff: { type: 'fixed', delay: 250 },
    });
  };
}

/**
 * `BOT_MESSAGE_WORKER` / `REDIS_URL` — what this process does with the
 * delivery queue.
 *
 * A separate key from `SKILL_COMPILE_WORKER` rather than one shared switch,
 * because the two are different jobs with different costs: a compile is a
 * model call over a long trace, a delivery starts another bot's turn, and a
 * deployment that wants one worker and not the other has no way to say so
 * with a single key. The suites need them independent for the same reason
 * they need either — `vitest.config.mts` turns both off.
 */
export function describeDeliveryConfig(env: NodeJS.ProcessEnv = process.env): {
  redisUrl: string | null;
  workerEnabled: boolean;
} {
  return {
    redisUrl: queueRedisUrl(env['REDIS_URL']),
    workerEnabled: readWorkerEnabled('BOT_MESSAGE_WORKER', env['BOT_MESSAGE_WORKER']),
  };
}
