import { describe, expect, it } from 'vitest';

import {
  type OpponentTally,
  cleanOpponentName,
  opponentDetail,
  pairStandingOf,
  summarizeHeadToHead,
} from '../src/shared/head-to-head.js';
import type { ResultOutcome, ResultReason } from '../src/shared/protocol.js';
import type { RecordGame } from '../src/shared/record.js';
import type { GameReport } from '../src/shared/review.js';
import { type Units, METERS_PER_YARD, walkedPairWords, walkedWords } from '../src/shared/units.js';
import {
  HEAD_TO_HEAD_EXPLANATION,
  earlierWords,
  opponentLineWords,
  opponentSummaryWords,
  pairDistanceWords,
  pairResultsWords,
} from '../src/client/head-to-head.js';
import { headToHeadHtml, privacyHtml } from '../src/client/views/record.js';
import { opponentHtml } from '../src/client/views/opponent.js';
import { reviewHtml } from '../src/client/views/review.js';

/**
 * Head-to-head (stage 8.5.4, decision 0054): the fold and the words.
 *
 * The property that matters is that **both players read the same figures**.
 * Each game writes one row into each player's record, mirrored — the colors
 * opposite, the two distances swapped — and each record is folded on its own.
 * So the sweeps below build both rows for random games and check the two
 * screens agree to the character, in both units.
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
const REASONS: ResultReason[] = ['checkmate', 'resignation', 'timeout', 'agreement', 'stalemate'];
const PAIR = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const UNITS: Units[] = ['metric', 'us'];

/** One game, as each of its two players' records holds it. */
function mirrored(random: () => number, index: number, pair = PAIR): [RecordGame, RecordGame] {
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  // A spread of distances: tiny, ordinary, and long enough to cross into km and mi.
  const walk = (): number | null => {
    const r = random();
    if (r < 0.03) return null;
    return r < 0.3 ? random() * 40 : r < 0.9 ? random() * 900 : random() * 4000;
  };
  const aColor = random() < 0.5 ? 'w' : 'b';
  const plies = random() < 0.08 ? 0 : 1 + Math.floor(random() * 80);
  const squareM = random() < 0.1 ? 2 + random() * 2 : 4 + random() * 10;
  const travelA = walk();
  const travelB = walk();
  const shared = {
    joinCode: `G${String(index).padStart(5, '0')}`,
    outcome: pick(OUTCOMES),
    reason: pick(REASONS),
    finishedAt: 1_790_000_000_000 + Math.floor(random() * 5) * 60_000, // ties on purpose
    plies,
    longestCarryM: 10,
    fieldName: random() < 0.2 ? null : `Field ${Math.floor(random() * 3)}`,
    fieldKey: 'aaaaaaaaaaaaaaaa',
    squareM,
    boardM: squareM * 8,
    diagonalM: squareM * 8 * Math.SQRT2,
    pairId: pair,
  };
  return [
    { ...shared, color: aColor, moves: Math.ceil(plies / 2), travelM: travelA, opponentTravelM: travelB },
    {
      ...shared,
      color: aColor === 'w' ? 'b' : 'w',
      moves: Math.floor(plies / 2),
      travelM: travelB,
      opponentTravelM: travelA,
    },
  ];
}

