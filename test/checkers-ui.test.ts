import { describe, expect, it } from 'vitest';

import { type FieldSpec, deriveGeometry, snapshotField, toBoardPoint } from '../src/shared/field.js';
import { fromLocal } from '../src/shared/geo.js';
import type { GameSnapshot, PosFix } from '../src/shared/protocol.js';
import { DEFAULT_REACH } from '../src/shared/reach.js';
import { isSettled, predict } from '../src/client/optimistic.js';
import {
  UPDATE_APP_WORDS,
  descriptorFor,
  gameLabel,
  seatIsDark,
  seatName,
} from '../src/shared/games/catalog.js';
import { CHECKERS_START, type CheckersMan, formatCheckers, parseCheckers } from '../src/shared/games/checkers.js';
import type { GameOptions } from '../src/shared/games/types.js';
import type { GameReport, ReportMove } from '../src/shared/review.js';
import { type Color, type Square, fromSquare } from '../src/shared/squares.js';
import { CHECKERS_RULES as R } from '../src/worker/games/checkers.js';
import { CHESS_RULES } from '../src/worker/games/chess.js';
import {
  carryGuidance,
  carryPrompt,
  carryReadout,
  carryTap,
  jumpsWords,
  resultPrompt,
} from '../src/client/views/game.js';
import { hopsVia, hopsWords, replayFens, replayFrame } from '../src/client/replay.js';
import { colorWords, recordExplanation, resultWords, shareMessageWords } from '../src/client/review.js';
import { cardFileName, cardResultWords, cardTitleWords, shareCard, straightCarries } from '../src/client/share-card.js';
import { colourLabel, createGameBody, emptyDraft } from '../src/client/views/create.js';
import { type RecordGame, standingOf, summarizeRecord, tallyByGame } from '../src/shared/record.js';
import { opponentDetail, summarizeHeadToHead } from '../src/shared/head-to-head.js';
import { DISTANCE_HONESTY, distanceHonesty, lineWords, playedWords, resultsByGameWords } from '../src/client/record.js';
import { inviteShareData } from '../src/client/share.js';
import { describeGame } from '../src/client/views/games.js';
import { pieceWords, watchHeadline, watchShareData } from '../src/client/watching.js';
import { shapesOf, pieceSvg } from '../src/client/games/checkers/pieces.js';
import { CHECKERS_ART } from '../src/client/games/checkers/index.js';
import type { WatchSnapshot } from '../src/shared/watch.js';

/**
 * Checkers on the phone (stage 11.3, decision 0058): the waypoint taps and
 * their prediction, the origin as a real place after a hop, seats named per
 * game, the replay's hops, the share card, and the record split by game.
 */

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

function on(square: Square, acc = 3): PosFix {
  const { file, rank } = fromSquare(square);
  const pos = fromLocal(A1, { e: file * SQUARE_M, n: rank * SQUARE_M });
  return { lat: pos.lat, lng: pos.lng, acc, ts: 1_000 };
}

/** A position from square lists: `K` before a king. `w` moves first (the dark pieces). */
function position(turn: Color, w: string[], b: string[]): string {
  const board = new Map<Square, CheckersMan>();
  for (const [color, list] of [['w', w], ['b', b]] as const) {
    for (const item of list) {
      const king = item.startsWith('K');
      board.set((king ? item.slice(1) : item) as Square, { color, king });
    }
  }
  return formatCheckers({ turn, board });
}

function snapshot(over: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    v: 1,
    rev: 7,
    watch: { offeredBy: null, on: false, link: null },
    suspension: null,
    joinCode: 'ABC123',
    status: 'active',
    gameType: 'checkers',
    options: { jumpsRequired: false },
    fen: CHECKERS_START,
    field: snapshotField(FIELD),
    reach: DEFAULT_REACH,
    clock: { whiteMs: 600_000, blackMs: 600_000, incrementMs: 0, active: 'w', startedAt: 1_000 },
    serverNow: 1_000,
    you: 'w',
    players: {
      w: { color: 'w', connected: true, reachBonusSquares: 0, travelM: 0, inStartZone: false, lastSeenAt: 1, pos: null },
      b: { color: 'b', connected: true, reachBonusSquares: 0, travelM: 0, inStartZone: false, lastSeenAt: 1, pos: null },
    },
    lastMove: null,
    moveCount: 0,
    carry: null,
    result: null,
    drawOfferFrom: null,
    abortOfferFrom: null,
    createdAt: 0,
    ...over,
  };
}

