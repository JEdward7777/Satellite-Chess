import { describe, expect, it } from 'vitest';
import { CHESS_ART, pgnOf } from '../src/client/games/chess/index.js';
import { artFor, loadArt } from '../src/client/games/registry.js';
import { buildPgn, pgnFileName } from '../src/shared/pgn.js';
import type { GameReport } from '../src/shared/review.js';

/**
 * The phone's per-game art, fetched on demand (stage 11.1, decision 0056).
 * In a test the registry's `import()` resolves to the source; in the app the
 * build points it at `/games/chess.js`.
 */

describe('game art registry', () => {
  it('answers null at first, fetches, calls back once, and is synchronous after', async () => {
    let called = 0;
    const first = artFor('chess', () => {
      called += 1;
    });
    // Either still on its way, or already here from an earlier test.
    if (first === null) {
      const art = await loadArt('chess');
      expect(art).toBe(CHESS_ART);
      expect(called).toBe(1);
    }
    expect(artFor('chess')).toBe(CHESS_ART);
    expect(await loadArt('chess')).toBe(CHESS_ART);
  });

  it('writes the same PGN, under the same name, as the shared writer', () => {
    const report: GameReport = {
      joinCode: 'ABC234',
      fieldName: 'Riverside',
      startedAt: Date.UTC(2026, 9, 14, 12),
      finishedAt: Date.UTC(2026, 9, 14, 13),
      outcome: '0-1',
      reason: 'checkmate',
      initialMs: 600_000,
      incrementMs: 0,
      squareM: 8,
      boardM: 64,
      diagonalM: 90.5,
      travelM: { w: 40, b: 52 },
      moves: [
        { seq: 1, color: 'w', san: 'f3', uci: 'f2f3', from: 'f2', to: 'f3', carriedM: 8, carriedMs: 4000, lift: null, place: null },
      ],
    };
    expect(CHESS_ART.writeRecord(report)).toBe(buildPgn(report));
    expect(CHESS_ART.recordFileName(report)).toBe(pgnFileName(report));
    expect(pgnOf(report)).toEqual({ text: buildPgn(report), fileName: pgnFileName(report) });
    expect(CHESS_ART.pieceSvg({ type: 'b', color: 'w' }, 'standard')).toContain('data-piece="wb"');
  });
});
