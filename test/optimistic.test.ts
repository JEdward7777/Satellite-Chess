import { describe, expect, it, vi } from 'vitest';

import { type FieldSpec, snapshotField } from '../src/shared/field.js';
import { fromLocal } from '../src/shared/geo.js';
import type { GameSnapshot, PosFix } from '../src/shared/protocol.js';
import { DEFAULT_REACH } from '../src/shared/reach.js';
import type { GameConnection, NetState } from '../src/client/net.js';
import {
  applyMoveToFen,
  formatPlacement,
  isSettled,
  parsePlacement,
  predict,
  withOptimism,
} from '../src/client/optimistic.js';

/** An 8 m board, axis-aligned so board space and metres east/north coincide. */
const A1 = { lat: 51.4779, lng: -0.0015 };
const SQUARE_M = 8;
const FIELD: FieldSpec = {
  id: 'f',
  name: 'test',
  a1: A1,
  h8: fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M }),
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** A fix standing on the centre of a square, which is well inside reach. */
function standingOn(file: number, rank: number, acc = 3): PosFix {
  const pos = fromLocal(A1, { e: file * SQUARE_M, n: rank * SQUARE_M });
  return { lat: pos.lat, lng: pos.lng, acc, ts: 1_000 };
}

function snapshot(over: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    v: 1,
    rev: 7,
    joinCode: 'ABC123',
    status: 'active',
    fen: START,
    field: snapshotField(FIELD),
    reach: DEFAULT_REACH,
    clock: { whiteMs: 600_000, blackMs: 600_000, incrementMs: 0, active: 'w', startedAt: 1_000 },
    serverNow: 1_000,
    you: 'w',
    players: {
      w: { color: 'w', connected: true, reachBonusM: 0, travelM: 0, inStartZone: false, lastSeenAt: 1, pos: null },
      b: { color: 'b', connected: true, reachBonusM: 0, travelM: 0, inStartZone: false, lastSeenAt: 1, pos: null },
    },
    lastMove: null,
    moveCount: 0,
    carry: null,
    result: null,
    drawOfferFrom: null,
    createdAt: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('placement round-tripping', () => {
  it('parses and reformats a FEN placement unchanged', () => {
    for (const fen of [
      START,
      '8/8/8/8/8/8/8/8 w - - 0 1',
      'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
      '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 3',
    ]) {
      expect(formatPlacement(parsePlacement(fen))).toBe(fen.split(' ')[0]);
    }
  });

  it('indexes rank 1 at the bottom, matching the rest of the project', () => {
    const board = parsePlacement(START);
    expect(board[0][0]).toBe('R'); // a1
    expect(board[1][4]).toBe('P'); // e2
    expect(board[7][4]).toBe('k'); // e8
    expect(board[4][4]).toBe(''); // e5
  });
});

describe('applyMoveToFen', () => {
  it('moves a piece and flips the side to move', () => {
    const after = applyMoveToFen(START, 'e2', 'e4');
    expect(parsePlacement(after)[3][4]).toBe('P');
    expect(parsePlacement(after)[1][4]).toBe('');
    expect(after.split(' ')[1]).toBe('b');
  });

  it('captures by replacement', () => {
    const fen = '4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1';
    const after = applyMoveToFen(fen, 'e4', 'd5');
    expect(parsePlacement(after)[4][3]).toBe('P');
    expect(parsePlacement(after)[3][4]).toBe('');
  });

  it('moves the rook when the king castles', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    const kingside = parsePlacement(applyMoveToFen(fen, 'e1', 'g1'));
    expect(kingside[0][6]).toBe('K');
    expect(kingside[0][5]).toBe('R');
    expect(kingside[0][7]).toBe('');

    const queenside = parsePlacement(applyMoveToFen(fen, 'e1', 'c1'));
    expect(queenside[0][2]).toBe('K');
    expect(queenside[0][3]).toBe('R');
    expect(queenside[0][0]).toBe('');

    // Black castles on rank 8, and the rook has to follow there too.
    const black = parsePlacement(applyMoveToFen(fen, 'e8', 'g8'));
    expect(black[7][6]).toBe('k');
    expect(black[7][5]).toBe('r');
  });

  it('removes the passed pawn on en passant, not the empty square', () => {
    // White pawn e5 takes a black pawn that has just played d7-d5.
    const fen = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 3';
    const board = parsePlacement(applyMoveToFen(fen, 'e5', 'd6'));
    expect(board[5][3]).toBe('P'); // d6, the arrival square
    expect(board[4][3]).toBe(''); // d5, the captured pawn is gone
    expect(board[4][4]).toBe(''); // e5, vacated
  });

  it('leaves an ordinary diagonal capture alone', () => {
    // Same shape as en passant, but the destination is occupied — so the piece
    // beside it must not be swept away as well.
    const fen = '4k3/8/3b4/4P3/8/8/8/4K3 w - - 0 1';
    const board = parsePlacement(applyMoveToFen(fen, 'e5', 'd6'));
    expect(board[5][3]).toBe('P');
    expect(board[4][3]).toBe('');
  });

  it('promotes to the chosen piece, in the mover’s colour', () => {
    const fen = '8/4P3/8/8/8/8/8/4k1K1 w - - 0 1';
    expect(parsePlacement(applyMoveToFen(fen, 'e7', 'e8', 'q'))[7][4]).toBe('Q');
    expect(parsePlacement(applyMoveToFen(fen, 'e7', 'e8', 'n'))[7][4]).toBe('N');

    const black = '4K3/8/8/8/8/8/4p3/4k3 b - - 0 1';
    expect(parsePlacement(applyMoveToFen(black, 'e2', 'e1', 'n'))[0][4]).toBe('n');
  });

  it('returns the position untouched when the origin is empty', () => {
    expect(applyMoveToFen(START, 'e4', 'e5')).toBe(START);
  });
});