/** Shuffle, so the order rows come out of SQLite is never what the fold relies on. */
function shuffled<T>(list: readonly T[], random: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('both players read the same head-to-head', () => {
  it('agrees to the bit and to the character, over a thousand random rivalries', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const random = rng(seed);
      const n = 1 + Math.floor(random() * 12);
      const games = Array.from({ length: n }, (_, i) => mirrored(random, i));
      const mine = summarizeHeadToHead(shuffled(games.map((g) => g[0]), random));
      const theirs = summarizeHeadToHead(shuffled(games.map((g) => g[1]), random));
      expect(mine.opponents).toHaveLength(1);
      const [x] = mine.opponents;
      const [y] = theirs.opponents;

      expect(x.togetherM).toBe(y.togetherM);
      expect(x.youM).toBe(y.themM);
      expect(x.themM).toBe(y.youM);
      expect([x.games, x.practiceGames, x.unplayedGames, x.unmeasuredGames]).toEqual([
        y.games,
        y.practiceGames,
        y.unplayedGames,
        y.unmeasuredGames,
      ]);
      expect(x.wins).toBe(y.losses);
      expect(x.losses).toBe(y.wins);
      expect(x.draws).toBe(y.draws);
      expect([x.firstAt, x.lastAt, x.firstFieldName]).toEqual([y.firstAt, y.lastAt, y.firstFieldName]);
      expect(x.games + x.practiceGames + x.unplayedGames + x.unmeasuredGames).toBe(n);

      for (const units of UNITS) {
        const a = pairDistanceWords(x, units);
        const b = pairDistanceWords(y, units);
        expect(a.together).toBe(b.together);
        const [, youA, themA] = /^You (.+) · They (.+)$/.exec(a.split)!;
        const [, youB, themB] = /^You (.+) · They (.+)$/.exec(b.split)!;
        expect([youA, themA]).toEqual([themB, youB]);
      }

      const detailA = opponentDetail(games.map((g) => g[0]), PAIR)!;
      const detailB = opponentDetail(games.map((g) => g[1]), PAIR)!;
      expect(detailA.games.map((g) => g.joinCode)).toEqual(detailB.games.map((g) => g.joinCode));
      expect(detailA.games.map((g) => g.standing)).toEqual(detailB.games.map((g) => g.standing));
      for (const units of UNITS) {
        detailA.games.forEach((line, i) => {
          const other = detailB.games[i];
          // Each game's "between you" is the same on both screens.
          expect(opponentLineWords(line, units).detail.split(' · ')[1]).toBe(
            opponentLineWords(other, units).detail.split(' · ')[1],
          );
        });
      }
      expect(detailA.opponent).toEqual(x);
    }
  });

  it('adds up only counted games, as the record does', () => {
    const random = rng(7);
    for (let trial = 0; trial < 300; trial++) {
      const games = Array.from({ length: 8 }, (_, i) => mirrored(random, i)[0]);
      const [tally] = summarizeHeadToHead(games).opponents;
      const counted = games.filter((g) => pairStandingOf(g) === 'counted');
      expect(tally.games).toBe(counted.length);
      expect(tally.youM).toBeCloseTo(counted.reduce((s, g) => s + (g.travelM ?? 0), 0), 6);
      expect(tally.togetherM).toBeCloseTo(
        counted.reduce((s, g) => s + (g.travelM ?? 0) + (g.opponentTravelM ?? 0), 0),
        6,
      );
    }
  });
});

describe('the pair standing', () => {
  it('judges both rows of a game alike', () => {
    const random = rng(99);
    for (let i = 0; i < 2000; i++) {
      const [a, b] = mirrored(random, i);
      expect(pairStandingOf(a)).toBe(pairStandingOf(b));
    }
  });

  it('is unmeasured when either side is', () => {
    const base = { plies: 10, squareM: 8 };
    expect(pairStandingOf({ ...base, travelM: 10, opponentTravelM: null })).toBe('unmeasured');
    expect(pairStandingOf({ ...base, travelM: null, opponentTravelM: 10 })).toBe('unmeasured');
    expect(pairStandingOf({ ...base, travelM: 10 })).toBe('unmeasured');
    expect(pairStandingOf({ ...base, travelM: 10, opponentTravelM: 0 })).toBe('counted');
    expect(pairStandingOf({ ...base, plies: 0, travelM: 1, opponentTravelM: 1 })).toBe('unplayed');
    expect(pairStandingOf({ ...base, squareM: 3.9, travelM: 1, opponentTravelM: 1 })).toBe('practice');
  });
});

describe('rows from before decision 0054', () => {
  it('are counted apart and never given an opponent', () => {
    const random = rng(3);
    const [a] = mirrored(random, 1);
    const old: RecordGame = { ...a, joinCode: 'OLD', pairId: undefined, opponentTravelM: undefined };
    const nulls: RecordGame = { ...a, joinCode: 'NUL', pairId: null, opponentTravelM: null };
    const junk: RecordGame = { ...a, joinCode: 'JNK', pairId: 'not-a-pair' };
    const head = summarizeHeadToHead([old, nulls, junk, a]);
    expect(head.earlierGames).toBe(3);
    expect(head.opponents.map((o) => o.id)).toEqual([PAIR]);
    expect(opponentDetail([old, nulls], PAIR)).toBeNull();
    expect(earlierWords(head)).toBe(
      '3 earlier games were recorded before the app kept track of who you played, so they are not in this list.',
    );
    expect(earlierWords({ earlierGames: 1 })).toMatch(/^One earlier game was .* so it is not/);
    expect(earlierWords({ earlierGames: 0 })).toBe('');
  });

  it('keeps opponents apart, most meters first', () => {
    const random = rng(11);
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => mirrored(random, i, PAIR)[0]),
      ...Array.from({ length: 3 }, (_, i) => mirrored(random, 10 + i, OTHER)[0]),
    ];
    const head = summarizeHeadToHead(rows);
    expect(head.opponents.map((o) => o.id).sort()).toEqual([OTHER, PAIR].sort());
    expect(head.opponents[0].togetherM).toBeGreaterThanOrEqual(head.opponents[1].togetherM);
    expect(opponentDetail(rows, 'nope')).toBeNull();
  });
});

