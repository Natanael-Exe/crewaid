/**
 * The screen stream: a bot's desktop pixels on a socket of their own.
 *
 * Why pixels left the socket
 *
 * A desktop is megabytes a minute; chat, status and Work are bytes. On one
 * socket the two shared a fate: a viewer that fell behind on pixels had the
 * whole connection cut, and every pixel had to pass through the orchestrator
 * even where the computer can serve a viewer itself. So a viewer asks the
 * orchestrator for a GRANT, then opens the stream wherever the grant points:
 * the orchestrator's own `/ws/screen`, or — where the provider can expose the
 * computer safely — a socket served from inside the computer, so the pixels
 * never cross the orchestrator at all.
 *
 * Input does not move. Keyboard and pointer still go over WebSocket as
 * `screen.input`, because seat control, the recording tee and idle activity
 * all live on the orchestrator, and `screen.subscribe` is still what makes a
 * socket a watcher allowed to send it.
 *
 * The wire
 *
 * Server → viewer, binary: one complete RFB server message per frame, the
 * bytes x11vnc produced, after a synthetic handshake the viewer makes itself
 * (geometry from the `Sandbox` row, format `SCREEN_PIXEL_FORMAT`). No envelope:
 * a stream socket carries exactly one bot's desktop.
 *
 * Server → viewer, text: `ScreenStreamServerMessage` JSON. A `mark` follows
 * every update and asks the viewer to confirm everything before it.
 *
 * Viewer → server, text: `ScreenStreamClientMessage` JSON — the `ack` for a
 * mark, and the quality the viewer wants. A viewer never sends RFB, so a
 * stream socket cannot type into the desktop by construction.
 *
 * Marks and acks replace WebSocket ping/pong for pacing (the window). A
 * proxy between viewer and computer may answer pings itself, which would
 * measure the hop to the proxy and let the window over-send; an ack can only
 * come from the viewer.
 */

import { z } from 'zod';
import { CuidSchema } from './primitives.js';

/** The orchestrator's stream route, beside WebSocket `/ws` and outside `/api/v1`. */
export const SCREEN_STREAM_PATH = '/ws/screen';
/** Query parameter carrying the grant's ticket. */
export const SCREEN_STREAM_TICKET_PARAM = 'ticket';
/** Query parameter carrying the viewer's initial quality, 0..9. */
export const SCREEN_STREAM_QUALITY_PARAM = 'quality';

/**
 * Where a computer serves its own screens: the screen gateway in the sandbox
 * image, on loopback, reached only through the provider's authenticated
 * preview. A `direct` grant's URL names this port's preview and this path.
 */
export const SCREEN_GATEWAY_PORT = 7071;
export const SCREEN_GATEWAY_PATH = '/v1/stream';

/** The identity fields the bridge's existing seat response gives a gateway. */
export const ScreenSeatBindingSchema = z.object({
  seatId: z.string().min(1).max(64),
  botId: CuidSchema,
  rfbPort: z.number().int().min(5901).max(5916),
});
export type ScreenSeatBinding = z.infer<typeof ScreenSeatBindingSchema>;

/** Tight JPEG quality, as `screen.subscribe` carried it before it moved here. */
export const ScreenQualitySchema = z.number().int().min(0).max(9);

/**
 * Where a grant's stream is served.
 *
 * `orchestrator`: the viewer builds the URL from the orchestrator address it
 * already holds, exactly as it builds `/ws`. `direct`: served from inside the
 * computer at `url`, which may carry the provider's own access token.
 */
export const ScreenStreamEndpointSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('orchestrator') }).strict(),
  z.object({ kind: z.literal('direct'), url: z.url({ protocol: /^wss$/ }) }).strict(),
]);
export type ScreenStreamEndpoint = z.infer<typeof ScreenStreamEndpointSchema>;

/** `POST /bots/:id/screen/grant` */
export const ScreenGrantResponseSchema = z
  .object({
    endpoint: ScreenStreamEndpointSchema,
    /** Opens one stream, once, before `expiresAt`. Never a reusable credential. */
    ticket: z.string().min(1).max(4096),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type ScreenGrantResponse = z.infer<typeof ScreenGrantResponseSchema>;

/**
 * What a ticket asserts. Signed by the orchestrator; checked by whichever
 * server the grant pointed at, which may be inside the computer.
 */
export const ScreenTicketClaimsSchema = z
  .object({
    v: z.literal(1),
    aud: z.literal('crewaid-screen'),
    /** The computer's provider session, so a ticket cannot outlive the machine it named. */
    session: z.string().min(1).max(128),
    botId: CuidSchema,
    /** The seat's RFB port inside the computer. */
    port: z.number().int().min(1).max(65_535),
    /** Unix milliseconds. */
    exp: z.number().int().positive(),
    jti: z.string().min(8).max(64),
  })
  .strict();
export type ScreenTicketClaims = z.infer<typeof ScreenTicketClaimsSchema>;

/** Viewer → server text frames. */
export const ScreenStreamClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ack'), seq: z.number().int().positive() }).strict(),
  z.object({ t: z.literal('quality'), quality: ScreenQualitySchema }).strict(),
]);
export type ScreenStreamClientMessage = z.infer<typeof ScreenStreamClientMessageSchema>;

/**
 * Why a stream ended, when the server can say. `SCREEN_STREAM_LOST`: the
 * desktop stopped answering and reconnecting gave up. `SCREEN_NOT_RUNNING`:
 * the computer is stopped or stopping; reconnecting would only fail again.
 */
export const ScreenStreamErrorCodeSchema = z.enum(['SCREEN_STREAM_LOST', 'SCREEN_NOT_RUNNING']);
export type ScreenStreamErrorCode = z.infer<typeof ScreenStreamErrorCodeSchema>;

/** Server → viewer text frames. */
export const ScreenStreamServerMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('mark'), seq: z.number().int().positive() }).strict(),
  z
    .object({
      t: z.literal('error'),
      code: ScreenStreamErrorCodeSchema,
      message: z.string().min(1).max(500),
    })
    .strict(),
]);
export type ScreenStreamServerMessage = z.infer<typeof ScreenStreamServerMessageSchema>;
