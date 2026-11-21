import { z } from 'zod';

import { CuidSchema, EpochMsSchema } from './primitives.js';

/**
 * Seat control schemas: who may send input to a bot's seat (`agent`, `draining`,
 * or `human`) and when the bot must wait.
 */

/** `agent` drives; `draining` waits for in-flight seat actions; `human` drives. */
export const SeatControlModeSchema = z.enum(['agent', 'draining', 'human']);
export type SeatControlMode = z.infer<typeof SeatControlModeSchema>;

/**
 * Rises on every grant and every hand-back. A `renew` or `release` that names
 * an older epoch came from a holder that has since been superseded.
 */
const SeatControlEpochSchema = z.number().int().nonnegative();

/**
 * The holder relative to the socket that receives the frame. A session or
 * socket id would let one viewer address another's lease; a relation cannot.
 */
export const SeatControlHolderSchema = z.enum(['self', 'other']);
export type SeatControlHolder = z.infer<typeof SeatControlHolderSchema>;

// `screen.control` (client → server)

export const SeatControlActionSchema = z.enum(['take', 'renew', 'release']);
export type SeatControlAction = z.infer<typeof SeatControlActionSchema>;

/**
 * `renew` and `release` must name the epoch they were granted under, so a
 * late frame from a lease that already ended cannot extend or end its
 * successor. `take` has no epoch to name yet.
 */
export const ScreenControlPayloadSchema = z.discriminatedUnion('action', [
  z.object({
    botId: CuidSchema,
    action: z.literal('take'),
    epoch: SeatControlEpochSchema.optional(),
  }),
  z.object({ botId: CuidSchema, action: z.literal('renew'), epoch: SeatControlEpochSchema }),
  z.object({ botId: CuidSchema, action: z.literal('release'), epoch: SeatControlEpochSchema }),
]);
export type ScreenControlPayload = z.infer<typeof ScreenControlPayloadSchema>;

// `screen.control.state` (server → client)

/**
 * Sent to every subscriber of the seat on subscribe and on every transition.
 * Each mode carries exactly the deadline that bounds it: a drain ends by
 * `drainDeadline`, a person's control by `leaseExpiresAt`, and the bot's
 * control by nothing.
 */
export const ScreenControlStatePayloadSchema = z.discriminatedUnion('mode', [
  z.object({
    botId: CuidSchema,
    mode: z.literal('agent'),
    epoch: SeatControlEpochSchema,
    holder: z.null(),
    observationRequired: z.boolean(),
  }),
  z.object({
    botId: CuidSchema,
    mode: z.literal('draining'),
    epoch: SeatControlEpochSchema,
    holder: SeatControlHolderSchema,
    drainDeadline: EpochMsSchema,
    observationRequired: z.boolean(),
  }),
  z.object({
    botId: CuidSchema,
    mode: z.literal('human'),
    epoch: SeatControlEpochSchema,
    holder: SeatControlHolderSchema,
    leaseExpiresAt: EpochMsSchema,
    observationRequired: z.boolean(),
  }),
]);
export type ScreenControlStatePayload = z.infer<typeof ScreenControlStatePayloadSchema>;

// Refusals

/**
 * Why a seat action, an input or a control request was refused. A tool that
 * is refused returns one of these in its RESULT, worded for the model to act
 * on; a socket that is refused gets an `error` frame naming it.
 */
export const SeatControlRefusalCodeSchema = z.enum([
  'HUMAN_IN_CONTROL',
  'OBSERVATION_REQUIRED',
  'DRAIN_TIMEOUT',
  'NOT_CONTROLLER',
  'STALE_EPOCH',
  'STALE_REFERENCE',
  'IDENTITY_IN_USE',
  'SEAT_UNAVAILABLE',
]);
export type SeatControlRefusalCode = z.infer<typeof SeatControlRefusalCodeSchema>;
