import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import type { ResultOutcome, ResultReason } from '../src/shared/protocol.js';
import type { GameReport, ReportMove } from '../src/shared/review.js';
import { walksOf } from '../src/shared/review.js';
import type { Color } from '../src/shared/squares.js';
import { type Units, boardWords, walkedWords } from '../src/shared/units.js';
import {
  CARD_EXPLANATION,
  CARD_FILE_NAME,
  CARD_HEIGHT,
  CARD_WIDTH,
  PNG_KEPT_CHUNKS,
  authoredFieldName,
  cardAltWords,
  cardMessageWords,
  cardMoveCount,
  cardOffered,
  cardResultWords,
  pngChunkTypes,
  shareCard,
  straightCarries,
  stripPngMetadata,
} from '../src/client/share-card.js';
import { headlineWords, moveWords, resultWords, walkWords, whereWords } from '../src/client/review.js';
import { replayFens } from '../src/client/replay.js';
import { reviewHtml } from '../src/client/views/review.js';
import { pgnOf } from '../src/client/review.js';
import { shareImage } from '../src/client/share.js';
import { RECENT_CARRIES, carryEmphasis } from '../src/client/replay-draw.js';
import { DEFAULT_FIELD_NAME, SHARED_FIELD_NAME } from '../src/client/fields.js';

/**
 * The share card (stages 8.5.1–8.5.3, decisions 0018 and 0053).
 *
 * Every figure on the card is swept against the screen it came from, in both
 * units, from the start: walked is the review's headline, the longest carry
 * is the review row's, the move count is the move list's last number, the
 * board is the review's board. And everything the card must *not* carry —
 * a walk, a date, the code, a name nobody chose to show — is swept too.
 */

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

const OUTCOMES: ResultOutcome[] = ['1-0', '0-1', '1/2-1/2'];
const REASONS: ResultReason[] = [
  'checkmate',
  'resignation',
  'timeout',
  'stalemate',
  'agreement',
  'insufficient_material',
  'threefold_repetition',
  'fifty_move_rule',
  'abandoned',
];
const NAMES: (string | null)[] = [
  null,
  '',
  '   ',
  'Riverside Park',
  '  Grandma’s backyard ',
  DEFAULT_FIELD_NAME,
  SHARED_FIELD_NAME,
  'A field with a very long name that goes on and on past any sensible width',
];
const CODE = 'K7M2PQ';
const STARTED = Date.UTC(2026, 9, 4, 15, 30);

/**
 * Legal games, made once: chess.js is the slow part of a sweep, and a prefix
 * of a legal game is a legal game.
 */
const GAMES: { color: Color; san: string; from: string; to: string; promotion?: string }[][] = (() => {
  const random = rng(53);
  return Array.from({ length: 40 }, () => {
    const chess = new Chess();
    const line: { color: Color; san: string; from: string; to: string; promotion?: string }[] = [];
    for (let ply = 0; ply < 60; ply++) {
      const legal = chess.moves({ verbose: true });
      if (legal.length === 0) break;
      const m = legal[Math.floor(random() * legal.length)]!;
      chess.move(m);
      line.push({ color: m.color, san: m.san, from: m.from, to: m.to, promotion: m.promotion });
    }
    return line;
  });
})();

/** A random finished game: legal moves, random fixes and distances. */
function randomReport(random: () => number): GameReport {
  const game = GAMES[Math.floor(random() * GAMES.length)]!;
  const plies = Math.floor(random() * (game.length + 1));
  const spot = () =>
    random() < 0.15 ? null : { file: (random() - 0.2) * 9, rank: (random() - 0.2) * 9, accuracyM: random() * 10 };
  const moves: ReportMove[] = game.slice(0, plies).map((m, ply) => {
    const r = random();
    return {
      seq: ply + 1,
      color: m.color,
      san: m.san,
      uci: `${m.from}${m.to}${m.promotion ?? ''}`,
      from: m.from,
      to: m.to,
      carriedM: r < 0.1 ? 0 : r < 0.15 ? Number.NaN : random() ** 2 * 3_000,
      carriedMs: random() * 200_000,
      lift: spot(),
      place: spot(),
    };
  });
  const travel = () => (random() < 0.15 ? null : random() < 0.1 ? 0 : random() ** 3 * 60_000);
  return {
    joinCode: CODE,
    fieldName: NAMES[Math.floor(random() * NAMES.length)]!,
    startedAt: STARTED,
    finishedAt: STARTED + 3_600_000,
    outcome: OUTCOMES[Math.floor(random() * OUTCOMES.length)]!,
    reason: REASONS[Math.floor(random() * REASONS.length)]!,
    initialMs: 1_800_000,
    incrementMs: 0,
    squareM: 8,
    boardM: random() < 0.05 ? 0 : random() * 1_500,
    diagonalM: 90.5,
    travelM: { w: travel(), b: travel() },
    moves,
    tracks: {
      w: Array.from({ length: Math.floor(random() * 40) }, (_, i) => [i, random() * 8, random() * 8] as [number, number, number]),
      b: Array.from({ length: Math.floor(random() * 40) }, (_, i) => [i, random() * 8, random() * 8] as [number, number, number]),
    },
  };
}

