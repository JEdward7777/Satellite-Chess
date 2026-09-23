import { describe, expect, it } from 'vitest';

import {
  PGN_EVENT,
  PGN_LEGEND,
  buildPgn,
  moveComment,
  pgnFileName,
  resultToken,
  termination,
} from '../src/shared/pgn.js';
import type { GameReport, ReportMove } from '../src/shared/review.js';

/**
 * The PGN (stage 8.1): a file any chess program opens, carrying a walk no other
 * chess program has.
 *
 * Two properties matter more than any individual string here, and both have a
 * test of their own at the bottom: **nothing in the file is a coordinate**
 * (decision 0041), and **the join code is in neither the file nor the filename**
 * (O-34).
 */

const STARTED = Date.UTC(2026, 8, 23, 14, 5, 9);

function move(overrides: Partial<ReportMove> = {}): ReportMove {
  return {
    seq: 1,
    color: 'w',
    san: 'e4',
    uci: 'e2e4',
    from: 'e2',
    to: 'e4',
    carriedM: 12.44,
    carriedMs: 31_200,
    lift: { file: 4.2, rank: 0.1, accuracyM: 5 },
    place: { file: 4.2, rank: 2.9, accuracyM: 4 },
    ...overrides,
  };
}

function report(overrides: Partial<GameReport> = {}): GameReport {
  return {
    joinCode: 'K7M2PQ',
    fieldName: 'Riverside Park',
    startedAt: STARTED,
    finishedAt: STARTED + 1_800_000,
    outcome: '0-1',
    reason: 'checkmate',
    initialMs: 600_000,
    incrementMs: 5_000,
    squareM: 8,
    boardM: 64,
    diagonalM: 64 * Math.SQRT2,
    travelM: { w: 412.5, b: 388.25 },
    moves: [move()],
    ...overrides,
  };
}

/** Every tag pair in the file, in order. */
function tags(pgn: string): [string, string][] {
  return [...pgn.matchAll(/^\[(\w+) "((?:[^"\\]|\\.)*)"\]$/gm)].map((m) => [m[1]!, m[2]!]);
}

function tag(pgn: string, name: string): string | undefined {
  return tags(pgn).find(([key]) => key === name)?.[1];
}

/** The movetext: everything after the blank line that ends the tag pairs. */
function movetext(pgn: string): string {
  return pgn.slice(pgn.indexOf('\n\n') + 2);
}

describe('the tag pairs', () => {
  it('leads with the seven-tag roster, in the standard order', () => {
    const names = tags(buildPgn(report())).map(([name]) => name);
    expect(names.slice(0, 7)).toEqual([
      'Event',
      'Site',
      'Date',
      'Round',
      'White',
      'Black',
      'Result',
    ]);
  });

  it('names the event and the field, and nobody else', () => {
    const pgn = buildPgn(report());
    expect(tag(pgn, 'Event')).toBe(PGN_EVENT);
    expect(tag(pgn, 'Site')).toBe('Riverside Park');
    // The opponent is never named, here or anywhere (decision 0040).
    expect(tag(pgn, 'White')).toBe('?');
    expect(tag(pgn, 'Black')).toBe('?');
  });

  it('dates the game in UTC, from when it started', () => {
    const pgn = buildPgn(report());
    expect(tag(pgn, 'Date')).toBe('2026.09.23');
    expect(tag(pgn, 'UTCDate')).toBe('2026.09.23');
    expect(tag(pgn, 'UTCTime')).toBe('14:05:09');
  });

  it('writes the time control in seconds, and "?" for one nobody stored', () => {
    expect(tag(buildPgn(report()), 'TimeControl')).toBe('600+5');
    // A game created before the starting time had a column of its own: its
    // clocks hold what is left, which is not what they began with.
    expect(tag(buildPgn(report({ initialMs: null })), 'TimeControl')).toBe('?');
  });

  it('says how it ended twice: the standard word, and our own', () => {
    const pgn = buildPgn(report());
    expect(tag(pgn, 'Termination')).toBe('normal');
    expect(tag(pgn, 'SatelliteEnd')).toBe('checkmate');
    expect(tag(buildPgn(report({ reason: 'timeout' })), 'Termination')).toBe('time forfeit');
    expect(tag(buildPgn(report({ reason: 'abandoned' })), 'Termination')).toBe('abandoned');
    expect(termination('agreement')).toBe('normal');
    expect(termination('resignation')).toBe('normal');
  });

  it('carries the board and each player’s walk', () => {
    const pgn = buildPgn(report());
    expect(tag(pgn, 'SatelliteBoardM')).toBe('64');
    expect(tag(pgn, 'SatelliteSquareM')).toBe('8');
    expect(tag(pgn, 'SatelliteWhiteWalkedM')).toBe('412.5');
    expect(tag(pgn, 'SatelliteBlackWalkedM')).toBe('388.3');
  });

  it('omits an unmeasured distance rather than writing it as zero', () => {
    // A zero is a claim that somebody walked nowhere; null is nobody measuring
    // (decision 0040, rule 7). The tag is simply absent.
    const pgn = buildPgn(report({ travelM: { w: null, b: 388.25 } }));
    expect(tag(pgn, 'SatelliteWhiteWalkedM')).toBeUndefined();
    expect(tag(pgn, 'SatelliteBlackWalkedM')).toBe('388.3');
    expect(pgn).not.toContain('SatelliteWhiteWalkedM');
  });

  it('escapes a field name a player typed', () => {
    const pgn = buildPgn(report({ fieldName: 'The "back\\field"' }));
    expect(tag(pgn, 'Site')).toBe('The \\"back\\\\field\\"');
    // Whatever they typed, the file still parses as a tag pair per line.
    expect(tags(pgn).length).toBeGreaterThan(7);
  });

  it('falls back to "?" for a field nobody named', () => {
    expect(tag(buildPgn(report({ fieldName: null })), 'Site')).toBe('?');
  });
});