/** A seeded generator, so a failing sweep names a game that can be replayed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A double jump for `w` from c1: over d2 to e3, over f4 to g5 (b2 stays, so e3 goes on). */
const DOUBLE = position('w', ['c1', 'a1'], ['d2', 'f4', 'h8']);

// ---------------------------------------------------------------------------

describe('a tap while carrying', () => {
  const base = { from: 'c1' as Square, destinations: [] as Square[], waypoints: [] as Square[], via: [] as Square[] };

  it('puts the piece back on its origin before any hop', () => {
    expect(carryTap(base, 'c1')).toBe('drop');
  });

  it('places on the origin after a hop: a king can end its jump where it began', () => {
    expect(carryTap({ ...base, via: ['e3'], destinations: ['c1'] }, 'c1')).toBe('place');
    // Not offered (a man can never come back): the origin puts it all back.
    expect(carryTap({ ...base, via: ['e3'], destinations: ['e3'] }, 'c1')).toBe('drop');
  });

  it('hops on a waypoint, and asks where a landing is both', () => {
    expect(carryTap({ ...base, waypoints: ['e3'] }, 'e3')).toBe('waypoint');
    expect(carryTap({ ...base, waypoints: ['e3'], destinations: ['e3'] }, 'e3')).toBe('ask');
    expect(carryTap({ ...base, destinations: ['d2'] }, 'd2')).toBe('place');
  });

  it('is the old two taps for a chess carry, which never has a hop', () => {
    const chess = { from: 'e2' as Square, destinations: ['e3', 'e4'] as Square[] };
    expect(carryTap(chess, 'e2')).toBe('drop');
    expect(carryTap(chess, 'e4')).toBe('place');
  });

  it('agrees with the rules on a real king loop that ends on its origin', () => {
    // A king on c3 jumps d4, f4, d2 and lands on c3 again (decision 0057's example).
    const state = position('w', ['Kc3'], ['d4', 'f4', 'f2', 'd2']);
    const at = (via: Square[]) => R.stops(state, { from: 'c3', via }, { jumpsRequired: true });
    const loop: Square[] = ['e5', 'g3', 'e1'];
    let via: Square[] = [];
    for (const hop of loop) {
      const stops = at(via);
      expect(carryTap({ from: 'c3', via, ...{ destinations: stops.places, waypoints: stops.waypoints } }, hop)).toBe('waypoint');
      via = [...via, hop];
    }
    const last = at(via);
    expect(last.places).toContain('c3');
    expect(carryTap({ from: 'c3', via, destinations: last.places, waypoints: last.waypoints }, 'c3')).toBe('place');
    expect(R.play(state, { from: 'c3', via }, 'c3', undefined, { jumpsRequired: true })).not.toBeNull();
  });
});