function sweep(seed: number, n: number, each: (report: GameReport, you: Color, units: Units) => void): void {
  const random = rng(seed);
  for (let i = 0; i < n; i++) {
    const report = randomReport(random);
    const you: Color = random() < 0.5 ? 'w' : 'b';
    const units: Units = random() < 0.5 ? 'metric' : 'us';
    each(report, you, units);
  }
}

describe('the figures on the card are the review’s own', () => {
  it('walked is the review headline’s figure, and says so where nobody measured it', () => {
    sweep(1, 600, (report, you, units) => {
      const walked = shareCard(report, you, units)!.figures[0]!;
      const mine = walksOf(report, you)[0]!;
      expect(walked.label).toBe('walked');
      if (mine.travelM === null) {
        expect(walked.value).toBe('not measured');
        expect(headlineWords(mine, units)).toBe('Distance was not measured');
      } else {
        expect(walked.value).toBe(walkedWords(mine.travelM, units));
        expect(headlineWords(mine, units)).toBe(`You covered ${walked.value}`);
      }
    });
  });

  it('the longest carry is the review row’s, the sharer’s own, and never more than they walked', () => {
    sweep(2, 600, (report, you, units) => {
      const longest = shareCard(report, you, units)!.figures[1]!;
      const mine = walksOf(report, you)[0]!;
      const row = walkWords(mine, you, units).detail;
      expect(longest.label).toBe('longest carry');
      if (longest.value === 'none') {
        expect(row).not.toMatch(/longest carry/);
        expect(report.moves.filter((m) => m.color === mine.color).every((m) => !(m.carriedM > 0))).toBe(true);
      } else {
        expect(row).toContain(`longest carry ${longest.value}`);
        // The largest of the sharer's own carries, as the move list says each.
        const own = report.moves.filter((m) => m.color === mine.color && m.carriedM > 0);
        const top = own.reduce((a, m) => Math.max(a, m.carriedM), 0);
        expect(longest.value).toBe(walkedWords(top, units));
        expect(own.some((m) => moveWords(m, units).detail.includes(longest.value))).toBe(true);
        if (mine.travelM !== null) expect(mine.travelM).toBeGreaterThanOrEqual(top);
      }
    });
  });

  it('the move count is the number of the last move in the list', () => {
    sweep(3, 600, (report, you, units) => {
      const moves = shareCard(report, you, units)!.figures[2]!;
      const last = report.moves[report.moves.length - 1];
      const expected = last === undefined ? 0 : Number(moveWords(last, units).ply.replace(/\D/g, ''));
      expect(moves.value).toBe(String(expected));
      expect(cardMoveCount(report)).toBe(Math.ceil(report.moves.length / 2));
      expect(moves.label).toBe(expected === 1 ? 'move' : 'moves');
    });
  });

  it('the board is the size the review says, in the reader’s units', () => {
    sweep(4, 600, (report, you, units) => {
      const board = shareCard(report, you, units)!.figures[3]!;
      expect(board.label).toBe('board');
      if (report.boardM > 0) {
        expect(board.value).toBe(boardWords(report.boardM, units));
        expect(whereWords(report, units)).toContain(`${board.value} board`);
        expect(board.value).toMatch(units === 'metric' ? / m$/ : / yd$/);
      } else {
        expect(board.value).toBe('unknown');
      }
    });
  });

  it('the result is the review’s, in the sharer’s voice', () => {
    sweep(5, 600, (report, seat) => {
      // A reader with no seat as well, for the words alone.
      const you: Color | null = report.moves.length % 5 === 0 ? null : seat;
      const card = cardResultWords(report, you);
      const review = resultWords(report, you);
      if (you === null) {
        expect(card).toBe(review);
        return;
      }
      const [verdict, how] = review.split(' — ');
      expect(card.split(' — ')[1]).toBe(how);
      const as = you === 'w' ? 'White' : 'Black';
      expect(card.split(' — ')[0]).toBe(
        verdict === 'You won' ? `Won as ${as}` : verdict === 'You lost' ? `Lost as ${as}` : `Drew as ${as}`,
      );
    });
  });

  it('every distance is in the reader’s units and no other', () => {
    sweep(6, 400, (report, you, units) => {
      const text = shareCard(report, you, units)!.figures.map((f) => f.value).join(' ');
      if (units === 'metric') expect(text).not.toMatch(/\d (yd|mi|ft)\b/);
      else expect(text).not.toMatch(/\d (m|km)\b/);
    });
  });
});

