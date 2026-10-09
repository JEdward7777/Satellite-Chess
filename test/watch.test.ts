import { describe, expect, it } from 'vitest';

import { type ClockState, formatClock } from '../src/shared/clock.js';
import {
  boardPointOfIndex,
  deriveGeometry,
  fromBoardPoint,
  makeFieldSpec,
  toBoardIndex,
} from '../src/shared/field.js';
import { fromLocal } from '../src/shared/geo.js';
import type { GameSnapshot } from '../src/shared/protocol.js';
import { parseAppRoute } from '../src/shared/routes.js';
import { boardWords, lengthWords, walkedWords } from '../src/shared/units.js';
import {
  WATCH_CLOSE,
  WATCH_MARGIN_SQUARES,
  type WatchSnapshot,
  parseWatchLink,
  watchPath,
  watchSocketPath,
  watchSpot,
} from '../src/shared/watch.js';
import { clockReadout } from '../src/client/clock.js';
import { privacyHtml } from '../src/client/views/record.js';
import {
  WATCH_MAX_FAILED_OPENS,
  lastMoveWords,
  moveListText,
  walkedLine,
  watchButtonLabel,
  watchClocks,
  watchCloseOutcome,
  watchHeadline,
  watchLine,
  watchPanel,
  watchPhase,
  watchRetryDelayMs,
} from '../src/client/watching.js';

/**
 * Watching a game live (stage 10.14, decision 0055): the pure halves.
 *
 * Every figure a watcher reads is swept against the figure a player reads for
 * the same thing — the clocks, the distances — and every position a watcher is
 * sent is swept against the affine inverse the moves are judged by, on boards
 * of every shape, anywhere on the planet.
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

/** A random four-corner board: anywhere, any size, any bearing, a little skewed. */
function randomBoard(random: () => number) {
  const a1 = { lat: (random() - 0.5) * 140, lng: (random() - 0.5) * 360 };
  const squareM = 1 + random() * 15;
  const rankM = squareM * (0.3 + random() * 1.4);
  const angle = random() * Math.PI * 2;
  const skew = (random() - 0.5) * 0.4;
  const file = { e: Math.cos(angle) * squareM, n: Math.sin(angle) * squareM };
  const rank = { e: Math.cos(angle + Math.PI / 2 + skew) * rankM, n: Math.sin(angle + Math.PI / 2 + skew) * rankM };
  const corner = (f: number, r: number) => fromLocal(a1, { e: f * file.e + r * rank.e, n: f * file.n + r * rank.n });
  return deriveGeometry(makeFieldSpec('x', { a1, h1: corner(7, 0), h8: corner(7, 7), a8: corner(0, 7) }, { id: 'x', now: 0 }));
}