describe('predicting a hop', () => {
  const stops = R.stops(DOUBLE, { from: 'c1', via: [] }, { jumpsRequired: false });
  const carrying = snapshot({
    fen: DOUBLE,
    carry: { color: 'w', from: 'c1', piece: 'm', at: 1_000, destinations: stops.places, waypoints: stops.waypoints },
  });

  it('walks the hop at once and waits for the server to say where next', () => {
    expect(stops.waypoints).toEqual(['e3']);
    const next = predict(carrying, { t: 'waypoint', to: 'e3', pos: on('e3') }, 2_000);
    expect(next?.carry?.via).toEqual(['e3']);
    expect(next?.carry?.destinations).toEqual([]);
    expect(next?.carry?.waypoints).toEqual([]);
    // The board reads it as "still working it out", not as nowhere to go.
    const geo = deriveGeometry(next!.field);
    const guidance = carryGuidance(geo, toBoardPoint(geo, on('e3')), 4, next!.carry!, 'w');
    expect(guidance.pending).toBe(true);
    expect(carryPrompt(guidance)).toBe('Jumped to e3. Hold on…');
  });

  it('predicts only a hop the server offered, from within reach', () => {
    expect(predict(carrying, { t: 'waypoint', to: 'g5', pos: on('g5') }, 2_000)).toBeNull();
    expect(predict(carrying, { t: 'waypoint', to: 'e3', pos: on('a7') }, 2_000)).toBeNull();
    expect(predict({ ...carrying, carry: { ...carrying.carry!, color: 'b' } }, { t: 'waypoint', to: 'e3', pos: on('e3') }, 2_000)).toBeNull();
  });

  it('settles when the server has walked the same hop, or ended the carry', () => {
    const msg = { t: 'waypoint', to: 'e3', pos: on('e3') } as const;
    expect(isSettled(carrying, msg)).toBe(false);
    expect(isSettled({ ...carrying, carry: { ...carrying.carry!, via: ['e3'] } }, msg)).toBe(true);
    expect(isSettled({ ...carrying, carry: null }, msg)).toBe(true);
  });

  it('places after a hop by applying every hop', () => {
    const after = R.stops(DOUBLE, { from: 'c1', via: ['e3'] }, { jumpsRequired: false });
    const mid = snapshot({
      fen: DOUBLE,
      carry: { color: 'w', from: 'c1', piece: 'm', at: 1_000, destinations: after.places, waypoints: after.waypoints, via: ['e3'] },
    });
    const placed = predict(mid, { t: 'place', to: 'g5', pos: on('g5') }, 2_000);
    const played = R.play(DOUBLE, { from: 'c1', via: ['e3'] }, 'g5', undefined, { jumpsRequired: false });
    expect(placed?.fen).toBe(played?.state);
    // Stopping on the square stood on (jumps not required) takes the one piece.
    const stopped = predict(mid, { t: 'place', to: 'e3', pos: on('e3') }, 2_000);
    expect(stopped?.fen).toBe(R.play(DOUBLE, { from: 'c1', via: ['e3'] }, 'e3', undefined, { jumpsRequired: false })?.state);
  });

  it('never predicts a game this build does not know', () => {
    const odd = snapshot({ gameType: 'backgammon' as never, carry: null });
    expect(predict(odd, { t: 'lift', from: 'c1', pos: on('c1') }, 2_000)).toBeNull();
  });
});

describe('the carry, in words', () => {
  const geo = deriveGeometry(snapshotField(FIELD));

  it('shows the hops walked so far', () => {
    const carry = { color: 'w' as const, from: 'c1' as Square, piece: 'm', at: 0, destinations: ['g5', 'e3'] as Square[], via: ['e3'] as Square[] };
    const guidance = carryGuidance(geo, toBoardPoint(geo, on('e3')), 4, carry, 'w');
    expect(carryReadout(guidance)).toMatch(/^c1 → e3 · /);
    // Out of reach after a hop: a walk, never what reads as one more hop.
    const far = carryGuidance(geo, toBoardPoint(geo, on('a1')), 4, carry, 'w');
    expect(carryReadout(far)).toMatch(/^c1 → e3 · walk \d+ m to e3$/);
    expect(carryPrompt(guidance)).toMatch(/^Jumped to e3\. .*Tap e3 to stop there\.$/);
  });

  it('counts a hop in reach as a stop in reach', () => {
    const carry = { color: 'w' as const, from: 'c1' as Square, piece: 'm', at: 0, destinations: [] as Square[], waypoints: ['e3'] as Square[] };
    const guidance = carryGuidance(geo, toBoardPoint(geo, on('e3')), 4, carry, 'w');
    expect(guidance.pending).toBe(false);
    expect(guidance.inReach).toEqual(['e3']);
    expect(carryPrompt(guidance)).toBe('Jumping. Tap a ring to jump on — 1 in reach.');
  });

  it('says the jumps setting for checkers only', () => {
    expect(jumpsWords(snapshot({ options: { jumpsRequired: true } }))).toBe('required');
    expect(jumpsWords(snapshot({ options: { jumpsRequired: false } }))).toBe('optional');
    expect(jumpsWords(snapshot({ options: undefined }))).toBe('optional');
    expect(jumpsWords(snapshot({ gameType: undefined, options: undefined }))).toBeNull();
  });
});

