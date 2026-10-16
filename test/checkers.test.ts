import { describe, expect, it } from 'vitest';

import { descriptorFor, descriptorOf } from '../src/shared/games/catalog.js';
import {
  CHECKERS,
  CHECKERS_START,
  type CheckersMan,
  applyCheckersMove,
  formatCheckers,
  hopsOf,
  parseCheckers,
  pdnNumber,
  pdnSquare,
} from '../src/shared/games/checkers.js';
import type { CarryPath, GameOptions } from '../src/shared/games/types.js';
import { parseGameType } from '../src/shared/games/types.js';
import { distanceM, fromLocal, pathLengthM } from '../src/shared/geo.js';
import { buildPdn, pdnFileName } from '../src/shared/pdn.js';
import type { GameReport } from '../src/shared/review.js';
import { type Color, type Square, fromSquare, toSquare } from '../src/shared/squares.js';
import { CHECKERS_RULES as R } from '../src/worker/games/checkers.js';
import { rulesFor } from '../src/worker/games/index.js';

/**
 * Checkers' rules on the server (stage 11.2, decision 0057): American
 * checkers, each hop of a jump walked, "jumps are required" off by default,
 * and PDN.
 */

const OFF: GameOptions = { jumpsRequired: false };
const ON: GameOptions = { jumpsRequired: true };

/** A position from square lists: `K` before a king. `w` is the side that moves first. */
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

/** A piece map's entries and values, every one present. */
const entries = <T>(map: Partial<Record<string, T>>): [string, T][] =>
  Object.entries(map).filter((e): e is [string, T] => e[1] !== undefined);
const values = <T>(map: Partial<Record<string, T>>): T[] => entries(map).map(([, v]) => v);

const path = (from: string, ...via: string[]): CarryPath => ({ from: from as Square, via: via as Square[] });