describe('the movetext', () => {
  it('opens with the legend, so the numbers mean something a year later', () => {
    // Wrapped across lines like any other comment, so it is compared unwrapped.
    expect(movetext(buildPgn(report())).replace(/\s+/g, ' ')).toContain(`{${PGN_LEGEND}}`);
    expect(PGN_LEGEND).toContain('squares from the center of a1');
  });

  it('numbers the moves and ends with the result token', () => {
    const pgn = buildPgn(
      report({
        moves: [
          move({ seq: 1, color: 'w', san: 'f3' }),
          move({ seq: 2, color: 'b', san: 'e5' }),
          move({ seq: 3, color: 'w', san: 'g4' }),
          move({ seq: 4, color: 'b', san: 'Qh4#' }),
        ],
      }),
    );
    const text = movetext(pgn).replace(/\s+/g, ' ');
    expect(text).toContain('1. f3');
    expect(text).toContain('2. g4');
    expect(text).toContain('Qh4#');
    expect(text.trimEnd().endsWith('0-1')).toBe(true);
  });

  it('writes "*" for a game that is still going', () => {
    const unfinished = report({ outcome: null, reason: null, finishedAt: null });
    const pgn = buildPgn(unfinished);
    expect(resultToken(unfinished)).toBe('*');
    expect(tag(pgn, 'Result')).toBe('*');
    expect(movetext(pgn).trimEnd().endsWith('*')).toBe(true);
    // No result means no way to say how it ended, so neither tag appears.
    expect(tag(pgn, 'Termination')).toBeUndefined();
    expect(tag(pgn, 'SatelliteEnd')).toBeUndefined();
  });

  it('uses the "12..." form for a black move with no white move before it', () => {
    const pgn = buildPgn(report({ moves: [move({ seq: 24, color: 'b', san: 'Qh4' })] }));
    expect(movetext(pgn).replace(/\s+/g, ' ')).toContain('12... Qh4');
  });

  it('keeps every line inside eighty columns', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      move({ seq: i + 1, color: i % 2 === 0 ? 'w' : 'b', san: i % 2 === 0 ? 'Nf3' : 'Nc6' }),
    );
    for (const line of buildPgn(report({ moves: many })).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it('puts the walk in a comment the standard lets a reader skip', () => {
    expect(moveComment(move())).toBe(
      '{carry 12.4 m in 31.2 s; lift 4.2,0.1 acc 5 m; place 4.2,2.9 acc 4 m}',
    );
  });

  it('says nothing about a move with no walk and no fix', () => {
    expect(moveComment(move({ carriedM: 0, carriedMs: 0, lift: null, place: null }))).toBeNull();
  });

  it('leaves the accuracy out of a fix that claimed none', () => {
    const comment = moveComment(
      move({ carriedM: 0, carriedMs: 0, place: null, lift: { file: 1, rank: 2, accuracyM: 0 } }),
    );
    expect(comment).toBe('{lift 1,2}');
  });
});

describe('what is deliberately not in the file', () => {
  it('holds no coordinates anywhere — positions are squares, never degrees', () => {
    // The hazard decisions 0017, 0018 and 0041 exist to avoid: a PGN travels
    // through a share sheet, and a latitude in one is a disclosure of a place
    // somebody stands regularly.
    const pgn = buildPgn(report());
    expect(pgn).not.toMatch(/\blat\b|\blng\b|\blatitude\b|\blongitude\b/i);
    // Nothing in this file has the shape of a coordinate pair, either: the only
    // numbers are squares, meters and seconds.
    expect(pgn).not.toMatch(/-?\d{1,3}\.\d{4,}/);
  });

  it('holds no join code, which is a live pointer at a field (O-34)', () => {
    const pgn = buildPgn(report());
    expect(pgn).not.toContain('K7M2PQ');
    expect(pgnFileName(report())).not.toContain('K7M2PQ');
  });

  it('names the file by the date and the field', () => {
    expect(pgnFileName(report())).toBe('satellite-chess-2026-09-23-riverside-park.pgn');
    expect(pgnFileName(report({ fieldName: null }))).toBe('satellite-chess-2026-09-23.pgn');
    // A name that slugs to nothing leaves the date on its own rather than a
    // trailing dash.
    expect(pgnFileName(report({ fieldName: '!!!' }))).toBe('satellite-chess-2026-09-23.pgn');
  });

  it('keeps a long or awkward field name to something a filesystem accepts', () => {
    const name = pgnFileName(report({ fieldName: 'A'.repeat(80) }));
    expect(name).toMatch(/^satellite-chess-2026-09-23-a{40}\.pgn$/);
    expect(pgnFileName(report({ fieldName: 'Regent’s Park / East' }))).toBe(
      'satellite-chess-2026-09-23-regent-s-park-east.pgn',
    );
  });
});