describe('what the card leaves out (decision 0053)', () => {
  it('is never made for a reader with no seat', () => {
    sweep(14, 100, (report, _you, units) => {
      expect(shareCard(report, null, units)).toBeNull();
      expect(shareCard(report, null, units, { showFieldName: true })).toBeNull();
    });
  });

  it('names the field only when a player wrote the name and this one ticked the box', () => {
    sweep(7, 600, (report, you, units) => {
      const off = shareCard(report, you, units)!;
      const on = shareCard(report, you, units, { showFieldName: true })!;
      expect(off.fieldName).toBeNull();
      const name = report.fieldName?.trim() ?? '';
      if (name === '' || name === DEFAULT_FIELD_NAME || name === SHARED_FIELD_NAME) {
        expect(on.fieldName).toBeNull();
      } else {
        expect(on.fieldName).toBe(name);
      }
      // Off, the name appears nowhere in anything the card says.
      if (name !== '') {
        expect(JSON.stringify(off)).not.toContain(name);
        expect(cardAltWords(off)).not.toContain(name);
      }
      // And the message beside the picture never carries it, ticked or not.
      if (name !== '') expect(cardMessageWords(on)).not.toContain(name);
    });
  });

  it('never offers a name the app made up', () => {
    for (const name of [null, '', '  ', DEFAULT_FIELD_NAME, SHARED_FIELD_NAME, ` ${DEFAULT_FIELD_NAME} `]) {
      expect(authoredFieldName({ fieldName: name })).toBeNull();
    }
    expect(authoredFieldName({ fieldName: ' Riverside Park ' })).toBe('Riverside Park');
  });

  it('draws each carry straight from its lift to its place, and never reads the walk', () => {
    sweep(8, 400, (report, you, units) => {
      const card = shareCard(report, you, units)!;
      const withFixes = report.moves.filter((m) => m.lift !== null && m.place !== null);
      expect(card.carries).toHaveLength(withFixes.length);
      card.carries.forEach((carry, i) => {
        const move = withFixes[i]!;
        expect(carry).toEqual({
          color: move.color,
          lift: { file: move.lift!.file, rank: move.lift!.rank },
          place: { file: move.place!.file, rank: move.place!.rank },
        });
      });
      // The same card with the walks taken away, or with different walks:
      // nothing the card holds moved.
      expect(shareCard({ ...report, tracks: null }, you, units)!).toEqual(card);
      expect(shareCard({ ...report, tracks: { w: [[0, 3, 3]], b: [] } }, you, units)!).toEqual(card);
    });
  });

  it('carries no join code, no date and no accuracy', () => {
    sweep(9, 400, (report, you, units) => {
      const card = shareCard(report, you, units, { showFieldName: true })!;
      // The words, not the carries: a carry is a pair of numbers, and some
      // random fraction will have 2026 in its digits.
      const all = JSON.stringify({ ...card, carries: [] }) + cardAltWords(card) + cardMessageWords(card);
      expect(all).not.toContain(CODE);
      expect(all).not.toContain('2026');
      expect(all).not.toMatch(/Oct|October|15:30|accuracy/i);
      expect(JSON.stringify(card.carries)).not.toContain('accuracyM');
    });
    expect(CARD_FILE_NAME).toBe('satellite-chess.png');
  });

  it('is the final position, from the sharer’s side, with the last move marked', () => {
    sweep(10, 300, (report, you, units) => {
      const card = shareCard(report, you, units)!;
      const fens = replayFens(report);
      expect(card.fen).toBe(fens[fens.length - 1]);
      expect(card.orientation).toBe(you ?? 'w');
      const last = report.moves[report.moves.length - 1];
      expect(card.lastMove).toEqual(last === undefined ? null : { from: last.from, to: last.to });
    });
  });

  it('is offered only for a game that ended with a result, read from a seat', () => {
    const random = rng(11);
    const report = randomReport(random);
    for (const you of ['w', 'b'] as const) {
      expect(cardOffered(report, you)).toBe(true);
      expect(cardOffered({ ...report, outcome: null, reason: null }, you)).toBe(false);
      expect(cardOffered({ ...report, outcome: null, reason: 'aborted' }, you)).toBe(false);
    }
    // No seat: the card would call White's distance "walked". No card.
    expect(cardOffered(report, null)).toBe(false);
  });

  it('says what is not on it', () => {
    expect(CARD_EXPLANATION).toMatch(/Not your walks, no map, no date and no names/);
  });

  it('is four by five', () => {
    expect(CARD_WIDTH / CARD_HEIGHT).toBe(4 / 5);
  });
});

