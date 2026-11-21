import type { Seat } from '../sandbox/seat.service.js';

/**
 * The environment a command runs in when it runs on a bot's OWN desktop.
 *
 * Why this exists at all
 *
 * The image sets `DISPLAY=:1`, and `:1` is the MACHINE's root screen —
 * the desktop xfce4-session paints at boot, which no client ever shows and no
 * operator ever looks at. Since D-060 the desktop a bot works on, the one the
 * §4.3 stream carries and the one machine-tools aim the pointer at, is its
 * SEAT (`:10`, `:11`, …). So every command that touches the desktop has to be
 * told which display it is for, and the ones that were not were quietly wrong
 * rather than broken.
 *
 * Measured, from a live session: a bot asked to screenshot its screen and
 * attach it ran `scrot ~/shared/screen.png` through `shell` and attached the
 * result — a 32 KB PNG, byte-identical to a capture of `:1`. The operator was
 * looking at the bot's seat on the same screen, with a file manager open on it,
 * and the attachment showed an empty desktop with none of that on it. The
 * per-tool built-ins (`capture_screen`, the pointer tools, recording) had
 * always passed the seat's display; `shell` — the tool the model reached for —
 * did not.
 *
 * Why the bus comes too
 *
 * A seat runs its own session bus (`seats.py::_seat_env`), and D-Bus
 * singletons bind to whichever one they meet first. A GUI process started
 * from a bot's shell against the MACHINE'S bus joins a session the seat's
 * desktop is not part of, which is the failure `seats.py` already documents
 * for `plank` — it exits 0 without a window. The address is optional because a
 * machine's image may predate the field: absent it, clear the inherited bus so a GUI singleton cannot join
 * another desktop’s session.
 */
export function seatEnv(seat: Pick<Seat, 'display' | 'dbusAddress'>): Record<string, string> {
  return {
    DISPLAY: seat.display,
    DBUS_SESSION_BUS_ADDRESS: seat.dbusAddress ?? '',
  };
}
