import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import type { GameReport, ReportMove } from '../src/shared/review.js';
import {
  TRACK_MAX_FIXES,
  TRACK_MAX_SQUARES,
  type TrackFix,
  appendTrackText,
  decodeTrack,
  encodeTrackFix,
  isCarryingTag,
  plyOfTag,
  sanitizeTracks,
  trackTag,
} from '../src/shared/track.js';
import { fromSquare } from '../src/shared/squares.js';
import { moveWords } from '../src/client/review.js';
import {
  START_FEN,
  carryWords,
  clampPly,
  hasWalks,
  replayFens,
  replayFrame,
  replayHeadWords,
  squareAt,
  standingWords,
  walkNoteWords,
} from '../src/client/replay.js';
import { replayCarryHtml, reviewHtml } from '../src/client/views/review.js';
import { pgnOf } from '../src/client/review.js';

/**
 * The replay (stage 8.3, decision 0052): the track a game keeps, and what the
 * replay reads out of a report at each step.
 *
 * Every figure the replay shows beside a judgement has a property here from
 * the start — the square a player is said to be standing on contains the
 * point, the carry figure is the move list's own, the position is the one
 * chess.js reaches — because each display bug of the last phase was a figure
 * nobody had swept.
 */

/** A small seeded generator, so a failing sweep can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function move(overrides: Partial<ReportMove> = {}): ReportMove {
  return {
    seq: 1,
    color: 'w',
    san: 'e4',
    uci: 'e2e4',
    from: 'e2',
    to: 'e4',
    carriedM: 16,
    carriedMs: 8_000,
    lift: null,
    place: null,
    ...overrides,
  };
}

function report(moves: ReportMove[], tracks: GameReport['tracks'] = null): GameReport {
  return {
    joinCode: 'K7M2PQ',
    fieldName: null,
    startedAt: 0,
    finishedAt: 1,
    outcome: '0-1',
    reason: 'checkmate',
    initialMs: 600_000,
    incrementMs: 0,
    squareM: 8,
    boardM: 64,
    diagonalM: 90.5,
    travelM: { w: 100, b: 100 },
    moves,
    tracks,
  };
}

/** Fool's mate, with fixes, as a game would report it. */
const FOOLS: ReportMove[] = [
  move({ seq: 1, color: 'w', san: 'f3', uci: 'f2f3', from: 'f2', to: 'f3', lift: { file: 5, rank: 1.1, accuracyM: 3 }, place: { file: 5.02, rank: 2, accuracyM: 3 } }),
  move({ seq: 2, color: 'b', san: 'e5', uci: 'e7e5', from: 'e7', to: 'e5', lift: { file: 4, rank: 6, accuracyM: 3 }, place: { file: 4, rank: 4.1, accuracyM: 3 } }),
  move({ seq: 3, color: 'w', san: 'g4', uci: 'g2g4', from: 'g2', to: 'g4', lift: { file: 6, rank: 1, accuracyM: 3 }, place: { file: 6, rank: 3, accuracyM: 3 } }),
  move({ seq: 4, color: 'b', san: 'Qh4#', uci: 'd8h4', from: 'd8', to: 'h4', carriedM: 45.3, lift: { file: 3, rank: 7.4, accuracyM: 3 }, place: { file: 7, rank: 3, accuracyM: 3 } }),
];

