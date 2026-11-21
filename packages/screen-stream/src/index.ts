/**
 * `@crewaid/screen-stream` — a bot's desktop, read from x11vnc and served to
 * its viewers.
 *
 * Runs in two places: the orchestrator, for computers it reaches through a
 * provider's tunnel, and inside the computer itself, where a viewer can be
 * served without the pixels crossing the orchestrator. It imports neither
 * host's framework, so the pacing and the RFB handling are written once.
 */

export * from './logger.js';
export * from './rfb-protocol.js';
export * from './rfb-upstream.js';
export * from './screen-delivery.js';
export * from './screen-quality.js';
export * from './screen-upstream.js';
export * from './screen-stream.js';
export * from './screen-stream-hub.js';
export * from './screen-ticket.js';
export * from './serve-viewer.js';
