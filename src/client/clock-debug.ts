/**
 * A field instrument for the clock: the server's raw numbers beside the screen's.
 *
 * Exists because of O-31. In the owner's first outdoor games the host's clock
 * appeared to "round up to a whole number of minutes", and nobody could see why
 * from a report. One cause was found and fixed (a predicted place showed the
 * mover the balance their turn began with), but a report from a field is only
 * ever settled by numbers from a field — so this lets the next game show them.
 *
 * **Off by default, and free when on.** It reads only what the last snapshot
 * already carried and never sends anything: inbound WebSocket messages are
 * billed, and a debug view that asked the server the time would spend one per
 * repaint. Tapping either clock switches it on or off; the choice is kept on
 * the phone so it survives a reload and the next game.
 *
 * The numbers are the *server's* (the undecorated connection, not the
 * optimistic view), because the question it answers is "does the screen agree
 * with the server?", and a prediction is by construction the screen's own idea.
 */

import { estimateServerNow } from './clock.js';
import type { NetState } from './net.js';

/** The `localStorage` key. Words only; nothing here is secret. */
export const CLOCK_DEBUG_KEY = 'satchess.clockDebug';

/** The slice of `Storage` this needs, so a test need not have one. */
export type FlagStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Whether the readout is switched on. A storage that throws reads as off. */
export function readClockDebug(storage: FlagStorage | null): boolean {
  try {
    return storage?.getItem(CLOCK_DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remember the choice, where the phone lets us. Returns what is now in force. */
export function writeClockDebug(storage: FlagStorage | null, on: boolean): boolean {
  try {
    if (on) storage?.setItem(CLOCK_DEBUG_KEY, '1');
    else storage?.removeItem(CLOCK_DEBUG_KEY);
  } catch {
    // Private mode or a full store: it still toggles for this screen.
  }
  return on;
}

/** What the screen is showing, to print beside the server's numbers. */
export interface ShownClock {
  mine: string;
  theirs: string;
}

/**
 * The readout's text: raw server clock, the timebase, and what is on screen.
 *
 * `offset` is the server's clock minus this phone's at the moment the snapshot
 * arrived (latency included). It is shown, not used: the clock never applies an
 * offset, it adds locally measured elapsed time to `serverNow`
 * ({@link estimateServerNow}). A large offset is therefore harmless, and a
 * *changing* one between snapshots is the thing worth noticing.
 */
export function clockDebugText(
  server: Pick<NetState, 'game' | 'gameAt'>,
  shown: ShownClock,
  localNow: number,
): string {
  const game = server.game;
  if (!game || server.gameAt === null) return 'server: no snapshot yet';
  const c = game.clock;
  const age = localNow - server.gameAt;
  const offset = game.serverNow - server.gameAt;
  const sign = (n: number) => (n >= 0 ? `+${n}` : String(n));
  return [
    `server w ${c.whiteMs} b ${c.blackMs} inc ${c.incrementMs}`,
    `turn ${c.active} · ${c.startedAt === null ? 'stopped' : `started ${c.startedAt}`} · ${game.status}`,
    `serverNow ${game.serverNow} · offset ${sign(offset)} ms · age ${age} ms`,
    `est. server now ${estimateServerNow(game, server.gameAt, localNow)} · rev ${game.rev}`,
    `shown you(${game.you}) ${shown.mine} · them ${shown.theirs}`,
  ].join('\n');
}