describe('the figures shown', () => {
  /** The number in "312 m" or "1,230 yd", in that unit. */
  const figure = (words: string) => Number(words.replace(/,/g, '').split(' ')[0]);

  it('add up as read while short, and stay within one unit of the truth', () => {
    const random = rng(5);
    for (let i = 0; i < 20000; i++) {
      const r = random();
      const you = r < 0.5 ? random() * 600 : random() * 5000;
      const them = random() < 0.5 ? random() * 600 : random() * 5000;
      for (const units of UNITS) {
        const words = walkedPairWords(you, them, units);
        // The same whichever player is "you".
        const swapped = walkedPairWords(them, you, units);
        expect(swapped.together).toBe(words.together);
        expect([swapped.you, swapped.them]).toEqual([words.them, words.you]);
        // Each walk exactly as the record says it.
        expect(words.you).toBe(walkedWords(you, units));
        expect(words.them).toBe(walkedWords(them, units));

        const short = units === 'metric' ? 'm' : 'yd';
        const perShort = units === 'metric' ? 1 : METERS_PER_YARD;
        const trueShort = (you + them) / perShort;
        if (words.together.endsWith(` ${short}`)) {
          // Both parts are in the short unit too, and the line sums.
          expect(words.you.endsWith(` ${short}`) && words.them.endsWith(` ${short}`)).toBe(true);
          expect(figure(words.together)).toBe(figure(words.you) + figure(words.them));
          expect(Math.abs(figure(words.together) - trueShort)).toBeLessThanOrEqual(1);
        } else {
          // In the long unit: within a rounding of the true sum (and of the
          // one short unit the shown parts may add).
          const perLong = units === 'metric' ? 1000 : 1760;
          const shown = figure(words.together);
          const tenths = shown < 100;
          expect(Math.abs(shown - trueShort / perLong)).toBeLessThanOrEqual((tenths ? 0.05 : 0.5) + 1 / perLong + 1e-9);
        }
      }
    }
  });

  it('never makes "500 m" and "500 m" into "999 m"', () => {
    expect(walkedPairWords(499.5, 499.5, 'metric')).toEqual({ you: '500 m', them: '500 m', together: '1.0 km' });
    expect(walkedPairWords(160.4, 152.4, 'metric')).toEqual({ you: '160 m', them: '152 m', together: '312 m' });
    expect(walkedPairWords(0, 0, 'us')).toEqual({ you: '0 yd', them: '0 yd', together: '0 yd' });
    expect(walkedPairWords(1500, 1500, 'us').together).toBe('1.9 mi');
  });
});