/** A small seeded generator, so a failure names a game that can be replayed. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const DARK: Square[] = [];
for (let rank = 0; rank < 8; rank++) {
  for (let file = 0; file < 8; file++) if ((file + rank) % 2 === 0) DARK.push(toSquare(file, rank));
}

describe('the checkers descriptor', () => {
  it('is a game the server and the phone both know', () => {
    expect(parseGameType('checkers')).toBe('checkers');
    expect(rulesFor('checkers')).toBe(R);
    expect(descriptorOf('checkers')).toBe(CHECKERS);
    expect(descriptorFor('checkers')).toBe(CHECKERS);
    expect(CHECKERS.waypoints).toBe(true);
    expect(CHECKERS.record).toMatchObject({ name: 'PDN', extension: 'pdn' });
    expect(CHECKERS.options).toEqual([
      { key: 'jumpsRequired', kind: 'boolean', default: false, label: 'Jumps are required' },
    ]);
  });

  it('plays the dark squares only, a1 among them', () => {
    expect(DARK).toHaveLength(32);
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        expect(CHECKERS.lattice.playable(file, rank)).toBe(DARK.includes(toSquare(file, rank)));
      }
    }
    expect(CHECKERS.lattice.playable(0, 0)).toBe(true);
  });

  it('numbers the dark squares 1 to 32 from the first player\'s side, as PDN does', () => {
    const numbers = DARK.map((sq) => pdnNumber(sq));
    expect(new Set(numbers).size).toBe(32);
    for (const sq of DARK) expect(pdnSquare(pdnNumber(sq)!)).toBe(sq);
    for (let n = 1; n <= 32; n++) expect(pdnNumber(pdnSquare(n)!)).toBe(n);
    expect(pdnNumber('a2')).toBeNull();
    expect(pdnSquare(0)).toBeNull();
    expect(pdnSquare(33)).toBeNull();
    // The single corner on the first player's left is 4; 1 and 5 are the
    // double corner on their right; the far row is 29–32.
    expect([pdnSquare(1), pdnSquare(4), pdnSquare(5), pdnSquare(29), pdnSquare(32)]).toEqual([
      'g1',
      'a1',
      'h2',
      'h8',
      'b8',
    ]);
    // The classic opening 11-15 is a forward diagonal step.
    expect([pdnSquare(11), pdnSquare(15)]).toEqual(['c3', 'd4']);
  });

  it('starts with twelve men a side, the first player on ranks 1 to 3, and it to move', () => {
    const start = parseCheckers(CHECKERS_START);
    expect(start.turn).toBe('w');
    expect(formatCheckers(start)).toBe(CHECKERS_START);
    expect(CHECKERS.initialState(OFF)).toBe(CHECKERS_START);
    const pieces = entries(CHECKERS.piecesOf(CHECKERS_START));
    expect(pieces).toHaveLength(24);
    for (const [sq, piece] of pieces) {
      const { rank } = fromSquare(sq as Square);
      expect(piece.type).toBe('m');
      expect(piece.color).toBe(rank <= 2 ? 'w' : 'b');
      expect(rank <= 2 || rank >= 5).toBe(true);
    }
    expect(CHECKERS.pieceAt(CHECKERS_START, 'c3')).toEqual({ type: 'm', color: 'w' });
    expect(CHECKERS.pieceAt(CHECKERS_START, 'd4')).toBeNull();
    expect(CHECKERS.startZone('w')).toContain('a1');
    expect(CHECKERS.startZone('b')).toContain('h8');
  });

  it('reads PDN ranges and kings, and writes them back as lists', () => {
    const read = parseCheckers('W:W21-23,K32:BK1,5');
    expect(read.turn).toBe('b');
    expect(read.board.get(pdnSquare(22)!)).toEqual({ color: 'b', king: false });
    expect(read.board.get(pdnSquare(32)!)).toEqual({ color: 'b', king: true });
    expect(read.board.get(pdnSquare(1)!)).toEqual({ color: 'w', king: true });
    expect(formatCheckers(read)).toBe('W:W21,22,23,K32:BK1,5');
    // Nonsense is no board rather than a throw.
    expect(parseCheckers('garbage').board.size).toBe(0);
  });

  it('asks nothing as a piece goes down: crowning is automatic', () => {
    expect(CHECKERS.choices).toEqual([]);
    expect(CHECKERS.asksChoice({ type: 'm', color: 'w' }, 'b8')).toBe(false);
    expect(CHECKERS.choiceOf('c3d4')).toBeUndefined();
  });

  it('settles its one option: anything but a literal true is off', () => {
    expect(R.normaliseOptions({})).toEqual(OFF);
    expect(R.normaliseOptions(undefined)).toEqual(OFF);
    expect(R.normaliseOptions({ jumpsRequired: 'yes', other: true })).toEqual(OFF);
    expect(R.normaliseOptions({ jumpsRequired: true })).toEqual(ON);
  });
});

describe('checkers moves', () => {
  it('opens with the seven moves of American checkers', () => {
    let count = 0;
    for (const [sq, piece] of entries(CHECKERS.piecesOf(CHECKERS_START))) {
      if (piece.color !== 'w') continue;
      const next = R.stops(CHECKERS_START, path(sq), OFF);
      expect(next.waypoints).toEqual([]);
      count += next.places.length;
    }
    expect(count).toBe(7);
  });

  it('moves a man forward only, and a king both ways', () => {
    const state = position('w', ['c3', 'Kf4'], ['h8']);
    expect(R.stops(state, path('c3'), OFF).places.sort()).toEqual(['b4', 'd4']);
    expect(R.stops(state, path('f4'), OFF).places.sort()).toEqual(['e3', 'e5', 'g3', 'g5']);
    const black = position('b', ['a1'], ['d6']);
    expect(R.stops(black, path('d6'), OFF).places.sort()).toEqual(['c5', 'e5']);
    // Not the mover's piece, or an empty square: nowhere.
    expect(R.stops(state, path('h8'), OFF)).toEqual({ waypoints: [], places: [] });
    expect(R.stops(state, path('d4'), OFF)).toEqual({ waypoints: [], places: [] });
  });

  it('lets a plain move be made beside a jump with jumps not required, and not with them required', () => {
    const state = position('w', ['c3', 'g1'], ['d4']);
    expect(R.stops(state, path('c3'), OFF)).toEqual({ waypoints: [], places: ['e5', 'b4'] });
    expect(R.stops(state, path('c3'), ON)).toEqual({ waypoints: [], places: ['e5'] });
    // Another piece may not step while one can jump, with them required.
    expect(R.stops(state, path('g1'), OFF).places.sort()).toEqual(['f2', 'h2']);
    expect(R.stops(state, path('g1'), ON)).toEqual({ waypoints: [], places: [] });
    expect(R.play(state, path('g1'), 'f2', undefined, ON)).toBeNull();
    expect(R.play(state, path('c3'), 'b4', undefined, ON)).toBeNull();
    expect(R.play(state, path('c3'), 'b4', undefined, OFF)).not.toBeNull();
  });

  it('walks a double jump hop by hop, and lets it stop early only with jumps not required', () => {
    const state = position('w', ['c3'], ['d4', 'f6', 'b8']);
    // At the lift: e5 goes on, so it is a waypoint; with jumps not required it
    // is also somewhere to stop.
    expect(R.stops(state, path('c3'), OFF)).toEqual({ waypoints: ['e5'], places: ['e5', 'b4'] });
    expect(R.stops(state, path('c3'), ON)).toEqual({ waypoints: ['e5'], places: [] });
    // After the first hop: g7 ends it; with jumps not required, so may e5.
    expect(R.stops(state, path('c3', 'e5'), OFF)).toEqual({ waypoints: [], places: ['g7', 'e5'] });
    expect(R.stops(state, path('c3', 'e5'), ON)).toEqual({ waypoints: [], places: ['g7'] });

    const full = R.play(state, path('c3', 'e5'), 'g7', undefined, ON)!;
    expect(full.notation).toBe(`${pdnNumber('c3')}x${pdnNumber('e5')}x${pdnNumber('g7')}`);
    expect(full.notation).toBe('11x18x25');
    expect(full.uci).toBe('c3e5g7');
    expect(full).toMatchObject({ from: 'c3', to: 'g7' });
    expect(CHECKERS.piecesOf(full.state)).toEqual({
      g7: { type: 'm', color: 'w' },
      b8: { type: 'm', color: 'b' },
    });
    expect(parseCheckers(full.state).turn).toBe('b');

    // Stopped after the first hop, either by placing on it straight from the
    // lift or by placing where the last waypoint already stood.
    for (const stopped of [
      R.play(state, path('c3'), 'e5', undefined, OFF)!,
      R.play(state, path('c3', 'e5'), 'e5', undefined, OFF)!,
    ]) {
      expect(stopped.notation).toBe('11x18');
      expect(stopped.uci).toBe('c3e5');
      expect(CHECKERS.piecesOf(stopped.state)).toEqual({
        e5: { type: 'm', color: 'w' },
        f6: { type: 'm', color: 'b' },
        b8: { type: 'm', color: 'b' },
      });
    }
    expect(R.play(state, path('c3'), 'e5', undefined, ON)).toBeNull();
    expect(R.play(state, path('c3', 'e5'), 'e5', undefined, ON)).toBeNull();
    // A hop that is not a jump, or a waypoint that skips one, is nothing.
    expect(R.stops(state, path('c3', 'g7'), OFF)).toEqual({ waypoints: [], places: [] });
    expect(R.play(state, path('c3'), 'g7', undefined, OFF)).toBeNull();
  });

  it('ends the move of a man crowned mid-jump, even where a king could jump on', () => {
    const state = position('w', ['b6'], ['a7', 'c7', 'e7', 'a1']);
    // From d8 a king could take e7, but the man is crowned there and stops.
    for (const options of [OFF, ON]) {
      expect(R.stops(state, path('b6'), options)).toEqual({ waypoints: [], places: ['d8'] });
      // Never a waypoint, so never walked as one; were it, the move ends there.
      expect(R.stops(state, path('b6', 'd8'), options)).toEqual({ waypoints: [], places: ['d8'] });
      const move = R.play(state, path('b6'), 'd8', undefined, options)!;
      expect(move.notation).toBe(`${pdnNumber('b6')}x${pdnNumber('d8')}`);
      expect(move.notation).toBe('24x31');
      expect(CHECKERS.pieceAt(move.state, 'd8')).toEqual({ type: 'k', color: 'w' });
      expect(CHECKERS.pieceAt(move.state, 'e7')).toEqual({ type: 'm', color: 'b' });
    }
    // A man crowned by a plain step is a king too.
    const step = R.play(position('b', ['Kh8'], ['d2']), path('d2'), 'c1', undefined, OFF)!;
    expect(step.notation).toBe(`${pdnNumber('d2')}-${pdnNumber('c1')}`);
    expect(CHECKERS.pieceAt(step.state, 'c1')).toEqual({ type: 'k', color: 'b' });
  });

  it('never jumps a piece twice, and lets a king come back through its own square', () => {
    // A king on c3 can go round d4, f4, f2, d2 and land where it started.
    const state = position('w', ['Kc3'], ['d4', 'f4', 'f2', 'd2']);
    const first = R.stops(state, path('c3'), ON);
    expect(first.waypoints.sort()).toEqual(['e1', 'e5']);
    const around = path('c3', 'e5', 'g3', 'e1');
    expect(R.stops(state, around, ON)).toEqual({ waypoints: [], places: ['c3'] });
    const move = R.play(state, around, 'c3', undefined, ON)!;
    expect(move.notation.split('x')).toHaveLength(5);
    expect(CHECKERS.piecesOf(move.state)).toEqual({ c3: { type: 'k', color: 'w' } });
    // Back over d4 a second time is not offered.
    expect(R.stops(state, path('c3', 'e5', 'c3'), OFF)).toEqual({ waypoints: [], places: [] });
  });
});

describe('how a game of checkers ends', () => {
  it('loses for the side to move with no legal move, or with no pieces', () => {
    // Blocked: b2 cannot step onto a3 or c3, and cannot jump c3 onto d4.
    expect(R.ending(position('w', ['b2'], ['a3', 'c3', 'd4']), OFF)).toEqual({ outcome: '0-1', reason: 'no_moves' });
    expect(R.ending(position('w', [], ['a3']), OFF)).toEqual({ outcome: '0-1', reason: 'no_moves' });
    expect(R.ending(position('b', ['a3'], []), OFF)).toEqual({ outcome: '1-0', reason: 'no_moves' });
    // A jump is a move.
    expect(R.ending(position('w', ['b2'], ['a3', 'c3']), OFF)).toBeNull();
    expect(R.ending(CHECKERS_START, OFF)).toBeNull();
  });

  it('loses on time whatever is on the board', () => {
    expect(R.timeout(CHECKERS_START, 'w')).toEqual({ outcome: '0-1', reason: 'timeout' });
    expect(R.timeout(position('b', ['Ka1'], ['Kh8']), 'b')).toEqual({ outcome: '1-0', reason: 'timeout' });
  });
});

describe('random games of checkers (property)', () => {
  /** Every legal way to move the side to move, as carries. */
  function carries(state: string, options: GameOptions): { path: CarryPath; to: Square }[] {
    const out: { path: CarryPath; to: Square }[] = [];
    const walkFrom = (p: CarryPath) => {
      const next = R.stops(state, p, options);
      for (const to of next.places) out.push({ path: p, to });
      for (const w of next.waypoints) walkFrom({ from: p.from, via: [...p.via, w] });
    };
    const turn = parseCheckers(state).turn;
    for (const [sq, piece] of entries(CHECKERS.piecesOf(state))) {
      if (piece.color === turn) walkFrom(path(sq));
    }
    return out;
  }

  it('agrees with itself, with the phone\'s codec and with PDN, over many games', () => {
    let moves = 0;
    let jumps = 0;
    let multi = 0;
    let crowned = 0;
    let ended = 0;
    const wrong: string[] = [];
    for (let seed = 1; seed <= 120; seed++) {
      const rand = random(seed);
      const options = seed % 2 === 0 ? ON : OFF;
      let state = CHECKERS_START;
      for (let ply = 0; ply < 200; ply++) {
        const all = carries(state, options);
        const end = R.ending(state, options);
        // The game is over exactly when there is nothing to play.
        if ((end === null) !== all.length > 0) wrong.push(`seed ${seed} ply ${ply}: ending ${JSON.stringify(end)} with ${all.length} moves`);
        if (end !== null) {
          ended += 1;
          break;
        }
        const position_ = parseCheckers(state);
        const anyJump = all.some((c) => {
          const a = fromSquare(c.path.from);
          const b = fromSquare(hopsOf(c.path, c.to)[1]);
          return Math.abs(a.file - b.file) === 2;
        });
        const pick = all[Math.floor(rand() * all.length)];
        const move = R.play(state, pick.path, pick.to, undefined, options);
        if (move === null) {
          wrong.push(`seed ${seed} ply ${ply}: offered ${JSON.stringify(pick)} refused`);
          break;
        }
        // A square that was never offered is refused.
        const stray = DARK[Math.floor(rand() * DARK.length)];
        if (!R.stops(state, pick.path, options).places.includes(stray) && R.play(state, pick.path, stray, undefined, options) !== null) {
          wrong.push(`seed ${seed} ply ${ply}: stray ${stray} played`);
        }
        // The phone's codec draws exactly what the server played.
        if (CHECKERS.applyKnown(state, pick.path, pick.to) !== move.state) {
          wrong.push(`seed ${seed} ply ${ply}: codec ${applyCheckersMove(state, pick.path, pick.to)} != ${move.state}`);
        }
        // The notation names every square stood on, and the pieces taken are
        // exactly one per hop of a jump.
        const hops = hopsOf(pick.path, pick.to);
        const capture = move.notation.includes('x');
        const named = move.notation.split(capture ? 'x' : '-').map((n) => pdnSquare(Number(n)));
        if (JSON.stringify(named) !== JSON.stringify(hops)) wrong.push(`seed ${seed} ply ${ply}: ${move.notation} names ${named}`);
        if (move.uci !== hops.join('')) wrong.push(`seed ${seed} ply ${ply}: uci ${move.uci}`);
        const before = values(CHECKERS.piecesOf(state));
        const after = values(CHECKERS.piecesOf(move.state));
        const takenOf = (list: typeof before) => list.filter((p) => p.color !== position_.turn).length;
        if (takenOf(before) - takenOf(after) !== (capture ? hops.length - 1 : 0)) {
          wrong.push(`seed ${seed} ply ${ply}: wrong number taken`);
        }
        if (after.filter((p) => p.color === position_.turn).length !== before.filter((p) => p.color === position_.turn).length) {
          wrong.push(`seed ${seed} ply ${ply}: mover lost a piece`);
        }
        // With jumps required: a jump when there is one, and never stopped
        // while it could go on.
        if (options.jumpsRequired) {
          if (anyJump && !capture) wrong.push(`seed ${seed} ply ${ply}: skipped a required jump`);
          if (capture && R.stops(state, { from: pick.path.from, via: hops.slice(1) }, options).waypoints.length > 0) {
            wrong.push(`seed ${seed} ply ${ply}: stopped a jump that could go on`);
          }
        }
        // A man never steps backwards.
        const man = position_.board.get(pick.path.from)!;
        if (!man.king && !capture) {
          const dr = fromSquare(pick.to).rank - fromSquare(pick.path.from).rank;
          if (dr !== (man.color === 'w' ? 1 : -1)) wrong.push(`seed ${seed} ply ${ply}: man stepped ${dr}`);
        }
        if (!man.king && CHECKERS.pieceAt(move.state, move.to)?.type === 'k') crowned += 1;
        moves += 1;
        if (capture) jumps += 1;
        if (hops.length > 2 && capture) multi += 1;
        state = move.state;
        if (wrong.length > 5) break;
      }
      if (wrong.length > 5) break;
    }
    // One assertion over the whole sweep (`gotchas.md`).
    expect(wrong).toEqual([]);
    // And the sweep reached the cases it is for.
    expect(moves).toBeGreaterThan(2000);
    expect(jumps).toBeGreaterThan(300);
    expect(multi).toBeGreaterThan(10);
    expect(crowned).toBeGreaterThan(20);
    expect(ended).toBeGreaterThan(20);
  });
});

