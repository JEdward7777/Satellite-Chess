/**
 * Optimistic local application: a tap moves the screen now, the DO confirms later.
 *
 * Every other part of the client waits for the server, and it is right to —
 * decision 0008 makes the Durable Object the only authority on whether a move
 * happened. But on one bar in a field, "tap, wait, see something" reads as a
 * broken app rather than a slow one, and the two taps in a move are the whole
 * interaction. So this layer predicts the answer and shows it immediately.
 *
 * It is a decorator around a {@link GameConnection}, not a change to one, for two
 * reasons. `net.ts` promises it "never decides anything about the game", and that
 * promise is worth keeping literally. And a view that wants the truth can hold
 * the undecorated connection instead.
 *
 * **The prediction is a pure function of the latest server snapshot, held as an
 * *action* rather than as a result.** That is what makes reconciliation simple:
 * every snapshot that arrives is re-checked, the pending action re-applied on top
 * if it still fits, and dropped the moment the server's own state accounts for it.
 * Nothing is ever "merged" — the server's snapshot is always the base.
 *
 * ## What is deliberately not predicted
 *
 * No rules engine runs here. Bundling chess.js would add ~36 kB to a ~45 kB
 * bundle for a phone with one bar, and `render.ts` already refused that cost once
 * for the same reason. It turns out not to be needed:
 *
 * - **A place is already known-legal.** Its destination came from
 *   `carry.destinations`, which the server generated with chess.js at lift time.
 *   Applying a move that has already been declared legal needs no move generation
 *   — only the three cases where the board changes somewhere other than
 *   `from`/`to`, which are castling, en passant and promotion.
 * - **A lift needs move generation, and so is predicted without its
 *   destinations.** The server refuses to lift a piece with no legal moves, and
 *   the client cannot know that locally. This is the one prediction that can be
 *   wrong, and it rolls back with the server's own message when it is.
 *
 * That gap costs nothing in practice, because **the next act of a move is a walk
 * away.** Destination dots that arrive 200 ms after the lift are invisible to a
 * player who is about to spend thirty seconds getting there. The latency worth
 * removing is tap-to-acknowledgement, not tap-to-complete-information.
 */

import { deriveGeometry } from '../shared/field.js';
import type {
  ClientMsg,
  GameSnapshot,
  LiftMsg,
  PlaceMsg,
  PosFix,
} from '../shared/protocol.js';
import { checkReachTo } from '../shared/reach.js';
import { type Color, type Square, fromSquare, toSquare } from '../shared/squares.js';
import type { GpsFix } from './gps.js';
import type { GameConnection, NetState } from './net.js';

/**
 * How long a prediction may stand unconfirmed before the screen stops claiming it.
 *
 * The socket dying mid-flight is the case this exists for: `send` reports success,
 * the frame is lost, and the reconnect's `sync` returns a snapshot that neither
 * confirms nor contradicts the action. Without a deadline the screen would show a
 * piece in a hand that is not holding it, indefinitely.
 */
export const PREDICTION_TTL_MS = 5_000;

/** The subset of client messages worth predicting: the three acts of a carry. */
export type PredictableMsg = LiftMsg | DropMsg | PlaceMsg;
type DropMsg = Extract<ClientMsg, { t: 'drop' }>;

export function isPredictable(msg: ClientMsg): msg is PredictableMsg {
  return msg.t === 'lift' || msg.t === 'place' || msg.t === 'drop';
}

// ---------------------------------------------------------------------------
// Applying a move to a position, without a rules engine
// ---------------------------------------------------------------------------

/** The placement field of a FEN as `board[rank][file]`, `''` for an empty square. */
type Placement = string[][];

export function parsePlacement(fen: string): Placement {
  const board: Placement = Array.from({ length: 8 }, () => Array<string>(8).fill(''));
  const rows = fen.split(' ')[0]?.split('/') ?? [];
  // FEN lists rank 8 first; rank indices here count up from rank 1, as everywhere
  // else in this project.
  rows.forEach((row, index) => {
    const rank = 7 - index;
    if (rank < 0) return;
    let file = 0;
    for (const ch of row) {
      const skip = Number(ch);
      if (Number.isFinite(skip) && skip > 0) {
        file += skip;
        continue;
      }
      if (file > 7) break;
      board[rank][file] = ch;
      file += 1;
    }
  });
  return board;
}

export function formatPlacement(board: Placement): string {
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank -= 1) {
    let row = '';
    let empty = 0;
    for (let file = 0; file < 8; file += 1) {
      const piece = board[rank][file];
      if (piece === '') {
        empty += 1;
        continue;
      }
      if (empty > 0) {
        row += String(empty);
        empty = 0;
      }
      row += piece;
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }
  return rows.join('/');
}