// ---------------------------------------------------------------------------

describe('predict', () => {
  const liftE2 = { t: 'lift', from: 'e2', pos: standingOn(4, 1) } as const;

  it('puts the piece in hand with no destinations yet', () => {
    const out = predict(snapshot(), liftE2, 2_000);
    expect(out?.carry).toEqual({
      color: 'w',
      from: 'e2',
      piece: 'p',
      at: 2_000,
      destinations: [],
    });
    // The board does not change on a lift — the piece is in hand, not moved.
    expect(out?.fen).toBe(START);
  });

  it('refuses to lift out of reach', () => {
    // Standing on a1, reaching for e2: four squares away on an 8 m board.
    expect(predict(snapshot(), { ...liftE2, pos: standingOn(0, 0) }, 2_000)).toBeNull();
  });

  it('refuses to lift the opponent’s piece, or on their turn', () => {
    expect(
      predict(snapshot(), { t: 'lift', from: 'e7', pos: standingOn(4, 6) }, 2_000),
    ).toBeNull();
    expect(
      predict(snapshot({ clock: { ...snapshot().clock, active: 'b' } }), liftE2, 2_000),
    ).toBeNull();
  });

  it('refuses to lift an empty square, or while already carrying', () => {
    expect(predict(snapshot(), { t: 'lift', from: 'e4', pos: standingOn(4, 3) }, 2_000)).toBeNull();
    const carrying = snapshot({
      carry: { color: 'w', from: 'd2', piece: 'p', at: 1, destinations: ['d4'] },
    });
    expect(predict(carrying, liftE2, 2_000)).toBeNull();
  });

  it('refuses to predict anything unless the game is running', () => {
    for (const status of ['staging', 'suspended', 'finished'] as const) {
      expect(predict(snapshot({ status }), liftE2, 2_000)).toBeNull();
    }
  });

  it('applies a place, clears the carry and flips the turn', () => {
    const carrying = snapshot({
      carry: { color: 'w', from: 'e2', piece: 'p', at: 1, destinations: ['e3', 'e4'] },
    });
    const out = predict(carrying, { t: 'place', to: 'e4', pos: standingOn(4, 3) }, 2_000);
    expect(out?.carry).toBeNull();
    expect(out?.clock.active).toBe('b');
    expect(parsePlacement(out!.fen)[3][4]).toBe('P');
    // The remaining times are the server's arithmetic and must not be guessed at.
    expect(out?.clock.whiteMs).toBe(600_000);
  });

  it('refuses a place on a square the server did not list', () => {
    const carrying = snapshot({
      carry: { color: 'w', from: 'e2', piece: 'p', at: 1, destinations: ['e3'] },
    });
    expect(predict(carrying, { t: 'place', to: 'e4', pos: standingOn(4, 3) }, 2_000)).toBeNull();
  });

  it('never predicts a place during a provisional carry', () => {
    // The destination list is empty precisely because it is not known yet, so
    // every placement is unlisted and therefore unpredictable. This is the
    // invariant the view's `pending` flag depends on.
    const provisional = snapshot({
      carry: { color: 'w', from: 'e2', piece: 'p', at: 1, destinations: [] },
    });
    expect(predict(provisional, { t: 'place', to: 'e4', pos: standingOn(4, 3) }, 2_000)).toBeNull();
  });

  it('refuses a place out of reach of the destination', () => {
    const carrying = snapshot({
      carry: { color: 'w', from: 'e2', piece: 'p', at: 1, destinations: ['e4'] },
    });
    expect(predict(carrying, { t: 'place', to: 'e4', pos: standingOn(0, 0) }, 2_000)).toBeNull();
  });

  it('drops only your own carry', () => {
    const mine = snapshot({
      carry: { color: 'w', from: 'e2', piece: 'p', at: 1, destinations: ['e4'] },
    });
    expect(predict(mine, { t: 'drop' }, 2_000)?.carry).toBeNull();

    const theirs = snapshot({
      carry: { color: 'b', from: 'e7', piece: 'p', at: 1, destinations: ['e5'] },
    });
    expect(predict(theirs, { t: 'drop' }, 2_000)).toBeNull();
  });

  it('honours a reach handicap, because the server will', () => {
    // Standing two squares away — out of reach at 5 m base, in reach with 12 m
    // of bonus. The server would accept it, so the prediction must too.
    const far = { t: 'lift', from: 'e2', pos: standingOn(4, 3) } as const;
    expect(predict(snapshot(), far, 2_000)).toBeNull();

    const handicapped = snapshot();
    handicapped.players.w!.reachBonusM = 12;
    expect(predict(handicapped, far, 2_000)).not.toBeNull();
  });
});

