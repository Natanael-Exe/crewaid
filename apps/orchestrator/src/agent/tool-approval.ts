import type { Json } from '@crewaid/shared';

/**
 * The vocabulary a tool call's approval decision is expressed in.
 *
 * `not-applicable` runs the call; `denied` answers the model with a refusal
 * and lets the loop continue; `user-approval` stops the run until the
 * operator answers. The policy runtime decides; the TanStack
 * middleware (`tanstack-policy`) turns `user-approval` into the run's
 * approval interrupt.
 */

/** One tool call waiting on the operator. Shaped for WebSocket `approval.requested`. */
export type PendingToolApproval = {
  /** The approval's own id. NOT the tool call id — see `toolCallId`. */
  readonly approvalId: string;
  /** WebSocket keys the request and the response on this, so it is what we emit. */
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
};

/** What `approval.respond` carries back. */
export type ApprovalDecision = {
  readonly approved: boolean;
  readonly reason?: string | undefined;
  readonly editedArgs?: Json | undefined;
};

/** The three shapes a decision maps onto. */
type ToolApprovalStatus = 'not-applicable' | 'user-approval' | { type: 'denied'; reason: string };

/** The decision function a run asks before each tool call. */
export type ToolApprovalHook = (options: {
  toolCall: { toolName: string; input: unknown; toolCallId?: string };
}) => ToolApprovalStatus | Promise<ToolApprovalStatus>;

/**
 * One run's approval policy: the decision function, and the memory of what
 * the operator already said yes to.
 *
 * The two halves are one object rather than two settings because they are
 * useless apart and wrong apart. A `decide` wired without a `remember` asks
 * about the same tool on every step and looks like it works; a `remember`
 * wired without a `decide` silently records into nothing.
 */
export type TurnApprovalPolicy = {
  readonly decide: ToolApprovalHook;
  /**
   * Record an approval the operator EXPLICITLY gave. Only `approved === true`
   * belongs here: a denial and a run that ends without an answer both leave
   * the tool unrecorded, so the next call asks again.
   */
  readonly remember: (pending: PendingToolApproval) => void | Promise<void>;
};