describe('seats, named per game', () => {
  it('calls checkers’ first mover Black, and chess’s White', () => {
    expect(seatName('checkers', 'w')).toBe('Black');
    expect(seatName('checkers', 'b')).toBe('White');
    expect(seatName(undefined, 'w')).toBe('White');
    expect(seatName('chess', 'b')).toBe('Black');
    expect(seatIsDark('checkers', 'w')).toBe(true);
    expect(seatIsDark(undefined, 'w')).toBe(false);
  });

  it('labels the color picker by the chosen game', () => {
    expect(colourLabel('w', 'chess')).toBe('White');
    expect(colourLabel('w', 'checkers')).toBe('Black');
    expect(colourLabel('random', 'checkers')).toBe('Random');
  });

  it('says the result on the board in names for checkers, and as before for chess', () => {
    expect(resultPrompt(undefined, { outcome: '1-0', reason: 'checkmate', at: 0 })).toBe('1-0 — checkmate.');
    expect(resultPrompt('checkers', { outcome: '1-0', reason: 'no_moves', at: 0 })).toBe('Black won — no moves left.');
    expect(resultPrompt('checkers', { outcome: '0-1', reason: 'timeout', at: 0 })).toBe('White won — on time.');
  });

  it('names an unknown game as an update notice, never as chess', () => {
    expect(descriptorFor('backgammon')).toBeNull();
    expect(descriptorFor(undefined)?.type).toBe('chess');
    expect(gameLabel('checkers')).toBe('Checkers');
    expect(gameLabel(undefined)).toBeNull();
    expect(UPDATE_APP_WORDS).toMatch(/update/);
  });

  it('names the watcher’s seats and pieces by the game', () => {
    const view = {
      status: 'active',
      gameType: 'checkers',
      result: null,
      carry: { color: 'w', from: 'c1', piece: 'k', via: ['e3'] },
      clock: { active: 'w' },
    } as unknown as WatchSnapshot;
    expect(watchHeadline(view)).toBe('Black is jumping a king: c1 → e3.');
    expect(pieceWords('m', 'checkers')).toBe('a man');
    expect(pieceWords('n')).toBe('a knight');
    expect(watchHeadline({ ...view, gameType: 'backgammon' } as unknown as WatchSnapshot)).toBe(UPDATE_APP_WORDS);
    expect(watchShareData('u', 'checkers').text).toBe('We are playing checkers on a real field. Watch it live here:');
    expect(watchShareData('u').text).toBe('We are playing chess on a real field. Watch it live here:');
  });

  it('labels a checkers game on the games list, and leaves chess as it was', () => {
    const listed = {
      joinCode: 'ABC123',
      color: 'w',
      fieldName: 'Park',
      status: 'active',
      result: null,
      suspendedBy: null,
      suspendedAt: null,
    } as never;
    expect(describeGame(listed).detail).toBe('White · in play');
    expect(describeGame({ ...(listed as object), gameType: 'checkers' } as never).detail).toBe('Checkers · Black · in play');
  });
});

describe('New game', () => {
  const field = FIELD;

  it('sends a chess body exactly as before', () => {
    const body = createGameBody(emptyDraft([field]), field, 'w');
    expect(body).not.toHaveProperty('gameType');
    expect(body).not.toHaveProperty('options');
  });

  it('sends checkers with the switch, off by default', () => {
    const draft = { ...emptyDraft([field]), game: 'checkers' as const };
    expect(createGameBody(draft, field, 'b')).toMatchObject({ gameType: 'checkers', options: { jumpsRequired: false } });
    expect(createGameBody({ ...draft, jumpsRequired: true }, field, 'b')).toMatchObject({ options: { jumpsRequired: true } });
  });
});

// ---------------------------------------------------------------------------
// A random checkers game, played by the server's own rules, as a report.
// ---------------------------------------------------------------------------