describe('the track as stored (shared/track.ts)', () => {
  it('tags a fix with the move it belongs to and whether a piece was in hand', () => {
    for (let done = 0; done < 300; done++) {
      for (const carrying of [false, true]) {
        const tag = trackTag(done, carrying);
        expect(plyOfTag(tag)).toBe(done + 1);
        expect(isCarryingTag(tag)).toBe(carrying);
      }
    }
  });

  it('round-trips to a hundredth of a square, never further than half of one', () => {
    const random = rng(52);
    let text = '';
    const expected: [number, number, number][] = [];
    for (let i = 0; i < 2_000; i++) {
      const tag = Math.floor(random() * 200);
      const file = (random() - 0.5) * 40;
      const rank = (random() - 0.5) * 40;
      const fix = encodeTrackFix(tag, file, rank);
      expect(fix).not.toBeNull();
      text = appendTrackText(text, fix!);
      expected.push([tag, file, rank]);
    }
    const back = decodeTrack(text);
    expect(back).toHaveLength(expected.length);
    back.forEach(([tag, file, rank], i) => {
      const [t, f, r] = expected[i]!;
      expect(tag).toBe(t);
      expect(Math.abs(file - f)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(rank - r)).toBeLessThanOrEqual(0.005 + 1e-9);
      // Exactly the grain: nothing finer than a hundredth leaves.
      expect(Math.round(file * 100) / 100).toBe(file);
    });
  });

  it('drops what is not a place on or near the board', () => {
    expect(encodeTrackFix(0, Number.NaN, 1)).toBeNull();
    expect(encodeTrackFix(0, 1, Number.POSITIVE_INFINITY)).toBeNull();
    expect(encodeTrackFix(-1, 1, 1)).toBeNull();
    expect(encodeTrackFix(1.5, 1, 1)).toBeNull();
    expect(encodeTrackFix(0, TRACK_MAX_SQUARES + 1, 0)).toBeNull();
    expect(encodeTrackFix(0, TRACK_MAX_SQUARES, -TRACK_MAX_SQUARES)).toBe('0,10000,-10000');
  });

  it('reads a damaged track as the fixes that survive', () => {
    expect(decodeTrack('')).toEqual([]);
    expect(decodeTrack(null)).toEqual([]);
    expect(decodeTrack('0,100,200;junk;1,x,3;2,-50,750')).toEqual([
      [0, 1, 2],
      [2, -0.5, 7.5],
    ]);
  });

  it('rebuilds tracks from outside as three numbers a fix, and caps them', () => {
    expect(sanitizeTracks(null)).toBeNull();
    expect(sanitizeTracks({ w: [] })).toBeNull();
    expect(sanitizeTracks({ w: [[0, 1.234567, 2]], b: [[1, 2, 3, 4], 'x', [0.5, 1, 1]] })).toEqual({
      w: [[0, 1.23, 2]],
      b: [],
    });
    const long = Array.from({ length: TRACK_MAX_FIXES + 50 }, (): TrackFix => [0, 1, 1]);
    expect(sanitizeTracks({ w: long, b: [] })?.w).toHaveLength(TRACK_MAX_FIXES);
  });
});

describe('the position at each step', () => {
  it('is the position chess.js reaches, over random legal games with every special move', () => {
    const random = rng(8_3);
    const specials = { castle: 0, enPassant: 0, promotion: 0 };
    for (let game = 0; game < 80; game++) {
      const chess = new Chess();
      const moves: ReportMove[] = [];
      const truth: string[] = [START_FEN.split(' ')[0]!];
      for (let ply = 0; ply < 120; ply++) {
        const legal = chess.moves({ verbose: true });
        if (legal.length === 0) break;
        // Prefer the moves a rules-free replay is most likely to get wrong.
        const special = legal.filter((m) => /[kqep]/.test(m.flags));
        const pick = special.length > 0 && random() < 0.5 ? special : legal;
        const m = pick[Math.floor(random() * pick.length)]!;
        if (/[kq]/.test(m.flags)) specials.castle += 1;
        if (m.flags.includes('e')) specials.enPassant += 1;
        if (m.promotion) specials.promotion += 1;
        chess.move(m);
        moves.push(
          move({
            seq: ply + 1,
            color: m.color,
            san: m.san,
            uci: `${m.from}${m.to}${m.promotion ?? ''}`,
            from: m.from,
            to: m.to,
          }),
        );
        truth.push(chess.fen().split(' ')[0]!);
      }
      const fens = replayFens(report(moves));
      expect(fens.map((fen) => fen.split(' ')[0])).toEqual(truth);
    }
    // The sweep is worthless if it never castled, took en passant or promoted.
    expect(specials.castle).toBeGreaterThan(20);
    expect(specials.enPassant).toBeGreaterThan(10);
    expect(specials.promotion).toBeGreaterThan(10);
  }, 60_000);

  it('stops at a move that names an empty square rather than inventing a board', () => {
    const fens = replayFens(report([FOOLS[0]!, move({ seq: 2, color: 'b', from: 'e4', to: 'e5', uci: 'e4e5' })]));
    expect(fens).toHaveLength(2);
  });

  it('clamps the scrubber to a step that exists', () => {
    const random = rng(3);
    for (let i = 0; i < 10_000; i++) {
      const plies = Math.floor(random() * 50);
      const asked = (random() - 0.3) * 120;
      const ply = clampPly(asked, plies);
      expect(Number.isInteger(ply)).toBe(true);
      expect(ply).toBeGreaterThanOrEqual(0);
      expect(ply).toBeLessThanOrEqual(plies);
    }
    expect(clampPly(Number.NaN, 4)).toBe(0);
  });
});

