/**
 * Trying a field alone, before anybody is asked to play on it (O-49, decision
 * 0051).
 *
 * The model half of the preview board (`views/board.ts`): a verdict on
 * whether this field plays at the signal the phone has right now, and the
 * answer to "if I lifted or placed on that square from here, would the game
 * take it?". Pure functions, so the rules are unit-tested; the screen only
 * shows what these say.
 *
 * **Everything here is local.** It runs the game's own reach rule
 * (`shared/reach.ts`) on this phone's fix, exactly as the Durable Object would
 * at a lift or a place, and sends nothing. Inbound messages cost requests, and
 * a preview that asked the server would also stop working on a pitch with no
 * signal, which is where it is needed.
 *
 * ## What makes a field unplayable, and what this can see
 *
 * Since decision 0043 the reach circle is fixed in squares and accuracy never
 * widens it, so "does the reach cover most of the board" (O-49's first idea)
 * cannot happen any more: reach is at most 1.5 squares on any field. What can
 * go wrong is the other way round. A player standing in the middle of the
 * right square is refused once the dot strays further than the **leeway**:
 * the distance from a square's middle to its nearest edge, plus the reach.
 * So the verdict compares the phone's claimed accuracy against that leeway.
 *
 * - worse than `maxAccuracyM`: every move is refused, whatever the field;
 * - a claim within the leeway: playable;
 * - up to twice the leeway: the odd refusal;
 * - beyond that: often refused standing in the right place.
 *
 * **The claim is read as close to a worst case**, because that is what it
 * was measured to be. The 2026-09-06 field walk (decision 0031, 2008 fixes)
 * had every fix inside its claimed circle; the claim never went below 3.00 m
 * and its median was 3.37 m, against a real error of median 0.21 m (p95
 * 0.43 m). A rule that read the claim as a typical error (a 68% radius) would
 * tell that phone a default 8 m board gives "the odd refusal" and that a 6 m
 * board can never look playable, where the walk saw no refusals at all. So a
 * claim inside the leeway is a yes; a claim up to twice it still leaves the
 * real error, which is far smaller, mostly inside, so the odd refusal; past
 * that even a sixteenfold pessimist's real error starts to reach the edge.
 * This is one device on one day, so the thresholds are a revisit item
 * (stage 10.12.3) for any handset whose claims prove optimistic.
 *
 * What it cannot see is the ground: a board laid over a pond is as playable
 * to GPS as one laid over grass. The screen says to walk the edges.
 *
 * And it is still only the phone's claim, so the screen says "your phone
 * says" and offers the real test: stand in a square and tap it.
 */

/*
 * **The verdict is judged on the figures as shown**, not on the raw meters.
 * The sentence says "Your phone says ±7.2 m … counts until the dot strays
 * 7.2 m", and the projection carries a few 1e-11 m of error, so judged raw
 * that sentence could say "odd refusal" beside two equal figures, and any
 * slack added to hide that lets a claim a hair over the leeway read as a
 * larger figure beside a yes. Judged on the shown figures (`lengthFigure`,
 * one decimal, in the player's units) the order on screen is the verdict's
 * by construction. The accepted cost: metric and US can disagree near a
 * boundary, by at most half a display step (0.05 m, or half a foot).
 *
 * The refusal above `maxAccuracyM` is the server's rule, so it stays raw.
 */

import {
  type FieldGeometry,
  SMALL_SQUARE_M,
  distanceToSquareM,
} from '../shared/field.js';
import type { LatLng } from '../shared/geo.js';
import {
  DEFAULT_REACH,
  type ReachConfig,
  accuracyTooPoor,
  checkReachTo,
  effectiveReachM,
  refusalWords,
  refusedAccuracyPair,
} from '../shared/reach.js';
import { type Square, fromSquare } from '../shared/squares.js';
import { type Units, accuracyWords, lengthFigure, lengthWords } from '../shared/units.js';

/** From best to worst, plus the state before the first fix. */
export type PreviewLevel = 'good' | 'tight' | 'poor' | 'refused' | 'waiting';

export interface PreviewVerdict {
  level: PreviewLevel;
  /** Three or four words, the thing read at a glance. */
  headline: string;
  /** Why, in a sentence or two, in the player's units. */
  reason: string;
  /**
   * What is true of this field whatever the signal: squares small enough for
   * a game here to count only as practice, or a dot that may name the
   * neighboring square. Empty when there is nothing to add.
   */
  notes: string[];
  reachM: number;
  leewayM: number;
}

/**
 * Meters from a square's middle to its nearest edge.
 *
 * Half the narrower of the board's two widths across a square, measured
 * square to the edges: on a parallelogram that is less than half the shorter
 * step, because the cell leans. The sides along the file step are `|cross| /
 * |fileStep|` apart, and the sides along the rank step `|cross| / |rankStep|`.
 */
export function squareInsetM(geo: FieldGeometry): number {
  const { fileStep: a, rankStep: b } = geo;
  const area = Math.abs(a.e * b.n - a.n * b.e);
  const longest = Math.max(Math.hypot(a.e, a.n), Math.hypot(b.e, b.n));
  return longest > 0 ? area / longest / 2 : 0;
}

/**
 * How far the dot may stray from the middle of the square a player is
 * standing on before a lift or a place there is refused.
 *
 * Reach is measured to the nearest point of a square (decision 0003), so a
 * square is reached until the dot is a reach beyond its edge.
 */