describe('the review screen’s fold', () => {
  const base = randomReport(rng(12));
  const finished: GameReport = { ...base, fieldName: 'Riverside Park', outcome: '0-1', reason: 'checkmate' };

  it('is there for a finished game, shut, with the name box off', () => {
    const html = reviewHtml(finished, 'b', pgnOf(finished), CODE);
    expect(html).toContain('data-card');
    expect(html).not.toMatch(/<details[^>]*data-card[^>]*open/);
    expect(html).toMatch(/<input type="checkbox" data-card-name autocomplete="off">/);
    expect(html).toContain('Riverside Park');
    expect(html).toMatch(/data-card-share disabled/);
  });

  it('has no name box for a field nobody named, or one the app named', () => {
    for (const fieldName of [null, DEFAULT_FIELD_NAME, SHARED_FIELD_NAME]) {
      const report = { ...finished, fieldName };
      expect(reviewHtml(report, 'b', pgnOf(report), CODE)).not.toContain('data-card-name');
    }
  });

  it('is not there for a reader with no seat', () => {
    expect(reviewHtml(finished, null, pgnOf(finished), CODE)).not.toContain('data-card');
  });

  it('is not there for an aborted game', () => {
    const aborted = { ...finished, outcome: null, reason: 'aborted' as const };
    expect(reviewHtml(aborted, 'b', pgnOf(aborted), CODE)).not.toContain('data-card');
  });
});