describe('isSettled', () => {
  it('settles a lift only when the server’s carry is the one we asked for', () => {
    const msg = { t: 'lift', from: 'e2', pos: standingOn(4, 1) } as const;
    expect(isSettled(snapshot(), msg)).toBe(false);
    const confirmed = snapshot({
      carry: { color: 'w', from: 'e2', piece: 'p', at: 1, destinations: ['e3', 'e4'] },
    });
    expect(isSettled(confirmed, msg)).toBe(true);
    const different = snapshot({
      carry: { color: 'w', from: 'd2', piece: 'p', at: 1, destinations: ['d4'] },
    });
    expect(isSettled(different, msg)).toBe(false);
  });

  it('settles a place or a drop once no carry remains', () => {
    const carrying = snapshot({
      carry: { color: 'w', from: 'e2', piece: 'p', at: 1, destinations: ['e4'] },
    });
    expect(isSettled(carrying, { t: 'drop' })).toBe(false);
    expect(isSettled(snapshot(), { t: 'drop' })).toBe(true);
    expect(isSettled(snapshot(), { t: 'place', to: 'e4', pos: standingOn(4, 3) })).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/** A connection a test drives by hand, recording what the view sends. */
function fakeConnection(initial: GameSnapshot | null = snapshot()) {
  const listeners = new Set<(state: NetState) => void>();
  let state: NetState = {
    status: 'open',
    game: initial,
    lastError: null,
    opponent: null,
    reconnects: 0,
  };
  const sent: unknown[] = [];
  let accepting = true;

  const connection: GameConnection = {
    get state() {
      return state;
    },
    subscribe(listener) {
      listener(state);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(msg) {
      if (!accepting) return false;
      sent.push(msg);
      return true;
    },
    offerPosition: () => false,
    resync: () => {},
    close: () => {},
  };

  return {
    connection,
    sent,
    /** Deliver a server snapshot, as a broadcast would. */
    push(over: Partial<NetState>) {
      state = { ...state, lastError: null, ...over };
      for (const listener of listeners) listener(state);
    },
    /** Make the socket refuse to send, as a dropped connection does. */
    goDown() {
      accepting = false;
    },
  };
}

describe('withOptimism', () => {
  const liftE2 = { t: 'lift', from: 'e2', pos: standingOn(4, 1) } as const;

  it('shows the lift before the server answers, then defers to it', () => {
    const inner = fakeConnection();
    const optimistic = withOptimism(inner.connection);
    const seen: (GameSnapshot | null)[] = [];
    optimistic.subscribe((state) => seen.push(state.game));

    optimistic.send(liftE2);
    expect(inner.sent).toEqual([liftE2]);
    expect(optimistic.state.game?.carry?.from).toBe('e2');
    expect(optimistic.state.game?.carry?.destinations).toEqual([]);

    // The server's own answer carries the destinations, and replaces the guess.
    inner.push({
      game: snapshot({
        rev: 8,
        carry: { color: 'w', from: 'e2', piece: 'p', at: 9, destinations: ['e3', 'e4'] },
      }),
    });
    expect(optimistic.state.game?.carry?.destinations).toEqual(['e3', 'e4']);
    expect(seen.at(-1)?.carry?.destinations).toEqual(['e3', 'e4']);
  });

  it('rolls back when the server refuses', () => {
    const inner = fakeConnection();
    const optimistic = withOptimism(inner.connection);

    optimistic.send(liftE2);
    expect(optimistic.state.game?.carry).not.toBeNull();

    inner.push({
      lastError: { t: 'error', code: 'no_legal_moves', message: 'The piece on e2 has no legal moves.' },
    });
    expect(optimistic.state.game?.carry).toBeNull();
    expect(optimistic.state.lastError?.code).toBe('no_legal_moves');
  });

  it('does not predict what it could not send', () => {
    const inner = fakeConnection();
    const optimistic = withOptimism(inner.connection);
    inner.goDown();

    expect(optimistic.send(liftE2)).toBe(false);
    expect(optimistic.state.game?.carry).toBeNull();
  });

  it('does not predict an action the server would refuse anyway', () => {
    const inner = fakeConnection();
    const optimistic = withOptimism(inner.connection);

    // Out of reach: still sent, because the server writes the error message and
    // its wording is better than anything the client could invent.
    const far = { t: 'lift', from: 'e2', pos: standingOn(0, 0) } as const;
    expect(optimistic.send(far)).toBe(true);
    expect(inner.sent).toEqual([far]);
    expect(optimistic.state.game?.carry).toBeNull();
  });

  it('keeps the prediction when an unrelated snapshot arrives', () => {
    const inner = fakeConnection();
    const optimistic = withOptimism(inner.connection);
    optimistic.send(liftE2);

    // The opponent offers a draw while we are lifting. It bumps `rev` and says
    // nothing about our carry, so the piece must stay in hand.
    inner.push({ game: snapshot({ rev: 9, drawOfferFrom: 'b' }) });
    expect(optimistic.state.game?.carry?.from).toBe('e2');
    expect(optimistic.state.game?.drawOfferFrom).toBe('b');
  });

  it('expires a prediction the server never accounts for', () => {
    vi.useFakeTimers();
    try {
      const inner = fakeConnection();
      const optimistic = withOptimism(inner.connection, { ttlMs: 5_000 });
      const seen: (GameSnapshot | null)[] = [];
      optimistic.subscribe((state) => seen.push(state.game));

      optimistic.send(liftE2);
      expect(optimistic.state.game?.carry).not.toBeNull();

      // A frame lost to a dying socket: `send` succeeded, nothing came back.
      vi.advanceTimersByTime(5_001);
      expect(optimistic.state.game?.carry).toBeNull();
      // And subscribers were told, rather than being left on a stale paint.
      expect(seen.at(-1)?.carry).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a place immediately and keeps it until the move comes back', () => {
    const inner = fakeConnection(
      snapshot({ carry: { color: 'w', from: 'e2', piece: 'p', at: 1, destinations: ['e3', 'e4'] } }),
    );
    const optimistic = withOptimism(inner.connection);

    optimistic.send({ t: 'place', to: 'e4', pos: standingOn(4, 3) });
    expect(parsePlacement(optimistic.state.game!.fen)[3][4]).toBe('P');
    expect(optimistic.state.game?.carry).toBeNull();
    expect(optimistic.state.game?.clock.active).toBe('b');

    inner.push({
      game: snapshot({
        rev: 9,
        fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
        clock: { whiteMs: 590_000, blackMs: 600_000, incrementMs: 0, active: 'b', startedAt: 2 },
      }),
    });
    expect(optimistic.state.game?.clock.whiteMs).toBe(590_000);
  });

  it('passes everything else straight through', () => {
    const inner = fakeConnection();
    const optimistic = withOptimism(inner.connection);
    const ready = { t: 'ready', pos: standingOn(4, 0) } as const;

    optimistic.send(ready);
    expect(inner.sent).toEqual([ready]);
    expect(optimistic.state.game?.carry).toBeNull();
  });
});
