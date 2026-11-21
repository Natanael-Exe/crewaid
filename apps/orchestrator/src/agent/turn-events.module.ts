import { Module } from '@nestjs/common';

import { LoggingModule } from '../logging/logging.module.js';
import { TurnEventBus } from './turn-event.bus.js';

/**
 * The WebSocket fan-out, on its own.
 *
 * `TurnEventBus` is not agent-turn machinery despite living beside it: chat
 * deltas, `sandbox.state`, recording and skill frames all go through it,
 * because a client holds ONE socket and does not care which subsystem a frame
 * came from. Six modules reach it.
 *
 * It lived in `BotsModule`, which made every one of those a `BotsModule`
 * consumer — and `SandboxModule` in particular imported the whole of bots for
 * this single provider. That was the cycle: `BotsModule` could never import
 * `SandboxModule` back, so `ChatSendService` could not reach the §16
 * ensure-ready path that M5-BE-14 needs, even though the sandbox module's own
 * comment already lists "agent tools" as one of its callers.
 *
 * Extracting the bus is the fix rather than `forwardRef`: a cycle that only
 * exists because a shared thing was filed under one of its consumers is a
 * placement bug, and `forwardRef` would preserve it behind a lazy lookup.
 */
@Module({
  imports: [LoggingModule],
  providers: [TurnEventBus],
  exports: [TurnEventBus],
})
export class TurnEventsModule {}
