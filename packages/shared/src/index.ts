/**
 * `@crewaid/shared` — the contract package.
 *
 * Zod schemas and TypeScript types for every type in PRD §3 (data model) and
 * §4 (interface contracts), shared by the orchestrator and the Electron client.
 *
 * Zero runtime dependencies other than `zod` (M0 acceptance criterion). This is
 * enforced by a lint rule in `eslint.config.mjs`, not by convention.
 */

export * from './primitives.js';
export * from './locale.js';
export * from './enums.js';
export * from './models.js';
export * from './ws.js';
export * from './rest.js';
export * from './auth.js';
export * from './agent.js';
export * from './providers.js';
export * from './screen.js';
export * from './screen-stream.js';
export * from './seat-control.js';
export * from './tool-policy.js';
export * from './native-tools.js';
export * from './work.js';

export * from './github-git.js';

// A reply rewritten to be heard, shared by the spoken reply and a call.
export * from './speakable.js';
export * from './telegram.js';

export * from './templates.js';
export * from './welcome.js';