describe('the walks at each step', () => {
  it('gives every fix to exactly one place in the drawing, and the earlier ones to earlier steps', () => {
    const random = rng(1234);
    for (let trial = 0; trial < 300; trial++) {
      const tracks = { w: [] as TrackFix[], b: [] as TrackFix[] };
      for (let done = 0; done < FOOLS.length; done++) {
        const mover = FOOLS[done]!.color;
        for (const color of ['w', 'b'] as const) {
          const n = Math.floor(random() * 5);
          for (let k = 0; k < n; k++) {
            const carrying = color === mover && random() < 0.5;
            tracks[color].push([trackTag(done, carrying), random() * 8, random() * 8]);
          }
        }
      }
      const r = report(FOOLS, tracks);
      const fens = replayFens(r);
      for (let ply = 1; ply <= FOOLS.length; ply++) {
        const frame = replayFrame(r, fens, ply);
        const mover = FOOLS[ply - 1]!.color;
        const other = mover === 'w' ? 'b' : 'w';
        const mine = tracks[mover].filter(([tag]) => plyOfTag(tag) === ply);
        const theirs = tracks[other].filter(([tag]) => plyOfTag(tag) === ply);
        // The mover's fixes are the approach and the carry, in order, with
        // nothing lost or doubled; the carry path adds only the two fixes
        // the move itself holds.
        // (Random fixes never land within a hundredth of the place, so the
        // carry is the lift, every fix in hand, the place.)
        const carried = frame.carry!.slice(1, -1);
        expect([...frame.approach, ...carried]).toEqual(
          [...mine.filter((f) => !carried.some((c) => c.file === f[1] && c.rank === f[2])), ...mine.filter((f) => carried.some((c) => c.file === f[1] && c.rank === f[2]))].map(([, file, rank]) => ({ file, rank })),
        );
        expect(frame.approach.length + carried.length).toBe(mine.length);
        expect(frame.waiting).toEqual(theirs.map(([, file, rank]) => ({ file, rank })));
        // Earlier lines hold exactly the fixes of earlier steps.
        for (const color of ['w', 'b'] as const) {
          const before = tracks[color].filter(([tag]) => plyOfTag(tag) < ply).length;
          expect(frame.earlier[color].flat()).toHaveLength(before);
        }
        // The carry runs from the lift to the place the move holds.
        expect(frame.carry![0]).toEqual({ file: FOOLS[ply - 1]!.lift!.file, rank: FOOLS[ply - 1]!.lift!.rank });
        expect(frame.carry![frame.carry!.length - 1]).toEqual({
          file: FOOLS[ply - 1]!.place!.file,
          rank: FOOLS[ply - 1]!.place!.rank,
        });
      }
    }
  });

  it('draws a carry straight from lift to place where no walk was kept', () => {
    const r = report(FOOLS, null);
    const frame = replayFrame(r, replayFens(r), 4);
    expect(frame.carry).toEqual([
      { file: 3, rank: 7.4 },
      { file: 7, rank: 3 },
    ]);
    expect(frame.approach).toEqual([]);
    expect(frame.waiting).toEqual([]);
    expect(hasWalks(r)).toBe(false);
    expect(walkNoteWords(r)).toMatch(/not kept/);
  });

  it('takes as the carry only what was in hand after the last empty-handed fix', () => {
    // Picked up, put back, walked, picked up another, carried, placed.
    const tracks = {
      w: [
        [trackTag(0, false), 1, 1],
        [trackTag(0, true), 1, 2],
        [trackTag(0, false), 4, 1],
        [trackTag(0, false), 5, 1.1],
        [trackTag(0, true), 5, 1.5],
        [trackTag(0, true), 5.02, 2],
      ] as TrackFix[],
      b: [],
    };
    const r = report([FOOLS[0]!], tracks);
    const frame = replayFrame(r, replayFens(r), 1);
    expect(frame.approach).toHaveLength(4);
    expect(frame.carry).toEqual([
      { file: 5, rank: 1.1 },
      { file: 5, rank: 1.5 },
      { file: 5.02, rank: 2 },
    ]);
  });

  it('shows nothing but the position at the start', () => {
    const r = report(FOOLS, { w: [[0, 1, 1]], b: [[0, 2, 7]] });
    const frame = replayFrame(r, replayFens(r), 0);
    expect(frame.move).toBeNull();
    expect(frame.carry).toBeNull();
    expect(frame.fen).toBe(START_FEN);
    expect(replayHeadWords(frame)).toBe('The start · 4 steps to go through');
  });
});

