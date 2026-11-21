import { Injectable } from '@nestjs/common';
import {
  exportScreenTicketPublicKey,
  generateScreenTicketKeys,
  ScreenTicketReplayGuard,
  signScreenTicket,
  verifyScreenTicket,
  type ScreenTicketKeys,
  type ScreenTicketVerdict,
} from '@crewaid/screen-stream';
import type { ScreenTicketClaims } from '@crewaid/shared';

/**
 * The key this process signs screen tickets with, and the check for the ones
 * it serves itself.
 *
 * The signing keys live in process memory. A ticket admits one viewer and
 * bounds its viewing time. Only the direct verification key leaves this
 * process, so a relay ticket cannot be redeemed by a sandbox gateway.
 */
@Injectable()
export class ScreenTicketService {
  private readonly keys: ScreenTicketKeys = generateScreenTicketKeys();
  private readonly directKeys: ScreenTicketKeys = generateScreenTicketKeys();
  private readonly replays = new ScreenTicketReplayGuard();

  /** The public half, as text, for a server that verifies somewhere else. */
  readonly publicKey: string = exportScreenTicketPublicKey(this.directKeys.publicKey);

  sign(claims: ScreenTicketClaims, host: 'direct' | 'orchestrator' = 'orchestrator'): string {
    return signScreenTicket(claims, (host === 'direct' ? this.directKeys : this.keys).privateKey);
  }

  /**
   * A ticket presented to this process's own stream route: signed here, live,
   * and not seen before.
   */
  redeem(ticket: string, now: number = Date.now()): ScreenTicketVerdict {
    const verdict = verifyScreenTicket(ticket, this.keys.publicKey, now);
    if (!verdict.ok) return verdict;
    if (!this.replays.claim(verdict.claims, now)) {
      return { ok: false, reason: 'ticket was already used' };
    }
    return verdict;
  }
}
