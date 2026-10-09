/**
 * Watching a game live (stage 10.14, decision 0055): the model half, for both
 * ends of the link.
 *
 * - **The players' side**: what the game screen offers — "Let people watch",
 *   the ask, the agreement, the link — read from the snapshot's `watch`.
 * - **The watcher's side**: the words a watcher's page shows, from the
 *   watcher's view (`shared/watch.ts`), which holds squares and never a
 *   coordinate.
 *
 * Data in, words out, tested in node. The rules are the server's; this only
 * says them.
 */

import { type ClockState, formatClock, snapshot as clockSnapshot } from '../shared/clock.js';
import type { GameSnapshot } from '../shared/protocol.js';
import type { Color } from '../shared/squares.js';
import { type Units, boardWords, lengthWords, walkedWords } from '../shared/units.js';
import { WATCH_CLOSE, type WatchSnapshot } from '../shared/watch.js';
import { estimateServerNow } from './clock.js';
import type { SharePayload } from './share.js';
import { reasonWords } from './views/games.js';

// ---------------------------------------------------------------------------
// The players' side
// ---------------------------------------------------------------------------

export type WatchPhase =
  /** Nobody has asked. */
  | 'off'
  /** I asked, and wait on my opponent. */
  | 'asked'
  /** My opponent asked, and waits on me. */
  | 'invited'
  /** Both agreed: the link is live. */
  | 'on';

/** Where watching stands for this phone, or null when it cannot be offered at all. */
export function watchPhase(game: Pick<GameSnapshot, 'status' | 'you' | 'watch'> | null): WatchPhase | null {
  if (!game || !game.watch) return null;
  // Both seats taken and not over: the same statuses the server allows.
  if (game.status !== 'staging' && game.status !== 'active' && game.status !== 'suspended') return null;
  if (game.watch.on) return 'on';
  if (game.watch.offeredBy === game.you) return 'asked';
  if (game.watch.offeredBy !== null) return 'invited';
  return 'off';
}

/** The board's own button: small, and out of the way of play. */
export function watchButtonLabel(phase: WatchPhase | null): string | null {
  if (phase === null) return null;
  return phase === 'off' ? 'Let people watch' : 'Watching…';
}

/**
 * The line under the prompt while it matters: while the link is live, so both
 * players always know they are being watched, and while an ask is open.
 */
export function watchLine(phase: WatchPhase | null): string | null {
  switch (phase) {
    case 'on':
      return 'Watching is on: anyone with the link can follow the board live.';
    case 'asked':
      return 'Waiting for your opponent to agree to people watching.';
    default:
      return null;
  }
}

/** The opponent's ask, as a banner. */
export const WATCH_INVITE_TEXT =
  'Your opponent wants to let people watch this game live on a link: the board, ' +
  'the moves, the clocks and both of you as dots. No map, and nothing that says where you are.';

/** The panel behind the button: a title, a body, and which buttons it shows. */
export interface WatchPanel {
  title: string;
  body: string;
  /** "Ask my opponent" / "Agree": sends `on`. */
  agree: string | null;
  /** "Cancel the request" / "No thanks" / "Turn watching off": sends `off`. */
  stop: string | null;
  /** The share sheet, the copy and the QR: only while live. */
  share: boolean;
}

export function watchPanel(phase: WatchPhase): WatchPanel {
  switch (phase) {
    case 'off':
      return {
        title: 'Let people watch?',
        body:
          'Family indoors can follow this game live on a link: the board, the moves, the clocks, ' +
          'and both of you as dots on the board. No map, and nothing that says where the field is. ' +
          'Your opponent has to agree first, and either of you can turn it off at any time.',
        agree: 'Ask my opponent',
        stop: null,
        share: false,
      };
    case 'asked':
      return {
        title: 'Waiting for your opponent',
        body: 'They see your request on their board. Watching starts once they agree.',
        agree: null,
        stop: 'Cancel the request',
        share: false,
      };
    case 'invited':
      return {
        title: 'Let people watch?',
        body: WATCH_INVITE_TEXT,
        agree: 'Agree',
        stop: 'No thanks',
        share: false,
      };
    case 'on':
      return {
        title: 'Watching is on — share this link',
        body:
          'Anyone you send it to can watch without signing in. Turning it off ends the link ' +
          'for everyone at once, and it ends by itself when the game does.',
        agree: null,
        stop: 'Turn watching off',
        share: true,
      };
  }
}

/** The link on a phone's screen and in the share sheet, from the path in the snapshot. */
export function watchUrl(origin: string, link: string): string {
  return `${origin}${link}`;
}

export function watchShareData(url: string): SharePayload {
  return {
    title: 'Watch our game of Satellite Chess',
    text: 'We are playing chess on a real field. Watch it live here:',
    url,
  };
}

// ---------------------------------------------------------------------------
// The watcher's side
// ---------------------------------------------------------------------------

export function colorWords(color: Color): string {
  return color === 'w' ? 'White' : 'Black';
}

const PIECE_NAMES: Record<string, string> = {
  k: 'king',
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight',
  p: 'pawn',
};