describe('a carry\'s length over its legs (property)', () => {
  it('is the sum of the legs: never less than the straight line, and the line itself for one leg', () => {
    const rand = random(7);
    const origin = { lat: 51.4779, lng: -0.0015 };
    const bad: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const n = 2 + Math.floor(rand() * 5);
      const points = Array.from({ length: n }, () =>
        fromLocal(origin, { e: (rand() - 0.5) * 120, n: (rand() - 0.5) * 120 }),
      );
      const total = pathLengthM(points);
      const straight = distanceM(points[0], points[n - 1]);
      if (total + 1e-9 < straight) bad.push(`${i}: ${total} < ${straight}`);
      if (n === 2 && Math.abs(total - straight) > 1e-9) bad.push(`${i}: one leg ${total} != ${straight}`);
      const split = pathLengthM(points.slice(0, 2)) + pathLengthM(points.slice(1));
      if (Math.abs(split - total) > 1e-6) bad.push(`${i}: not additive`);
    }
    expect(bad).toEqual([]);
    expect(pathLengthM([])).toBe(0);
    expect(pathLengthM([origin])).toBe(0);
  });
});

describe('the PDN file', () => {
  const report: GameReport = {
    joinCode: 'ABCDEF',
    gameType: 'checkers',
    options: { jumpsRequired: false },
    fieldName: 'Riverside "Park"',
    startedAt: Date.UTC(2026, 9, 15, 14, 5, 9),
    finishedAt: Date.UTC(2026, 9, 15, 14, 30),
    outcome: '1-0',
    reason: 'no_moves',
    initialMs: 600_000,
    incrementMs: 5_000,
    squareM: 8,
    boardM: 64,
    diagonalM: 90.5,
    travelM: { w: 812.4, b: null },
    moves: [
      {
        seq: 1,
        color: 'w',
        san: '11-15',
        uci: 'c3d4',
        from: 'c3',
        to: 'd4',
        carriedM: 11.3,
        carriedMs: 9_400,
        lift: { file: 2, rank: 2, accuracyM: 4 },
        place: { file: 3.1, rank: 3, accuracyM: 0 },
      },
      {
        seq: 2,
        color: 'b',
        san: '22x15x8',
        uci: 'f6d4b2',
        from: 'f6',
        to: 'b2',
        carriedM: 40,
        carriedMs: 30_000,
        lift: { file: 5, rank: 5, accuracyM: 3 },
        via: [{ file: 3, rank: 3.02, accuracyM: 3 }],
        place: { file: 1, rank: 1, accuracyM: 3 },
      },
    ],
  };

  it('opens as American checkers, says whether jumps were required, and walks each hop', () => {
    const pdn = buildPdn(report);
    expect(pdn).toContain('[Event "Satellite Checkers"]');
    expect(pdn).toContain('[Site "Riverside \\"Park\\""]');
    expect(pdn).toContain('[Date "2026.10.15"]');
    expect(pdn).toContain('[Result "1-0"]');
    expect(pdn).toContain('[GameType "21"]');
    expect(pdn).toContain('[TimeControl "600+5"]');
    expect(pdn).toContain('[SatelliteJumpsRequired "no"]');
    expect(pdn).toContain('[SatelliteEnd "no_moves"]');
    expect(pdn).toContain('[Termination "normal"]');
    expect(pdn).toContain('[SatelliteBlackWalkedM "812.4"]');
    expect(pdn).not.toContain('SatelliteWhiteWalkedM');
    expect(pdn).not.toContain('ABCDEF');
    const movetext = pdn.split('\n\n')[1].replace(/\n/g, ' ');
    expect(movetext).toContain('1. 11-15 {carry 11.3 m in 9.4 s; lift 2,2 acc 4 m; place 3.1,3}');
    expect(movetext).toContain('22x15x8 {carry 40 m in 30 s; lift 5,5 acc 3 m; via 3,3.02 acc 3 m; place 1,1 acc 3 m}');
    expect(movetext.trim().endsWith('1-0')).toBe(true);
    for (const line of pdn.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
    expect(buildPdn({ ...report, options: { jumpsRequired: true } })).toContain('[SatelliteJumpsRequired "yes"]');
    expect(R.writeRecord(report)).toBe(pdn);
  });

  it('is named for the day and the field, never the code', () => {
    expect(pdnFileName(report)).toBe('satellite-checkers-2026-10-15-riverside-park.pdn');
    expect(R.recordFileName(report)).toBe(pdnFileName(report));
  });
});
