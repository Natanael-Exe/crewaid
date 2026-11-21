import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import type { SeatPort } from '../agent/seat-admission.js';
import { SeatControl, type SeatControlConfig, type SeatIo } from './seat-control.js';

/**
 * The one seat control per process, shared by the screen (which
 * gates input and tells viewers) and the turn (which admits the bot's seat
 * actions). A leaf module, so both can import it without a cycle: the screen
 * module already imports the bots module that owns the turn.
 */

/** The renewal interval a viewer uses (desktop `SEAT_RENEW_EVERY_MS`) plus a margin. */
const MIN_LEASE_MS = 15_000;

/**
 * Read at boot and refused at boot: a lease shorter than the viewer's
 * renewal would hand control back between two renewals, every time.
 */
export function readSeatControlConfig(env: NodeJS.ProcessEnv): SeatControlConfig {
  const config = {
    drainMs: positive(env['SEAT_CONTROL_DRAIN_MS'], 5_000, 'SEAT_CONTROL_DRAIN_MS'),
    leaseMs: positive(env['SEAT_CONTROL_LEASE_MS'], 30_000, 'SEAT_CONTROL_LEASE_MS'),
    agentWaitMs: positive(env['SEAT_CONTROL_AGENT_WAIT_MS'], 120_000, 'SEAT_CONTROL_AGENT_WAIT_MS'),
  };
  if (config.leaseMs < MIN_LEASE_MS) {
    throw new Error(
      `SEAT_CONTROL_LEASE_MS must be at least ${MIN_LEASE_MS}: viewers renew every 10 seconds`,
    );
  }
  return config;
}

function positive(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(`${name} must be a positive integer of milliseconds, got "${raw}"`);
  }
  return value;
}

@Injectable()
export class SeatControlService implements OnModuleDestroy {
  onModuleDestroy(): void {
    this.seats.dispose();
    this.io = null;
  }
  readonly seats: SeatControl;
  private io: SeatIo | null = null;

  constructor() {
    // The screen binds its I/O after construction; until it does (a process
    // with no screen module, a unit suite) there is nobody to tell and no
    // display to reach, and the state machine still answers the bot.
    this.seats = new SeatControl(
      {
        prepareHuman: (botId, leaseMs, drainMs) => {
          if (this.io?.prepareHuman === undefined)
            return Promise.reject(new Error('No replay fence is bound.'));
          return this.io.prepareHuman(botId, leaseMs, drainMs);
        },
        forward: (botId, rfb) => this.io?.forward(botId, rfb),
        broadcast: (botId, stateFor) => this.io?.broadcast(botId, stateFor),
        refuse: (socket, botId, refusal) => this.io?.refuse(socket, botId, refusal),
      },
      readSeatControlConfig(process.env),
    );
  }

  bindIo(io: SeatIo): void {
    this.io = io;
  }

  /** Observation scope, checked again after asynchronous browser work. */
  agentStateFor(botId: string): { epoch: number; mode: 'agent' | 'draining' | 'human' } {
    return this.seats.agentStateFor(botId);
  }

  /** The bot's side, for one turn's tool context. */
  portFor(botId: string): SeatPort {
    return {
      admit: (kind, signal) => this.seats.admit(botId, kind, signal),
      beginObservation: () => this.seats.beginObservation(botId),
    };
  }
}

@Module({ providers: [SeatControlService], exports: [SeatControlService] })
export class SeatControlModule {}