describe('the words', () => {
  const tally = (over: Partial<OpponentTally> = {}): OpponentTally => ({
    id: PAIR,
    name: null,
    games: 3,
    wins: 2,
    draws: 0,
    losses: 1,
    togetherM: 312.8,
    youM: 160.4,
    themM: 152.4,
    practiceGames: 0,
    unplayedGames: 0,
    unmeasuredGames: 0,
    firstAt: Date.UTC(2026, 8, 20, 12),
    lastAt: Date.UTC(2026, 9, 1, 12),
    firstFieldName: 'Riverside Park',
    ...over,
  });

  it('lead with meters, never with games', () => {
    expect(pairDistanceWords(tally())).toEqual({ together: '312 m', split: 'You 160 m · They 152 m' });
    expect(pairDistanceWords(tally(), 'us')).toEqual({ together: '342 yd', split: 'You 175 yd · They 167 yd' });
    expect(pairResultsWords(tally())).toBe('2 won · 0 drawn · 1 lost, across 3 games.');
    expect(pairResultsWords(tally({ games: 0, wins: 0, losses: 0 }))).toBe('No counted games yet.');
    const summary = opponentSummaryWords(tally());
    expect(summary).toBe('312 m between you · 2 won · 0 drawn · 1 lost');
    expect(summary.indexOf('m between')).toBeLessThan(summary.indexOf('won'));

    const html = opponentHtml({ opponent: tally(), games: [] }, Date.UTC(2026, 9, 7), 'metric');
    // The headline is the distance, and it comes before the results line.
    expect(html.indexOf('data-opponent-together')).toBeLessThan(html.indexOf('data-opponent-results'));
    expect(html).toContain('312&nbsp;m');
    expect(html).toContain('First played Sep 20 at Riverside Park');
    expect(html).toContain('Unnamed opponent');
    for (const sentence of HEAD_TO_HEAD_EXPLANATION) expect(html).toContain(sentence);
  });

  it('escape a name a player typed', () => {
    const html = opponentHtml({ opponent: tally({ name: '<b>"Sam"</b>' }), games: [] });
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;&quot;Sam&quot;&lt;/b&gt;');
    const list = headToHeadHtml({ opponents: [tally({ name: '<i>x</i>' })], earlierGames: 0 });
    expect(list).not.toContain('<i>');
    expect(list).toContain(`data-opponent="${PAIR}"`);
  });

  it('list nothing when there is nothing, and say why some games are missing', () => {
    expect(headToHeadHtml({ opponents: [], earlierGames: 0 })).toBe('');
    const earlier = headToHeadHtml({ opponents: [], earlierGames: 2 });
    expect(earlier).toContain('2 earlier games were recorded before');
    expect(earlier).not.toContain('data-h2h-list');
  });

  it('say what was left out', () => {
    const html = opponentHtml({
      opponent: tally({ practiceGames: 1, unplayedGames: 2, unmeasuredGames: 1 }),
      games: [],
    });
    expect(html).toContain('One game on squares under 4 m is kept as practice and not counted.');
    expect(html).toContain('2 games that ended before anyone moved are not counted.');
    expect(html).toContain('One game with a distance nobody measured is not counted.');
  });
});

describe('opponent names', () => {
  it('are cleaned before they are kept', () => {
    expect(cleanOpponentName('  Sam  ')).toBe('Sam');
    expect(cleanOpponentName('Sam\n\tfrom  the\u0000club')).toBe('Sam from the club');
    expect(cleanOpponentName('a‮b')).toBe('a b');
    expect(cleanOpponentName('')).toBeNull();
    expect(cleanOpponentName('   ')).toBeNull();
    expect(cleanOpponentName(null)).toBeNull();
    expect(cleanOpponentName(42)).toBeNull();
    expect([...cleanOpponentName('é'.repeat(100))!]).toHaveLength(40);
    expect(cleanOpponentName('😀'.repeat(41))).toBe('😀'.repeat(40));
  });
});

describe('the way in from a review', () => {
  const report = (over: Partial<GameReport> = {}): GameReport => ({
    joinCode: 'K7M2PQ',
    fieldName: 'Riverside Park',
    startedAt: Date.UTC(2026, 9, 1),
    finishedAt: Date.UTC(2026, 9, 1, 1),
    outcome: '1-0',
    reason: 'checkmate',
    initialMs: 600_000,
    incrementMs: 0,
    squareM: 8,
    boardM: 64,
    diagonalM: 64 * Math.SQRT2,
    travelM: { w: 100, b: 90 },
    moves: [],
    ...over,
  });
  const pgn = { text: '', fileName: 'x.pgn' };

  it('is offered to a seat, for a game with a result', () => {
    expect(reviewHtml(report(), 'w', pgn, 'K7M2PQ')).toContain('data-review-h2h');
    expect(reviewHtml(report(), 'b', pgn, 'K7M2PQ')).toContain('Your record against this player');
  });

  it('is not offered without a seat, or for an aborted game', () => {
    expect(reviewHtml(report(), null, pgn, 'K7M2PQ')).not.toContain('data-review-h2h');
    expect(reviewHtml(report({ outcome: null, reason: 'aborted' }), 'w', pgn, 'K7M2PQ')).not.toContain(
      'data-review-h2h',
    );
  });
});

describe('the privacy statement', () => {
  it('says what head-to-head keeps and who sees it', () => {
    const html = privacyHtml();
    expect(html).toContain('Who you played.');
    expect(html).toContain('not a name or an email');
    expect(html).toContain('they\n        never see it');
    expect(html).toContain('Nobody can look you up or see who else you have\n        played.');
  });
});
