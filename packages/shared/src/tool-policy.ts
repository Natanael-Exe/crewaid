import { GitChangeReviewSchema } from './github-git.js';
import { z } from 'zod';

import { JsonSchema, IdentityNameSchema } from './primitives.js';

/**
 * External-effect policy (D-164, `docs/plans/MOD-SE-01-EXTERNAL-EFFECTS.md`):
 * what a tool call does outside, and what an approval of it is bound to.
 *
 * Ratified ahead of the policy service that reads them. The binding is stored
 * with a pending interrupt and read back from there when it is answered, so a
 * client never supplies it; it travels to the client only so the prompt can
 * show what is being approved.
 */

/**
 * Decided per call. `unknown` is a click or key press on someone's login, a
 * shell, or a plugin write with no adapter: it might commit, and the call
 * itself does not say. Only a commit adapter makes a call `commit`.
 */
export const ToolEffectSchema = z.enum(['read', 'draft', 'commit', 'unknown']);
export type ToolEffect = z.infer<typeof ToolEffectSchema>;

/**
 * `call` covers the one call it was given for. `identity-turn` is the identity
 * window: seat actions on one login and browser generation for the rest of a
 * turn, because a click on a login cannot be classified any finer.
 */
export const ApprovalScopeSchema = z.enum(['call', 'identity-turn']);
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

/** Lowercase hex sha256: the arguments, the grants and the content are pinned by hash. */
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * What an approval covers. Recomputed immediately before dispatch from the
 * call about to run; any field that differs makes the approval stale.
 */
export const ApprovalBindingSchema = z
  .object({
    /** The tool that will run, behind the plugin door, never the door itself. */
    toolName: z.string().min(1).max(128),
    effect: ToolEffectSchema,
    scope: ApprovalScopeSchema,
    /** sha256 of the final arguments, serialised by RFC 8785 (JCS). */
    argsHash: Sha256HexSchema,
    /** sha256 over the bot's identity grants, plugin grants and credential revisions. */
    grantRevision: Sha256HexSchema,
    /** The resolved skill version or plugin definition, independently of the model's arguments. */
    resourceRevision: Sha256HexSchema.nullable(),
    /** Present for a seat action: the login (null on a private seat) and browser generation. */
    seat: z
      .object({
        identity: IdentityNameSchema.nullable(),
        browserGeneration: z.number().int().nonnegative(),
      })
      .nullable(),
    /** Present exactly when a commit adapter classified the call. */
    commit: z
      .object({
        account: z.string().min(1).max(320),
        /** Normalised, deduplicated and sorted, so the same recipients hash the same. */
        destinations: z.array(z.string().min(1).max(2048)).min(1).max(500),
        contentRevision: Sha256HexSchema,
        review: GitChangeReviewSchema.optional(),
      })
      .nullable(),
  })
  .refine((b) => (b.effect === 'commit') === (b.commit !== null), {
    message: 'a commit binding is present exactly when the effect is commit',
    path: ['commit'],
  })
  .refine(
    (b) =>
      b.scope === 'call' || (b.effect === 'unknown' && b.seat !== null && b.seat.identity !== null),
    {
      message: 'the identity window covers unknown seat actions on a named login only',
      path: ['scope'],
    },
  );
export type ApprovalBinding = z.infer<typeof ApprovalBindingSchema>;

/**
 * Why the dispatch re-check skipped a call the policy had allowed or a person
 * had approved. Returned in the tool result, worded for the model.
 */
export const ToolPolicyRefusalCodeSchema = z.enum(['APPROVAL_STALE', 'GRANT_REVOKED']);
export type ToolPolicyRefusalCode = z.infer<typeof ToolPolicyRefusalCodeSchema>;

/** The server's proposal payload; model-call IDs and durable proposal IDs differ. */
export const ToolApprovalRequestSchema = z
  .object({
    proposalId: z.string().min(1).max(128),
    toolCallId: z.string().min(1).max(128),
    botId: z.string().min(1).max(64),
    runId: z.string().min(1).max(128),
    definitionName: z.string().min(1).max(64),
    toolName: z.string().min(1).max(128),
    args: JsonSchema,
    binding: ApprovalBindingSchema,
  })
  .strict();
export type ToolApprovalRequest = z.infer<typeof ToolApprovalRequestSchema>;

/** No client-supplied grants, binding, tool definitions or execution properties. */
export const ToolApprovalAnswerSchema = z
  .object({
    approved: z.boolean(),
    reason: z.string().max(4000).optional(),
    editedArgs: JsonSchema.optional(),
  })
  .strict();
export type ToolApprovalAnswer = z.infer<typeof ToolApprovalAnswerSchema>;
