import { Injectable } from '@nestjs/common';

/**
 * A stored trigger, as a background caller already has it.
 *
 * The row is committed before this is handed over (a routine's prompt, a
 * teammate's delivery, a Work brief), so there is nothing to write here and
 * nothing a caller could get wrong about the thread's order. What travels is
 * the chain position, because `send_message`'s hop limits are counted from it.
 */
export type StoredTrigger = {
  readonly id: string;
  readonly content: string;
  readonly chainId: string | null;
  readonly hopCount: number;
};

/** Whatever can serve a TanStack thread. One implementation: `ChatSendService`. */
export interface TanStackTurnSource {
  /**
   * Start a run for an already-stored trigger and resolve once it settles, or
   * resolve at once when the trigger is left for the run that will answer it.
   */
  startStored(userId: string, botId: string, trigger: StoredTrigger): Promise<void>;
  /** §3.9's Stop. True when a run this worker produces was aborted in-process. */
  cancel(userId: string, botId: string): boolean;
}

/**
 * The holder background triggers hand their stored trigger to:
 * routines, a teammate's delivery, a Work start, and `bot.cancel`.
 *
 * The same shape as `TurnPlugins`, for the same reason: the producer lives in
 * `ChatDeliveryModule`, which imports `BotsModule` to assemble a turn from the
 * services that module owns. A direct injection the other way would be the
 * cycle, so the producer registers itself into a holder `BotsModule` exports.
 *
 * An unbound holder throws on a start rather than resolving: a stored trigger
 * that nothing runs would read as a message the bot ignored.
 */
@Injectable()
export class TanStackTurns {
  private source: TanStackTurnSource | undefined;

  /**
   * Bind the one source. Throws on a second call rather than replacing: two
   * producers would be two claims on one thread, and which one a turn reached
   * would depend on module initialisation order.
   */
  use(source: TanStackTurnSource): void {
    if (this.source !== undefined) {
      throw new Error('A TanStack turn source is already bound; there can be only one.');
    }
    this.source = source;
  }

  startStored(userId: string, botId: string, trigger: StoredTrigger): Promise<void> {
    if (this.source === undefined)
      return Promise.reject(new Error('No TanStack turn source is bound.'));
    return this.source.startStored(userId, botId, trigger);
  }

  cancel(userId: string, botId: string): boolean {
    return this.source?.cancel(userId, botId) ?? false;
  }
}