function randomGame(seed: number, options: GameOptions): { report: GameReport; states: string[] } {
  const random = rng(seed);
  let state = CHECKERS_START;
  const states = [state];
  const moves: ReportMove[] = [];
  const spot = (sq: Square) => ({ ...fromSquare(sq), accuracyM: 3 });
  for (let ply = 0; ply < 80 && R.ending(state, options) === null; ply++) {
    const turn = parseCheckers(state).turn;
    const mine = [...parseCheckers(state).board].filter(([, man]) => man.color === turn).map(([sq]) => sq);
    const movable = mine.filter((sq) => {
      const s = R.stops(state, { from: sq, via: [] }, options);
      return s.places.length + s.waypoints.length > 0;
    });
    const from = movable[Math.floor(random() * movable.length)]!;
    const via: Square[] = [];
    let to: Square | null = null;
    while (to === null) {
      const s = R.stops(state, { from, via }, options);
      const all = [...s.waypoints.map((sq) => ['hop', sq] as const), ...s.places.map((sq) => ['place', sq] as const)];
      const [kind, sq] = all[Math.floor(random() * all.length)]!;
      if (kind === 'hop') via.push(sq);
      else to = sq;
    }
    const played = R.play(state, { from, via }, to, undefined, options)!;
    moves.push({
      seq: ply + 1,
      color: turn,
      san: played.notation,
      uci: played.uci,
      from: played.from,
      to: played.to,
      carriedM: 10,
      carriedMs: 1000,
      lift: spot(from),
      ...(via.length === 0 ? {} : { via: via.map(spot) }),
      place: spot(played.to),
    });
    state = played.state;
    states.push(state);
  }
  const end = R.ending(state, options);
  return {
    states,
    report: {
      joinCode: 'ABC123',
      gameType: 'checkers',
      options,
      fieldName: 'Park',
      startedAt: 0,
      finishedAt: 1,
      outcome: end?.outcome ?? '1/2-1/2',
      reason: end?.reason ?? 'agreement',
      initialMs: 600_000,
      incrementMs: 0,
      squareM: 8,
      boardM: 64,
      diagonalM: 90,
      travelM: { w: 100, b: 100 },
      moves,
      tracks: null,
    },
  };
}

describe('the replay of a checkers game', () => {
  it('reads every hop back out of uci', () => {
    expect(hopsVia({ uci: 'c3e5g7' })).toEqual(['e5']);
    expect(hopsVia({ uci: 'c3e5g7e5c3' })).toEqual(['e5', 'g7', 'e5']);
    expect(hopsVia({ uci: 'e7e8q' })).toEqual([]);
    expect(hopsVia({ uci: 'c3d4' })).toEqual([]);
  });

  it('draws the same positions the server played, every hop of every jump (a sweep)', () => {
    let jumps = 0;
    let multi = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const options = { jumpsRequired: seed % 2 === 0 };
      const { report, states } = randomGame(seed, options);
      for (const move of report.moves) {
        if (move.san.includes('x')) jumps += 1;
        if (hopsVia(move).length > 0) multi += 1;
      }
      const fens = replayFens(report);
      if (fens.length !== states.length || fens.some((f, i) => f !== states[i])) {
        expect.fail(`seed ${seed}: the replay drifted from the rules`);
      }
    }
    // The sweep is worth something only if it walked real jumps.
    expect(jumps).toBeGreaterThan(100);
    expect(multi).toBeGreaterThan(5);
  });

  it('names the jump, the hops and the seat', () => {
    expect(hopsWords({ color: 'w', from: 'c1', to: 'g5', uci: 'c1e3g5' }, 'checkers')).toBe('Black jumped c1 to e3 to g5');
    expect(hopsWords({ color: 'b', from: 'd6', to: 'b4', uci: 'd6b4' }, 'checkers')).toBe('White jumped d6 to b4');
    expect(hopsWords({ color: 'b', from: 'd6', to: 'c5', uci: 'd6c5' }, 'checkers')).toBe('White moved d6 to c5');
    // A chess bishop two squares along a diagonal moved; it did not jump.
    expect(hopsWords({ color: 'w', from: 'c1', to: 'e3', uci: 'c1e3' })).toBe('White moved c1 to e3');
  });

  it('draws a carry through its hops when there are no walks', () => {
    const { report } = randomGame(3, { jumpsRequired: false });
    const at = report.moves.findIndex((m) => (m.via ?? []).length > 0);
    if (at === -1) return;
    const fens = replayFens(report);
    const frame = replayFrame(report, fens, at + 1);
    expect(frame.carry?.length).toBe(2 + report.moves[at]!.via!.length);
  });

  it('shows no positions for a game this build does not know', () => {
    const { report } = randomGame(1, { jumpsRequired: false });
    expect(replayFens({ ...report, gameType: 'backgammon' as never })).toEqual([]);
  });
});