/**
 * Apply a known-legal move to a FEN, for rendering only.
 *
 * Only the placement field and the side to move are updated. Castling rights,
 * the en passant target and the halfmove clocks are left as they were, because
 * **the client reads none of them** — `piecesFromFen` takes the placement field
 * and nothing else, and whose turn it is comes from `clock.active`. The next
 * snapshot replaces the whole string a moment later anyway.
 *
 * The move must already be known legal: this is only ever called for a
 * destination the server itself enumerated. Nothing here validates anything.
 */
export function applyMoveToFen(
  fen: string,
  from: Square,
  to: Square,
  promotion?: 'q' | 'r' | 'b' | 'n',
): string {
  const board = parsePlacement(fen);
  const a = fromSquare(from);
  const b = fromSquare(to);
  const piece = board[a.rank][a.file];
  if (piece === '') return fen;

  const white = piece === piece.toUpperCase();
  const kind = piece.toLowerCase();
  const captured = board[b.rank][b.file];

  board[a.rank][a.file] = '';
  board[b.rank][b.file] = promotion
    ? (white ? promotion.toUpperCase() : promotion)
    : piece;

  // Castling: the king moves two files, and the rook jumps over it. chess.js
  // encodes castling as a king move only, so the rook has to be moved here or it
  // is left stranded on the corner.
  if (kind === 'k' && Math.abs(b.file - a.file) === 2) {
    const kingside = b.file > a.file;
    const rookFrom = kingside ? 7 : 0;
    const rookTo = kingside ? b.file - 1 : b.file + 1;
    board[a.rank][rookTo] = board[a.rank][rookFrom];
    board[a.rank][rookFrom] = '';
  }

  // En passant: a pawn changing file onto an empty square captures the pawn
  // beside it, not the one under it.
  if (kind === 'p' && a.file !== b.file && captured === '') {
    board[a.rank][b.file] = '';
  }

  const fields = fen.split(' ');
  fields[0] = formatPlacement(board);
  if (fields.length > 1) fields[1] = white ? 'b' : 'w';
  return fields.join(' ');
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

const other = (color: Color): Color => (color === 'w' ? 'b' : 'w');

/** Can this player reach that square from that fix, by the same rule the DO uses? */
function canReach(game: GameSnapshot, pos: PosFix, square: Square): boolean {
  try {
    const bonus = game.players[game.you]?.reachBonusM ?? 0;
    return checkReachTo(deriveGeometry(game.field), pos, pos.acc, square, game.reach, bonus).ok;
  } catch {
    // A degenerate field throws rather than guessing. Declining to predict is
    // always safe; the server's answer is coming either way.
    return false;
  }
}

/**
 * What the snapshot would look like if the server accepts this action.
 *
 * Returns `null` whenever the action is not *certainly* acceptable, which is the
 * important half of the contract. A prediction that gets refused shows the player
 * something false and then snatches it back, which is worse than the wait it was
 * trying to hide — so anything less than certain is left to the server.
 */
export function predict(
  game: GameSnapshot,
  msg: PredictableMsg,
  now: number,
): GameSnapshot | null {
  if (game.status !== 'active' || game.result !== null) return null;

  switch (msg.t) {
    case 'lift': {
      if (game.carry !== null) return null;
      if (game.clock.active !== game.you) return null;

      const piece = parsePlacement(game.fen)[fromSquare(msg.from).rank]?.[
        fromSquare(msg.from).file
      ];
      if (!piece) return null;
      const mine = (piece === piece.toUpperCase() ? 'w' : 'b') === game.you;
      if (!mine) return null;
      if (!canReach(game, msg.pos, msg.from)) return null;

      // No destinations: we cannot generate moves, and an empty list is an
      // unambiguous marker because the server never sends one — `onLift` refuses
      // a piece with no legal moves rather than carrying an empty set. The view
      // reads that as "still working it out" instead of "nowhere to go".
      return {
        ...game,
        carry: {
          color: game.you,
          from: msg.from,
          piece: piece.toLowerCase(),
          at: now,
          destinations: [],
        },
      };
    }

    case 'drop': {
      if (game.carry === null || game.carry.color !== game.you) return null;
      return { ...game, carry: null };
    }

    case 'place': {
      const carry = game.carry;
      if (carry === null || carry.color !== game.you) return null;
      // Only a destination the server already called legal. A stray tap is left
      // for the server to refuse, exactly as it would have been without this
      // layer — and a *provisional* carry has no destinations, so a place during
      // one is never predicted.
      if (!carry.destinations.includes(msg.to)) return null;
      if (!canReach(game, msg.pos, msg.to)) return null;

      return {
        ...game,
        fen: applyMoveToFen(game.fen, carry.from, msg.to, msg.promotion),
        carry: null,
        // Whose turn it is drives the prompt, so it has to flip with the move.
        // The remaining times are left alone: they are the server's arithmetic
        // over server timestamps (`shared/clock.ts`), and guessing at them here
        // would put a second clock in the world.
        //
        // `startedAt` goes to null with it, which is what stops the displayed
        // clock (`client/clock.ts`) from lying during the one round trip this
        // prediction covers. Flipping `active` while leaving the old start
        // instant in place would have the opponent's clock ticking *from the
        // moment the mover's turn began* — so it would appear to lose the whole
        // of their think time in a single jump, which reads as the game stealing
        // time from them. Shown frozen instead: the handover instant belongs to
        // the server and the client cannot name it in server time, and a clock
        // that pauses for a few hundred milliseconds is invisible where one that
        // jumps by two minutes is not.
        clock: { ...game.clock, active: other(game.you), startedAt: null },
      };
    }
  }
}

/**
 * Has the server's own snapshot already accounted for this action?
 *
 * This is the reconciliation test, and it is deliberately about *evidence* rather
 * than about revision numbers. A snapshot can arrive with a higher `rev` because
 * the opponent resigned or a draw was offered, which says nothing about whether
 * our lift landed; dropping the prediction on `rev` alone would flicker.
 */
export function isSettled(game: GameSnapshot, msg: PredictableMsg): boolean {
  switch (msg.t) {
    case 'lift':
      return game.carry !== null && game.carry.from === msg.from;
    case 'drop':
      return game.carry === null;
    case 'place':
      // The carry is gone: either the place was accepted, or something else
      // ended it. Both mean this prediction has nothing left to say.
      return game.carry === null;
  }
}

// ---------------------------------------------------------------------------
// The decorator
// ---------------------------------------------------------------------------

export interface OptimismOptions {
  now?: () => number;
  ttlMs?: number;
  /** Injectable so a test need not wait in real time. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Wrap a connection so the three acts of a carry take effect on screen at once.
 *
 * The wrapped connection is interchangeable with the real one — same interface,
 * same messages on the wire. Only what subscribers see differs, and only ever by
 * one unconfirmed action.
 */
export function withOptimism(
  inner: GameConnection,
  opts: OptimismOptions = {},
): GameConnection {
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? PREDICTION_TTL_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as never));

  const listeners = new Set<(state: NetState) => void>();
  let pending: PredictableMsg | null = null;
  let expiry: unknown = null;
  let base: NetState = inner.state;

  const clearExpiry = () => {
    if (expiry !== null) clearTimer(expiry);
    expiry = null;
  };

  const forget = () => {
    pending = null;
    clearExpiry();
  };

  /** The base snapshot with the pending action applied, if it still applies. */
  const view = (): NetState => {
    if (pending === null || base.game === null) return base;
    const predicted = predict(base.game, pending, now());
    if (predicted === null) return base;
    return { ...base, game: predicted };
  };

  const publish = () => {
    const state = view();
    for (const listener of listeners) listener(state);
  };

  const offInner = inner.subscribe((state) => {
    base = state;
    if (pending !== null && state.game !== null) {
      // The server has spoken about this action, or has moved past it. Either
      // way there is nothing left to predict.
      if (isSettled(state.game, pending)) forget();
    }
    // A rejection is always about the thing we just sent, and it arrives instead
    // of a state change — so the prediction has to come off before the view shows
    // the message, or the notice would contradict the board it sits under.
    if (pending !== null && state.lastError !== null) forget();
    publish();
  });

  return {
    get state() {
      return view();
    },

    subscribe(listener) {
      listener(view());
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) offInner();
      };
    },

    send(msg: ClientMsg): boolean {
      const sent = inner.send(msg);
      // Only predict what actually left the phone. A message dropped because the
      // socket is down must not move the board — that is precisely the moment a
      // false confirmation would be most damaging.
      if (!sent || !isPredictable(msg)) return sent;
      if (base.game === null || predict(base.game, msg, now()) === null) return sent;

      clearExpiry();
      pending = msg;
      expiry = setTimer(() => {
        forget();
        publish();
      }, ttlMs);
      publish();
      return sent;
    },

    offerPosition(fix: GpsFix, travelM?: number): boolean {
      return inner.offerPosition(fix, travelM);
    },

    resync(): void {
      inner.resync();
    },

    close(): void {
      forget();
      inner.close();
    },
  };
}