// ---------------------------------------------------------------------------
// The PNG
// ---------------------------------------------------------------------------

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function png(types: string[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array<ArrayBuffer>[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  types.forEach((type, i) => {
    const text = new TextEncoder().encode(type === 'IEND' ? '' : `${type}-${i} GPS 51.4779 -0.0015 2026-10-04`);
    parts.push(chunk(type, text));
  });
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('the PNG leaves with nothing but the picture', () => {
  const dirty = ['IHDR', 'tEXt', 'eXIf', 'sRGB', 'iCCP', 'tIME', 'IDAT', 'zTXt', 'IDAT', 'iTXt', 'pHYs', 'abCd', 'IEND'];

  it('keeps the chunks that draw it, byte for byte, in order, and drops the rest', () => {
    const before = png(dirty);
    const after = stripPngMetadata(before)!;
    expect(pngChunkTypes(after)).toEqual(['IHDR', 'sRGB', 'IDAT', 'IDAT', 'IEND']);
    const latin = new TextDecoder('latin1').decode(after);
    for (const gone of ['tEXt', 'eXIf', 'tIME', 'iTXt', 'zTXt', 'iCCP']) expect(latin).not.toContain(gone);
    // What is kept is what the encoder wrote, CRC and all: the kept chunks,
    // laid end to end, are a run of bytes found in the original.
    const kept = ['IHDR', 'sRGB', 'IDAT', 'IDAT', 'IEND'];
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    let at = 8;
    for (const type of kept) {
      const length = new DataView(after.buffer, after.byteOffset).getUint32(at);
      const piece = after.subarray(at, at + 12 + length);
      expect(new TextDecoder('latin1').decode(piece.subarray(4, 8))).toBe(type);
      expect(hex(before)).toContain(hex(piece));
      at += 12 + length;
    }
    expect(stripPngMetadata(after)).toEqual(after);
  });

  it('keeps only what it names, whatever order and mix it is given', () => {
    const random = rng(13);
    const pool = [...PNG_KEPT_CHUNKS].filter((t) => t !== 'IHDR' && t !== 'IEND').concat(['tEXt', 'eXIf', 'tIME', 'iTXt', 'zTXt', 'pHYs', 'xYzW']);
    for (let i = 0; i < 300; i++) {
      const middle = Array.from({ length: Math.floor(random() * 12) }, () => pool[Math.floor(random() * pool.length)]!);
      const types = ['IHDR', ...middle, 'IEND'];
      const out = stripPngMetadata(png(types))!;
      expect(pngChunkTypes(out)).toEqual(types.filter((t) => PNG_KEPT_CHUNKS.has(t)));
    }
  });

  it('refuses what is not a whole PNG', () => {
    const good = png(['IHDR', 'IDAT', 'IEND']);
    expect(stripPngMetadata(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(stripPngMetadata(good.subarray(0, good.length - 5))).toBeNull();
    expect(stripPngMetadata(png(['IHDR', 'IDAT']))).toBeNull();
    const notPng = good.slice();
    notPng[0] = 0;
    expect(stripPngMetadata(notPng)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sharing it (stage 8.5.3)
// ---------------------------------------------------------------------------

function abort(): Error {
  const error = new Error('cancelled');
  error.name = 'AbortError';
  return error;
}

describe('the picture goes out through the sheet, or is downloaded', () => {
  const image = { png: new Blob([png(['IHDR', 'IDAT', 'IEND'])], { type: 'image/png' }), fileName: CARD_FILE_NAME, title: 'A game of Satellite Chess', message: 'Won.' };
  const nav = (share?: (d: ShareData) => Promise<void>, canShare = true) =>
    ({ ...(share ? { share, canShare: () => canShare } : {}) }) as unknown as Navigator;

  it('reaches navigator.share with the file and no link, nothing awaited first', async () => {
    const seen: ShareData[] = [];
    const share = (d: ShareData) => {
      seen.push(d);
      return Promise.resolve();
    };
    const promise = shareImage(image, { nav: nav(share), download: () => true });
    expect(seen).toHaveLength(1);
    expect(await promise).toEqual({ ok: true, tier: 'share-file' });
    expect(seen[0]!.url).toBeUndefined();
    expect(seen[0]!.files?.[0]?.name).toBe(CARD_FILE_NAME);
    expect(seen[0]!.files?.[0]?.type).toBe('image/png');
  });

  it('a dismissed sheet is a decision: nothing is downloaded', async () => {
    let downloads = 0;
    const outcome = await shareImage(image, {
      nav: nav(() => Promise.reject(abort())),
      download: () => {
        downloads += 1;
        return true;
      },
    });
    expect(outcome).toEqual({ ok: false, tier: 'share-file', reason: 'cancelled' });
    expect(downloads).toBe(0);
  });

  it('a sheet that fails, or takes no files, or none at all: a download', async () => {
    for (const n of [nav(() => Promise.reject(new Error('no'))), nav(() => Promise.resolve(), false), nav()]) {
      let downloads = 0;
      const outcome = await shareImage(image, {
        nav: n,
        download: (blob, name) => {
          expect(name).toBe(CARD_FILE_NAME);
          expect(blob).toBe(image.png);
          downloads += 1;
          return true;
        },
      });
      expect(outcome).toEqual({ ok: true, tier: 'download' });
      expect(downloads).toBe(1);
    }
  });

  it('and when that cannot start either, it says so', async () => {
    expect(await shareImage(image, { nav: nav(), download: () => false })).toEqual({
      ok: false,
      tier: 'manual',
      reason: 'failed',
    });
  });
});

describe('straight carries', () => {
  it('skip a move with a missing or broken fix', () => {
    const fix = { file: 1, rank: 1, accuracyM: 3 };
    const move = (lift: ReportMove['lift'], place: ReportMove['place']): ReportMove => ({
      seq: 1, color: 'w', san: 'e4', uci: 'e2e4', from: 'e2', to: 'e4', carriedM: 1, carriedMs: 1, lift, place,
    });
    expect(straightCarries({ moves: [move(null, fix), move(fix, null), move({ ...fix, file: Number.NaN }, fix)] })).toEqual([]);
    expect(straightCarries({ moves: [move(fix, fix)] })).toHaveLength(1);
  });
});

describe('a long game’s carries stay readable', () => {
  it('keeps the last few bold and fades and thins the rest as the count grows', () => {
    for (let count = 1; count <= 200; count++) {
      const looks = Array.from({ length: count }, (_, i) => carryEmphasis(i, count));
      looks.forEach((look, i) => {
        expect(look.recent).toBe(i >= count - RECENT_CARRIES);
        expect(look.width).toBeGreaterThan(0.3);
        expect(look.width).toBeLessThanOrEqual(1);
      });
      const recent = looks.filter((l) => l.recent);
      const earlier = looks.filter((l) => !l.recent);
      expect(recent).toHaveLength(Math.min(count, RECENT_CARRIES));
      for (const e of earlier) {
        for (const r of recent) {
          expect(e.alpha).toBeLessThan(r.alpha);
          expect(e.width).toBeLessThan(r.width);
        }
      }
      // Never thicker as the game gets longer.
      if (count > 1) expect(carryEmphasis(0, count).width).toBeLessThanOrEqual(carryEmphasis(0, count - 1).width);
    }
    // A short game is drawn at full width.
    expect(carryEmphasis(4, 5)).toEqual({ alpha: 0.95, width: 1, recent: true });
  });
});