describe('the words beside the board', () => {
  it('names a square the point is inside, every time', () => {
    const random = rng(77);
    for (let i = 0; i < 200_000; i++) {
      // Weighted to the lines between squares, where a rounding slip lives.
      const edge = random() < 0.5;
      const base = Math.floor(random() * 10) - 1.5;
      const file = edge ? base + (random() < 0.5 ? 0 : 1e-12 * (random() - 0.5)) : (random() - 0.1) * 9;
      const rank = (random() - 0.1) * 9;
      const square = squareAt({ file, rank });
      const onBoard = file >= -0.5 && file < 7.5 && rank >= -0.5 && rank < 7.5;
      if (!onBoard) {
        expect(square).toBeNull();
        continue;
      }
      expect(square).not.toBeNull();
      const named = fromSquare(square!);
      expect(file).toBeGreaterThanOrEqual(named.file - 0.5);
      expect(file).toBeLessThan(named.file + 0.5);
      expect(rank).toBeGreaterThanOrEqual(named.rank - 0.5);
      expect(rank).toBeLessThan(named.rank + 0.5);
    }
    expect(squareAt({ file: -0.5, rank: -0.5 })).toBe('a1');
    expect(squareAt({ file: 7.5, rank: 0 })).toBeNull();
    expect(squareAt({ file: 0.5, rank: 0 })).toBe('b1');
  });

  it('says where the mover stood, or that nobody knows', () => {
    expect(standingWords({ file: 4.2, rank: 1.9, accuracyM: 3 })).toBe('standing on e3');
    expect(standingWords({ file: 4.2, rank: -0.9, accuracyM: 3 })).toBe('standing off the board');
    expect(standingWords(null)).toBe('no fix stored');
  });

  it('shows the carry figure the move list shows, for every carry, in both units', () => {
    const random = rng(9);
    for (let i = 0; i < 20_000; i++) {
      const m = move({
        carriedM: random() < 0.05 ? 0 : random() * random() * 3_000,
        carriedMs: random() < 0.05 ? 0 : random() * 600_000,
      });
      for (const units of ['metric', 'us'] as const) {
        const list = moveWords(m, units).detail;
        const words = carryWords(m, units)!;
        expect(words.carried.toLowerCase()).toBe(list.toLowerCase());
        // And the screen holds it as written, unit and all.
        const html = replayCarryHtml({ ...replayFrame(report([m]), [START_FEN, START_FEN], 1), move: m }, units);
        expect(html.replace(/&nbsp;/g, ' ')).toContain(words.carried);
      }
    }
  });

  it('reads a step the way a move list does, without a second numbering of moves', () => {
    const r = report(FOOLS);
    const fens = replayFens(r);
    expect(replayHeadWords(replayFrame(r, fens, 3))).toBe('Step 3 of 4 · 2. g4');
    expect(replayHeadWords(replayFrame(r, fens, 4))).toBe('Step 4 of 4 · 2… Qh4#');
    expect(carryWords(FOOLS[3]!, 'metric')).toEqual({
      who: 'Black moved d8 to h4',
      lift: 'Picked up standing on d8',
      carried: 'Carried 45 m in 8 s',
      place: 'Put down standing on h4',
    });
  });
});

describe('the replay on the review screen', () => {
  const pgn = { text: '', fileName: 'x.pgn' };

  it('opens on the last step, with the controls and every move as a way in', () => {
    const r = report(FOOLS, { w: [[0, 5, 1]], b: [] });
    const html = reviewHtml(r, 'b', pgn, 'K7M2PQ');
    expect(html).toContain('data-replay data-ply="4"');
    expect(html).toContain('max="4"');
    expect(html).toContain('data-replay-prev');
    expect(html).toContain('data-replay-next');
    expect(html).toContain('Step 4 of 4 · 2… Qh4#');
    for (let ply = 1; ply <= 4; ply++) expect(html).toContain(`data-replay-to="${ply}"`);
    // Above the list: the board is what a tap on a move shows.
    expect(html.indexOf('data-replay ')).toBeLessThan(html.indexOf('data-review-moves'));
  });

  it('has no replay for a game nobody moved in', () => {
    expect(reviewHtml(report([]), 'w', pgn, 'K7M2PQ')).not.toContain('data-replay');
  });

  it('never puts a walk in the file that travels', () => {
    const tracks = { w: [[0, 1.37, 2.71]] as TrackFix[], b: [[1, 6.43, 5.19]] as TrackFix[] };
    const walked = pgnOf(report(FOOLS, tracks)).text;
    expect(walked).toBe(pgnOf(report(FOOLS, null)).text);
    expect(walked).not.toContain('1.37');
    expect(walked).not.toContain('6.43');
  });
});