describe('the review and the share card, for checkers', () => {
  const { report } = randomGame(7, { jumpsRequired: true });

  it('names seats by the game', () => {
    expect(colorWords('w', 'checkers')).toBe('Black');
    const won = { ...report, outcome: '1-0' as const, reason: 'no_moves' as const };
    expect(resultWords(won, null)).toBe('Black won — no moves left');
    expect(cardResultWords(won, 'w')).toBe('Won as Black — no moves left');
    expect(cardResultWords(won, 'b')).toBe('Lost as White — no moves left');
  });

  it('drops chess’s words', () => {
    expect(cardTitleWords('checkers')).toBe('SATELLITE CHECKERS');
    expect(cardTitleWords(undefined)).toBe('SATELLITE CHESS');
    expect(cardFileName('checkers')).toBe('satellite-checkers.png');
    expect(cardFileName(undefined)).toBe('satellite-chess.png');
    expect(shareMessageWords(null, 'metric', 'checkers')).toBe('A game of checkers on Satellite Chess. Here it is.');
    expect(shareMessageWords({ color: 'w', travelM: 100, moves: 1, longestCarryM: 1, crossings: 1 }, 'metric', 'checkers')).toBe(
      'You covered 100 m playing checkers. Here is the game.',
    );
    expect(recordExplanation('checkers')).toMatch(/^A PDN is the standard checkers file/);
    const card = shareCard(report, 'w')!;
    expect(card.title).toBe('SATELLITE CHECKERS');
    expect(card.game).toBe('A game of Satellite Checkers');
  });

  it('draws each carry through its hops, inked as the dark pieces for Black', () => {
    const carries = straightCarries(report, 'checkers');
    const withHops = report.moves.filter((m) => m.lift && m.place && (m.via ?? []).length > 0).length;
    expect(carries.filter((c) => c.via !== undefined)).toHaveLength(withHops);
    for (const carry of carries) expect(carry.dark ?? carry.color === 'b').toBe(carry.color === 'w');
    // Chess carries are what they were: no `dark`, no `via`.
    for (const carry of straightCarries(report)) {
      expect(carry).not.toHaveProperty('dark');
    }
  });
});

describe('the words that named chess', () => {
  it('invites to the game being played, and to chess as before', () => {
    const invite = { url: 'u', code: 'ABC123', fieldName: 'Park' };
    expect(inviteShareData(invite).text).toBe('Come and play chess on a real field at Park. Join code ABC 123.');
    expect(inviteShareData(invite).title).toBe('A game of Satellite Chess');
    expect(inviteShareData({ ...invite, gameType: 'checkers' }).text).toBe(
      'Come and play checkers on a real field at Park. Join code ABC 123.',
    );
  });

  it('says what made the walking stop and start', () => {
    expect(distanceHonesty('chess')).toBe(DISTANCE_HONESTY);
    expect(distanceHonesty('checkers')[1]).toMatch(/which checkers makes you do at every move\.$/);
    expect(distanceHonesty('chess and checkers')[1]).toMatch(/which chess and checkers make you do at every move\.$/);
  });
});

