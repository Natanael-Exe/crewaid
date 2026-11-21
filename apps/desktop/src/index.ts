/**
 * `@crewaid/desktop` — the Electron client.
 *
 * ⚠️ PRD R1: this app contains ZERO orchestration logic. No agent loop, no
 * model calls, no Docker access, no database. It speaks HTTP and WebSocket
 * only, even in local development. If you are reaching for `dockerode`,
 * `@prisma/client`, or an AI SDK provider in here, you are in the wrong app.
 *
 * Built out in M1 (M1-FE-01 onward, owned by Nathan).
 */

export const APP_NAME = 'Crewaid';
