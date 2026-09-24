import { describe, expect, it } from 'vitest';

import type { GameReport } from '../src/shared/review.js';
import { ARCHIVE_VERSION, archiveKey, fromArchive, toArchive } from '../src/worker/archive.js';

/**
 * The archive's codec (decision 0042): what goes into the one KV value a
 * finished game leaves behind, and what is refused on the way back out. The
 * write and the read against a real namespace are in
 * `test/worker/archive.test.ts`.
 */

const REPORT: GameReport = {
  joinCode: 'ABC123',
  fieldName: 'The common',
  startedAt: 1,
  finishedAt: 2,
  outcome: '1-0',
  reason: 'resignation',
  initialMs: 900_000,
  incrementMs: 10_000,
  squareM: 8,
  boardM: 64,
  diagonalM: 90.5,
  travelM: { w: 420, b: null },
  moves: [
    {
      seq: 1,
      color: 'w',
      san: 'e4',
      uci: 'e2e4',
      from: 'e2',
      to: 'e4',
      carriedM: 16.4,
      carriedMs: 31_000,
      lift: { file: 4.1, rank: 1, accuracyM: 5 },
      place: null,
    },
  ],
};

describe('the stored value', () => {
  it('is the file and the report, without the join code', () => {
    const stored = toArchive(REPORT, '[Event "Satellite Chess"]', 99);
    expect(stored.v).toBe(ARCHIVE_VERSION);
    expect(stored.archivedAt).toBe(99);
    expect(stored.pgn).toBe('[Event "Satellite Chess"]');
    expect(stored.report).not.toHaveProperty('joinCode');
    expect(JSON.stringify(stored)).not.toContain('ABC123');
  });

  it('keeps only the fields it names, so nothing a report grows later leaks in', () => {
    const grown = {
      ...REPORT,
      fieldSnapshot: { a1: { lat: 51.4, lng: -0.1 } },
      moves: [{ ...REPORT.moves[0]!, liftLat: 51.4, lift: { ...REPORT.moves[0]!.lift!, lat: 51.4 } }],
    } as unknown as GameReport;
    const text = JSON.stringify(toArchive(grown, '', 0));
    expect(text).not.toMatch(/lat|lng|snapshot/i);
    expect(text).not.toContain('51.4');
  });

  it('reads back as the report it was made from, with the code put back', () => {
    const stored = JSON.parse(JSON.stringify(toArchive(REPORT, 'pgn', 5)));
    expect(fromArchive(stored, 'ABC123')).toEqual({ archivedAt: 5, pgn: 'pgn', report: REPORT });
  });

  it('refuses anything it does not recognise, rather than half-reading it', () => {
    const stored = toArchive(REPORT, 'pgn', 5);
    expect(fromArchive(null, 'X')).toBeNull();
    expect(fromArchive('text', 'X')).toBeNull();
    expect(fromArchive({ ...stored, v: 2 }, 'X')).toBeNull();
    expect(fromArchive({ ...stored, pgn: 7 }, 'X')).toBeNull();
    expect(fromArchive({ ...stored, report: { ...stored.report, moves: null } }, 'X')).toBeNull();
    expect(fromArchive({ ...stored, report: { ...stored.report, travelM: null } }, 'X')).toBeNull();
  });

  it('lives under a versioned key named by the code', () => {
    expect(archiveKey('ABC123')).toBe('game/v1/ABC123');
  });
});