describe('the record, split by game', () => {
  function row(i: number, random: () => number): RecordGame {
    const type = random() < 0.5 ? undefined : 'checkers';
    const outcome = (['1-0', '0-1', '1/2-1/2'] as const)[Math.floor(random() * 3)]!;
    return {
      joinCode: `G${i}`,
      color: random() < 0.5 ? 'w' : 'b',
      ...(type === undefined ? {} : { gameType: type }),
      outcome,
      reason: 'agreement',
      finishedAt: i,
      plies: random() < 0.1 ? 0 : 10,
      moves: 5,
      travelM: random() < 0.1 ? null : 100,
      longestCarryM: 5,
      fieldName: null,
      fieldKey: 'k',
      squareM: random() < 0.1 ? 1 : 8,
      boardM: 64,
      diagonalM: 90,
      pairId: random() < 0.5 ? 'a'.repeat(32) : 'b'.repeat(32),
      opponentTravelM: 50,
    };
  }

  it('leaves an all-chess record as it was', () => {
    const random = rng(1);
    const games = Array.from({ length: 20 }, (_, i) => ({ ...row(i, random), gameType: undefined }));
    expect(summarizeRecord(games)).not.toHaveProperty('byGame');
    expect(tallyByGame(games)).toBeUndefined();
  });

  it('adds up to the totals, game by game (a sweep)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = rng(seed);
      const games = Array.from({ length: 1 + Math.floor(random() * 25) }, (_, i) => row(i, random));
      const record = summarizeRecord(games);
      const split = record.byGame ?? [];
      if (split.length > 0) {
        const sum = (key: 'games' | 'wins' | 'draws' | 'losses') => split.reduce((n, t) => n + t[key], 0);
        expect(sum('games')).toBe(record.totals.games);
        expect(sum('wins')).toBe(record.totals.wins);
        expect(sum('draws')).toBe(record.totals.draws);
        expect(sum('losses')).toBe(record.totals.losses);
        // The words show each game's own figures and nothing else.
        const words = resultsByGameWords(split);
        for (const tally of split) expect(words).toContain(`${tally.wins} won · ${tally.draws} drawn · ${tally.losses} lost`);
      } else {
        // No split: every counted game was chess.
        expect(games.filter((g) => standingOf(g) === 'counted').every((g) => g.gameType === undefined)).toBe(true);
      }
      const head = summarizeHeadToHead(games);
      for (const tally of head.opponents) {
        const parts = tally.byGame ?? [];
        if (parts.length === 0) continue;
        expect(parts.reduce((n, t) => n + t.games, 0)).toBe(tally.games);
        expect(parts.reduce((n, t) => n + t.wins, 0)).toBe(tally.wins);
        expect(parts.reduce((n, t) => n + t.losses, 0)).toBe(tally.losses);
        expect(opponentDetail(games, tally.id)?.opponent.byGame).toEqual(parts);
      }
    }
  });

  it('says what was played, and labels a checkers line', () => {
    expect(playedWords(undefined)).toBe('chess');
    expect(playedWords([{ gameType: 'chess', games: 1, wins: 1, draws: 0, losses: 0 }, { gameType: 'checkers', games: 1, wins: 0, draws: 0, losses: 1 }])).toBe(
      'chess and checkers',
    );
    expect(
      lineWords({ joinCode: 'A', gameType: 'checkers', result: 'win', reason: 'no_moves', standing: 'counted', finishedAt: 0, fieldName: 'Park', travelM: 100, squareM: 8 }).detail,
    ).toBe('Checkers · Won — no moves left · 100 m');
  });
});

describe('the pieces', () => {
  it('crowns a king, and never a man, in both looks and for both seats', () => {
    for (const look of ['standard', 'disc'] as const) {
      for (const color of ['w', 'b'] as const) {
        const crown = (type: string) => shapesOf({ type, color }, look).some((s) => s.kind === 'path');
        expect(crown('k')).toBe(true);
        expect(crown('m')).toBe(false);
        expect(pieceSvg({ type: 'k', color }, look)).toContain(`data-piece="${color}k"`);
      }
    }
  });

  it('paints the `w` seat dark: checkers’ Black moves first', () => {
    const fill = (color: Color) => (shapesOf({ type: 'm', color }, 'disc')[0] as { fill: string }).fill;
    const lum = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(lum(fill('w'))).toBeLessThan(lum(fill('b')));
  });

  it('carries the PDN writer, not the PGN one', () => {
    const { report } = randomGame(2, { jumpsRequired: false });
    expect(CHECKERS_ART.writeRecord(report)).toContain('[GameType "21"]');
    expect(CHECKERS_ART.recordFileName(report)).toMatch(/\.pdn$/);
  });
});

describe('a lift refused because another piece must jump', () => {
  it('says why, when jumps are required', () => {
    // w to move: g1 can step, but a1 can jump b2.
    const state = position('w', ['g1', 'a1'], ['b2', 'h8']);
    expect(R.stops(state, { from: 'g1', via: [] }, { jumpsRequired: true }).places).toEqual([]);
    expect(R.whyStuck?.(state, 'g1', { jumpsRequired: true })).toMatch(/^Jumps are required, and another of your pieces can jump/);
    expect(R.whyStuck?.(state, 'g1', { jumpsRequired: false })).toBeNull();
    // A piece that is simply blocked is not told about jumps.
    const blocked = position('w', ['a1'], ['b2', 'c3']);
    expect(R.whyStuck?.(blocked, 'a1', { jumpsRequired: true })).toBeNull();
    expect(CHESS_RULES.whyStuck).toBeUndefined();
  });
});
