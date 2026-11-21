import type { ScreenControlStatePayload } from '@crewaid/shared';
import { t } from '../i18n/i18n';

/**
 * What the full-screen view offers, read from the server's
 * `screen.control.state`. The server decides who drives; this only decides
 * which button to show and whether the viewer sends input at all. Input sent
 * without control is refused by the server whatever this says.
 */
export type SeatControlView =
  /** The bot has the seat; this window may ask for it. */
  | { readonly kind: 'available' }
  /** This window asked; the bot is finishing the step it was on. */
  | { readonly kind: 'taking'; readonly epoch: number }
  /** This window drives. Input goes through and the bot waits. */
  | { readonly kind: 'driving'; readonly epoch: number }
  /** Another window holds the seat or is taking it. */
  | { readonly kind: 'taken' };

export function seatControlView(control: ScreenControlStatePayload | undefined): SeatControlView {
  if (control === undefined || control.mode === 'agent') return { kind: 'available' };
  if (control.holder !== 'self') return { kind: 'taken' };
  return control.mode === 'human'
    ? { kind: 'driving', epoch: control.epoch }
    : { kind: 'taking', epoch: control.epoch };
}

/**
 * How often a holder renews. Fixed rather than derived from
 * `leaseExpiresAt`, which is the server's clock: a third of the default lease,
 * and short enough that a viewer's clock running fast or slow cannot let it
 * lapse by accident.
 */
export const SEAT_RENEW_EVERY_MS = 10_000;

/** The words beside the control button, for each state. */
export const SEAT_CONTROL_LABELS: Readonly<Record<SeatControlView['kind'], string>> = {
  get available() {
    return t('screen.seatControlState.botIsUsing');
  },
  get taking() {
    return t('screen.seatControlState.waitingForBot');
  },
  get driving() {
    return t('screen.seatControlState.youAreInControl');
  },
  get taken() {
    return t('screen.seatControlState.someoneElseInControl');
  },
};