describe('a position, as a watcher is sent it', () => {
  it('is the square the moves are judged by, to a hundredth, on any board anywhere', () => {
    const random = rng(1014);
    const wrong: string[] = [];
    let shown = 0;
    let hidden = 0;
    for (let b = 0; b < 400; b++) {
      const geo = randomBoard(random);
      for (let i = 0; i < 250; i++) {
        // Mostly on and around the board, some well off it.
        const spread = random() < 0.8 ? 7 + 2 * WATCH_MARGIN_SQUARES + 2 : 60;
        const want = { file: (random() - 0.5) * spread + 3.5, rank: (random() - 0.5) * spread + 3.5 };
        const pos = fromBoardPoint(geo, boardPointOfIndex(geo, want));
        const exact = toBoardIndex(geo, pos);
        const spot = watchSpot(geo, pos);
        const lo = -WATCH_MARGIN_SQUARES;
        const hi = 7 + WATCH_MARGIN_SQUARES;
        const inside = exact.file >= lo && exact.file <= hi && exact.rank >= lo && exact.rank <= hi;
        if (spot === null) {
          hidden += 1;
          if (inside) wrong.push(`hid ${JSON.stringify(exact)}`);
          continue;
        }
        shown += 1;
        if (!inside) wrong.push(`showed ${JSON.stringify(exact)} beyond the margin`);
        if (Object.keys(spot).sort().join() !== 'file,rank') wrong.push(`keys ${Object.keys(spot)}`);
        for (const axis of ['file', 'rank'] as const) {
          if (Math.abs(spot[axis] - exact[axis]) > 0.005 + 1e-9) wrong.push(`${axis} ${spot[axis]} vs ${exact[axis]}`);
          if (Math.abs(spot[axis] * 100 - Math.round(spot[axis] * 100)) > 1e-6) wrong.push(`${axis} ${spot[axis]} not in hundredths`);
          if (Object.is(spot[axis], -0)) wrong.push(`${axis} is -0`);
        }
        // Inside a square by more than the rounding, it names that square.
        const square = (v: number) => Math.round(v);
        for (const axis of ['file', 'rank'] as const) {
          const frac = Math.abs(exact[axis] - Math.round(exact[axis]));
          if (frac < 0.49 && square(spot[axis]) !== square(exact[axis])) wrong.push(`${axis} names the wrong square`);
        }
      }
      if (wrong.length > 5) break;
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(shown).toBeGreaterThan(50_000);
    expect(hidden).toBeGreaterThan(5_000);
  });

  it('is nothing at all for no fix, or a fix that is not a number', () => {
    const geo = randomBoard(rng(1));
    expect(watchSpot(geo, null)).toBeNull();
    expect(watchSpot(geo, { lat: Number.NaN, lng: 0 })).toBeNull();
    expect(watchSpot(geo, { lat: 0, lng: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe('the link', () => {
  const id = 'a'.repeat(64);
  const secret = 'Ab_-0123456789abcdefgh';

  it('reads back as itself, and as the watch route', () => {
    const link = parseWatchLink(`${id}.${secret}`)!;
    expect(link).toEqual({ id, secret });
    expect(watchPath(link)).toBe(`/w/${id}.${secret}`);
    expect(watchSocketPath(link)).toBe(`/api/watch/${id}.${secret}/ws`);
    expect(parseAppRoute(watchPath(link))).toEqual({ kind: 'watch', link });
  });

  it('is never a join code, and a join code is never one', () => {
    for (const bad of ['ABC123', `${id}`, `${id}.short`, `${id.toUpperCase()}.${secret}`, `${id}.${secret}x`, `${id}x.${secret}`]) {
      expect(parseWatchLink(bad)).toBeNull();
      expect(parseAppRoute(`/w/${bad}`)).toBeNull();
    }
    expect(parseAppRoute(`/j/${secret}`)).toBeNull();
  });
});

describe('the watcher reads the same figures a player does', () => {
  it('the clocks: each side as that side\'s own phone shows it, at every moment', () => {
    const random = rng(55);
    const wrong: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const running = random() < 0.7;
      const clock: ClockState = {
        whiteMs: Math.floor(random() * 3_600_000),
        blackMs: Math.floor(random() * 3_600_000),
        incrementMs: 0,
        active: random() < 0.5 ? 'w' : 'b',
        startedAt: running ? 1_000_000 - Math.floor(random() * 600_000) : null,
      };
      const serverNow = 1_000_000;
      const receivedAt = 5_000 + Math.floor(random() * 1e6);
      const localNow = receivedAt + Math.floor(random() * 120_000) - (random() < 0.05 ? 5_000 : 0);
      const seen = watchClocks({ clock, serverNow }, receivedAt, localNow);
      const asWhite = clockReadout({ clock, serverNow, you: 'w' }, receivedAt, localNow);
      const asBlack = clockReadout({ clock, serverNow, you: 'b' }, receivedAt, localNow);
      if (seen.w !== asWhite.mine || seen.b !== asBlack.mine) wrong.push(`${seen.w}/${seen.b} vs ${asWhite.mine}/${asBlack.mine}`);
      if (seen.w !== formatClock(seen.wMs) || seen.b !== formatClock(seen.bMs)) wrong.push('text and ms disagree');
      if (seen.running !== (running ? clock.active : null)) wrong.push(`running ${seen.running}`);
      if (wrong.length > 5) break;
    }
    expect(wrong).toEqual([]);
  });

  it('the distances: walked, carried and the board, in either unit, as the units module says them', () => {
    const random = rng(77);
    const wrong: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const units = random() < 0.5 ? 'metric' : 'us';
      const w = random() < 0.05 ? 0 : random() * random() * 20_000;
      const b = random() * random() * 20_000;
      const carried = random() * random() * 300;
      const boardM = random() < 0.05 ? 0 : 5 + random() * 200;
      const view = viewWith({
        boardM,
        players: { w: player({ travelM: w }), b: player({ travelM: b }) },
        lastMove: { from: 'd8', to: 'h4', san: 'Qh4#', color: 'b', carriedM: carried },
      });
      const line = walkedLine(view, units);
      const want = [`White walked ${walkedWords(w, units)}`, `Black walked ${walkedWords(b, units)}`];
      if (boardM > 0) want.push(`on a ${boardWords(boardM, units)} board`);
      if (line !== want.join(' · ')) wrong.push(line);
      const last = lastMoveWords(view, units);
      if (last !== `Last move: Qh4# by Black — carried ${lengthWords(carried, units)}.`) wrong.push(String(last));
      if (wrong.length > 5) break;
    }
    expect(wrong).toEqual([]);
  });
});

describe('the watcher\'s words', () => {
  it('numbers the moves', () => {
    expect(moveListText([])).toBe('');
    expect(moveListText(['f3', 'e5', 'g4', 'Qh4#'])).toBe('1. f3 e5 2. g4 Qh4#');
    const random = rng(3);
    for (let n = 0; n < 200; n++) {
      const moves = Array.from({ length: Math.floor(random() * 120) }, (_, i) => `m${i}`);
      const numbers = moveListText(moves).match(/\b\d+\./g) ?? [];
      expect(numbers.length).toBe(Math.ceil(moves.length / 2));
    }
  });

  it('says whose move, who is carrying, and how it ended', () => {
    expect(watchHeadline(viewWith({}))).toBe('White to move.');
    expect(watchHeadline(viewWith({ carry: { color: 'b', from: 'd8', piece: 'q' } }))).toBe(
      'Black is carrying a queen from d8.',
    );
    expect(watchHeadline(viewWith({ status: 'staging' }))).toMatch(/back rank/);
    expect(watchHeadline(viewWith({ status: 'suspended', suspension: { by: 'w' } }))).toMatch(/^White stopped the game/);
    expect(
      watchHeadline(viewWith({ status: 'finished', result: { outcome: '0-1', reason: 'checkmate', at: 1 } })),
    ).toBe('Game over: Black won — checkmate.');
    expect(watchHeadline(viewWith({ status: 'aborted' }))).toMatch(/aborted/);
  });
});

describe('closing and retrying', () => {
  it('stops for each of the game\'s own reasons, and retries the network\'s until it gives up', () => {
    expect(watchCloseOutcome(WATCH_CLOSE.notLive, 0)).toBe('not_live');
    expect(watchCloseOutcome(WATCH_CLOSE.over, 0)).toBe('over');
    expect(watchCloseOutcome(WATCH_CLOSE.full, 0)).toBe('full');
    expect(watchCloseOutcome(WATCH_CLOSE.sent, 0)).toBe('sent');
    for (const code of [1000, 1001, 1006, 1011]) {
      expect(watchCloseOutcome(code, WATCH_MAX_FAILED_OPENS - 1)).toBe('retry');
      expect(watchCloseOutcome(code, WATCH_MAX_FAILED_OPENS)).toBe('broken');
    }
    expect([0, 1, 2, 3, 4, 5, 10].map(watchRetryDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe('the players\' control', () => {
  const game = (over: Partial<Pick<GameSnapshot, 'status' | 'you' | 'watch'>>) => ({
    status: 'active' as const,
    you: 'w' as const,
    watch: { offeredBy: null, on: false, link: null },
    ...over,
  });

  it('follows the snapshot: off, asked, invited, on — and nothing before both are in or once it is over', () => {
    expect(watchPhase(game({}))).toBe('off');
    expect(watchPhase(game({ watch: { offeredBy: 'w', on: false, link: null } }))).toBe('asked');
    expect(watchPhase(game({ watch: { offeredBy: 'b', on: false, link: null } }))).toBe('invited');
    expect(watchPhase(game({ watch: { offeredBy: null, on: true, link: '/w/x' } }))).toBe('on');
    for (const status of ['waiting', 'finished', 'aborted'] as const) expect(watchPhase(game({ status }))).toBeNull();
    expect(watchPhase(null)).toBeNull();
  });

  it('asks, agrees, withdraws and turns off with the right words', () => {
    expect(watchButtonLabel('off')).toBe('Let people watch');
    expect(watchButtonLabel('on')).toBe('Watching…');
    expect(watchButtonLabel(null)).toBeNull();
    expect(watchLine('on')).toMatch(/Watching is on/);
    expect(watchLine('asked')).toMatch(/Waiting for your opponent/);
    expect(watchLine('off')).toBeNull();
    expect(watchPanel('off')).toMatchObject({ agree: 'Ask my opponent', stop: null, share: false });
    expect(watchPanel('asked')).toMatchObject({ agree: null, stop: 'Cancel the request', share: false });
    expect(watchPanel('invited')).toMatchObject({ agree: 'Agree', stop: 'No thanks', share: false });
    expect(watchPanel('on')).toMatchObject({ agree: null, stop: 'Turn watching off', share: true });
    expect(watchPanel('on').title).toBe('Watching is on — share this link');
  });
});

describe('the privacy statement', () => {
  it('says what watching shares, and that it ends', () => {
    const text = privacyHtml().replace(/\s+/g, ' ');
    expect(text).toContain('If you and your opponent both agree');
    expect(text).toContain("They never get a map, coordinates, the field's name or the game's code");
    expect(text).toContain('the link stops working then, and when the game ends');
  });
});

// ---------------------------------------------------------------------------

function player(over: Partial<WatchSnapshot['players']['w']> = {}): WatchSnapshot['players']['w'] {
  return { connected: true, inStartZone: false, at: { file: 4, rank: 0 }, travelM: 0, ...over };
}

function viewWith(over: Partial<WatchSnapshot>): WatchSnapshot {
  return {
    v: 1,
    rev: 1,
    status: 'active',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    clock: { whiteMs: 600_000, blackMs: 600_000, incrementMs: 0, active: 'w', startedAt: 1 },
    serverNow: 2,
    boardM: 48,
    players: { w: player(), b: player({ at: { file: 4, rank: 7 } }) },
    moves: [],
    lastMove: null,
    carry: null,
    result: null,
    suspension: null,
    ...over,
  };
}
