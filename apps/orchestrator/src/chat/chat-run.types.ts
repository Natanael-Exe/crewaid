import type { BotStatus } from '@crewaid/shared';
import type { ExecutionResume } from '../agent/execution/execution-backend.port.js';
import type { StoredTrigger } from '../agent/tanstack-turns.js';
import type { TurnBot } from '../agent/turn-assembly.js';
import type { RunLease } from '../agent/persistence/run-lease.js';

export type AdmittedTurn =
  | { readonly kind: 'started'; readonly runId: string }
  /** A repeat of a live run: its log is joined rather than a second run started. */
  | { readonly kind: 'joined'; readonly runId: string }
  /** Stored for the run that answers it; this request has no stream of its own. */
  | { readonly kind: 'deferred' };

/** Everything one run needs about the trigger it answers. */
export type ProducedTrigger = {
  readonly triggerMessageId: string;
  readonly triggerContent: string;
  /** Chain position used to enforce inter-bot hop limits. */
  readonly chainId: string | null;
  readonly hopCount: number;
  /** Continuation instruction when carrying on from a ceiling or transient failure. */
  readonly continuation?: string;
  readonly parentRunId?: string;
  readonly resume?: readonly ExecutionResume[];
};

export type RunStarter = (lease: RunLease, bot: TurnBot, trigger: ProducedTrigger) => Promise<void>;

export type StoredTriggerStarter = (
  userId: string,
  bot: TurnBot,
  threadId: string,
  trigger: StoredTrigger & { readonly continuation?: string },
) => Promise<{ readonly settled: Promise<void> } | null>;

export type StatusWriter = (botId: string, status: BotStatus) => Promise<void>;

export type SystemMessagePoster = (botId: string, content: string) => Promise<void>;