export function leewayM(geo: FieldGeometry, cfg: ReachConfig = DEFAULT_REACH): number {
  return squareInsetM(geo) + effectiveReachM(geo.meanSquareM, cfg);
}

/**
 * Does this field play, at this accuracy, with this reach?
 *
 * `accuracyM` is the phone's claim for its current fix, or null before the
 * first one. Deliberately the current fix rather than an average: the screen
 * says "right now", and a player stepping out from under a tree should see
 * the verdict change as they do.
 */
export function previewVerdict(
  geo: FieldGeometry,
  accuracyM: number | null,
  cfg: ReachConfig = DEFAULT_REACH,
  units: Units = 'metric',
): PreviewVerdict {
  const reachM = effectiveReachM(geo.meanSquareM, cfg);
  const inset = squareInsetM(geo);
  const leeway = inset + reachM;
  const narrowest = Math.min(geo.fileM, geo.rankM);
  const notes: string[] = [];
  if (narrowest < SMALL_SQUARE_M) {
    notes.push(
      `Squares are only ${lengthWords(narrowest, units, 1)} across at the narrowest. GPS will ` +
        'struggle to tell them apart, and a game here counts only as practice.',
    );
  }
  const base = { reachM, leewayM: leeway, notes };
  const leewayText = lengthWords(leeway, units, 1);

  if (accuracyM === null) {
    return {
      ...base,
      level: 'waiting',
      headline: 'Waiting for GPS',
      reason: 'There is no position yet. Step into the open and wait a moment.',
    };
  }
  if (accuracyTooPoor(accuracyM, cfg)) {
    // Word for word as the game's own refusal, and the tap test, say it.
    const refused = refusedAccuracyPair(accuracyM, cfg.maxAccuracyM, units);
    return {
      ...base,
      level: 'refused',
      headline: 'Not playable at this signal',
      reason:
        `Your position is only accurate to ${refused.claim}, and moves need ` +
        `${refused.limit} or better, so every lift and place would ` +
        'be refused. Step into the open and wait for it to tighten.',
    };
  }

  // The one sentence every judged verdict starts from: the claim against the
  // leeway, both at one decimal in the player's units, and the verdict below
  // is decided on exactly those two figures.
  const claimText = `±${lengthWords(accuracyM, units, 1)}`;
  const claimShown = lengthFigure(accuracyM, units, 1);
  const leewayShown = lengthFigure(leeway, units, 1);
  const counts =
    `Your phone says ${claimText}. A move on the square you stand on counts until the dot ` +
    `strays ${leewayText} from its middle,`;

  if (claimShown <= leewayShown) {
    return {
      ...base,
      level: 'good',
      headline: 'Looks playable',
      reason: `${counts} so you should rarely be refused. Stand in a square and tap it to be sure.`,
    };
  }

  // A dot further off than half a square can name the next square over. Only
  // said below a yes, where it is part of why, and not on squares already
  // called too small, where it is the whole story.
  if (accuracyM > inset && narrowest >= SMALL_SQUARE_M) {
    notes.push(
      'The square shown under you may be a neighbor: your dot can be off by more than ' +
        'half a square.',
    );
  }

  if (claimShown <= 2 * leewayShown) {
    return {
      ...base,
      level: 'tight',
      headline: 'Playable, with the odd refusal',
      reason:
        `${counts} so now and then a move in the right place may be refused; wait a moment ` +
        'and try again.',
    };
  }
  return {
    ...base,
    level: 'poor',
    headline: 'Hard to play at this signal',
    reason:
      `${counts} so you would often be refused standing in the right place. Phones often ` +
      'claim worse than they are: stand in the middle of a square and tap it to see.',
  };
}

export interface SquareTest {
  square: Square;
  /** Whether the game would take a lift or a place on it, judged on reach alone. */
  ok: boolean | null;
  words: string;
}

/**
 * Would a lift or a place on `square` count from this fix?
 *
 * The same `checkReachTo` the server runs at a lift and at a place, with the
 * same config, so the answer is the one a game would give for reach and for
 * a fix too vague to trust. It says nothing about chess: whether a piece is
 * there, or may go there, is a separate question the server asks first.
 * `ok` is null when there is no fix to judge.
 */
export function testSquare(
  geo: FieldGeometry,
  fix: { pos: LatLng; accuracyM: number } | null,
  square: Square,
  cfg: ReachConfig = DEFAULT_REACH,
  units: Units = 'metric',
): SquareTest {
  if (fix === null) {
    return { square, ok: null, words: `No position yet, so ${square} cannot be tested.` };
  }
  const verdict = checkReachTo(geo, fix.pos, fix.accuracyM, square, cfg);
  if (verdict.ok) {
    const distanceM = distanceToSquareM(geo, fix.pos, fromSquare(square));
    return {
      square,
      ok: true,
      words:
        distanceM === 0
          ? `You are on ${square}: a lift or a place there would count.`
          : `A lift or a place on ${square} would count: you are ` +
            `${lengthWords(distanceM, units, 1)} from it, inside your ` +
            `${lengthWords(verdict.reachM, units, 1)} reach.`,
    };
  }
  const why = verdict.refusal ? refusalWords(verdict.refusal, units) : (verdict.message ?? '');
  return { square, ok: false, words: `A lift or a place on ${square} would be refused. ${why}`.trim() };
}