/** "a queen", "a knight" — what is in somebody's hand. */
export function pieceWords(piece: string): string {
  return `a ${PIECE_NAMES[piece.toLowerCase()] ?? 'piece'}`;
}

/** The headline under the board: whose move, who is carrying, or how it ended. */
export function watchHeadline(view: WatchSnapshot): string {
  if (view.status === 'aborted') return 'The players aborted the game. No result.';
  if (view.result) {
    const { outcome, reason } = view.result;
    const who = outcome === '1-0' ? 'White won' : outcome === '0-1' ? 'Black won' : 'Drawn';
    return `Game over: ${who} — ${reasonWords(reason)}.`;
  }
  if (view.status === 'staging') return 'Waiting for both players to walk to their own back rank.';
  if (view.status === 'suspended') {
    const by = view.suspension?.by ?? null;
    const away = by === null ? 'The game is paused.' : `${colorWords(by)} stopped the game.`;
    return `${away} It resumes when both players are back on their own back rank.`;
  }
  if (view.carry) {
    return `${colorWords(view.carry.color)} is carrying ${pieceWords(view.carry.piece)} from ${view.carry.from}.`;
  }
  return `${colorWords(view.clock.active)} to move.`;
}

/** "Last move: Qh4# — carried 41 m", in the watcher's units. */
export function lastMoveWords(view: WatchSnapshot, units: Units): string | null {
  const last = view.lastMove;
  if (last === null) return null;
  return `Last move: ${last.san} by ${colorWords(last.color)} — carried ${lengthWords(last.carriedM, units)}.`;
}

/** Where each player is, said rather than drawn: for a dot off the board, or no dot at all. */
export function whereWords(view: WatchSnapshot, color: Color): string {
  const player = view.players[color];
  if (!player.connected) return 'away';
  if (player.at === null) return 'off the board';
  return player.inStartZone && view.status !== 'active' ? 'on their back rank' : 'on the board';
}

/** "White walked 840 m · Black walked 1.2 km · a 40 m board". */
export function walkedLine(view: WatchSnapshot, units: Units): string {
  const parts = [
    `White walked ${walkedWords(view.players.w.travelM, units)}`,
    `Black walked ${walkedWords(view.players.b.travelM, units)}`,
  ];
  if (view.boardM > 0) parts.push(`on a ${boardWords(view.boardM, units)} board`);
  return parts.join(' · ');
}

/** The moves so far, numbered: "1. f3 e5 2. g4 Qh4#". */
export function moveListText(moves: readonly string[]): string {
  const parts: string[] = [];
  moves.forEach((san, i) => {
    parts.push(i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san);
  });
  return parts.join(' ');
}

export interface WatchClocks {
  w: string;
  b: string;
  wMs: number;
  bMs: number;
  /** Which clock is going down, or null while none is. */
  running: Color | null;
}

/**
 * Both clocks as of now, measured as a player's phone measures them: the
 * server's reading in the view plus the time since it arrived, on this
 * device's own clock (`estimateServerNow`), never the device's time of day.
 */
export function watchClocks(
  view: Pick<WatchSnapshot, 'clock' | 'serverNow'>,
  receivedAt: number,
  localNow: number,
): WatchClocks {
  const at = estimateServerNow(view, receivedAt, localNow);
  const both = clockSnapshot(view.clock as ClockState, at);
  return {
    w: formatClock(both.w),
    b: formatClock(both.b),
    wMs: both.w,
    bMs: both.b,
    running: view.clock.startedAt === null ? null : view.clock.active,
  };
}

/** Why the page stopped, when it did. */
export type WatchEnd = 'not_live' | 'over' | 'full' | 'sent' | 'broken';

/** The words for a page that has stopped, by the reason. */
export function watchEndWords(end: WatchEnd): string {
  switch (end) {
    case 'not_live':
      return 'This link is not live. One of the players may have turned watching off, or the game may be over.';
    case 'over':
      return 'The game is over, and the live link has ended with it.';
    case 'full':
      return 'Too many people are watching this game right now. Try again in a little while.';
    case 'sent':
      return 'The connection was closed. Reload the page to watch again.';
    case 'broken':
      return "This link isn't working. It may have been turned off, or the game may be over.";
  }
}

/**
 * How many times in a row a socket may fail to open before the page gives up
 * and says the link is not working. A link to a game that has gone answers no
 * socket at all, so without a limit the page would retry for ever.
 */
export const WATCH_MAX_FAILED_OPENS = 4;

/**
 * What to do when the watcher's socket closes: stop for one of the server's
 * own reasons, stop once it has failed to open too often, else try again.
 */
export function watchCloseOutcome(code: number, failedOpens: number): WatchEnd | 'retry' {
  switch (code) {
    case WATCH_CLOSE.notLive:
      return 'not_live';
    case WATCH_CLOSE.over:
      return 'over';
    case WATCH_CLOSE.full:
      return 'full';
    case WATCH_CLOSE.sent:
      return 'sent';
    default:
      return failedOpens >= WATCH_MAX_FAILED_OPENS ? 'broken' : 'retry';
  }
}

/** The wait before the next try: 1 s, 2 s, 4 s… up to 30 s. */
export function watchRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
}
