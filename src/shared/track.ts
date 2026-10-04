/**
 * Where each player walked during a game, as squares on the board (stage 8.3,
 * decision 0052).
 *
 * The replay draws it: scrub to a move and both players' walks for that move
 * are over the board, the mover's split into the walk to the piece and the
 * carry. It is built only from fixes the server already receives — the coarse
 * position relay and the fix on every lift and place — so it costs **no
 * request** (nothing new is sent) and **no row written**: each fix is appended
 * to the player's presence row inside the `UPDATE` that already stores it.
 *
 * ## Board space, at the moment it arrives
 *
 * A fix is turned into squares from a1's centre as it is appended, so the game
 * never holds a trail of latitudes at all — only where on the board somebody
 * was. Rounded to a hundredth of a square, the PGN's grain (decision 0041).
 * The board has no anchor in it, so a track is unlocatable by construction,
 * the same rule as the report, the archive and the share card (decision 0018).
 *
 * ## Only the two players
 *
 * A track is in the review report and the archive, which are seat-only, and
 * **never in the PGN**, which is the file that gets forwarded. Per-game walks
 * stay with the two people who walked them (stage 8.5.5).
 *
 * ## The shape
 *
 * One fix is `[tag, file, rank]`, a tuple rather than an object because a
 * game holds hundreds of them and the archive pays for every key name.
 * `tag` says which move the fix belongs to:
 *
 * - `tag >> 1` is the number of moves completed when the fix arrived, so the
 *   fixes of ply *k* (1-based) are the ones with `tag >> 1 === k - 1`;
 * - `tag & 1` is 1 while this player had a piece in hand. A lift's own fix is
 *   0 (it arrives before the carry exists) and a place's is 1, so the carry is
 *   the lift, then every odd fix, ending at the place.
 */

import type { Color } from './squares.js';

/** `[tag, file, rank]` — see the module comment. */
export type TrackFix = [number, number, number];

/** Both players' tracks, in the order the fixes arrived. */
export type Tracks = Record<Color, TrackFix[]>;

/**
 * At most this many fixes are kept per player. Past it nothing more is added,
 * and the replay draws the remaining carries straight from lift to place,
 * which the moves hold anyway.
 *
 * The relay ceiling is 599 messages in thirty minutes of continuous walking
 * (`reference/budget.md`), plus two fixes a move, so this is about ninety
 * minutes of walking without a pause. About 16–20 bytes a fix in the
 * archive: up to ~39 KB a player, ~78 KB a game, at the cap.
 */
export const TRACK_MAX_FIXES = 2000;

/**
 * Positions further than this from the board, in squares, are not a walk on
 * it — a fix from the far side of a park, or a broken one — and are dropped
 * rather than stretching every drawing of the game.
 */
export const TRACK_MAX_SQUARES = 100;

/** Hundredths of a square, as the PGN writes positions. */
const GRAIN = 100;

/** The tag for a fix: which move it belongs to, and whether a piece was in hand. */
export function trackTag(movesCompleted: number, carrying: boolean): number {
  return Math.max(0, Math.floor(movesCompleted)) * 2 + (carrying ? 1 : 0);
}

/** The ply a fix belongs to (1-based): the move being made when it arrived. */
export function plyOfTag(tag: number): number {
  return (tag >> 1) + 1;
}

export function isCarryingTag(tag: number): boolean {
  return (tag & 1) === 1;
}

/**
 * One fix as stored on the presence row — `tag,file,rank` with the position in
 * whole hundredths — or null for one that is not a place on or near the board.
 */
export function encodeTrackFix(tag: number, file: number, rank: number): string | null {
  if (!Number.isInteger(tag) || tag < 0) return null;
  if (!Number.isFinite(file) || !Number.isFinite(rank)) return null;
  if (Math.abs(file) > TRACK_MAX_SQUARES || Math.abs(rank) > TRACK_MAX_SQUARES) return null;
  return `${tag},${Math.round(file * GRAIN)},${Math.round(rank * GRAIN)}`;
}

/** The stored text joined with one more fix: `;`-separated, no trailing separator. */
export function appendTrackText(stored: string, fix: string): string {
  return stored === '' ? fix : `${stored};${fix}`;
}

/**
 * A presence row's text, read back. Anything that does not parse is skipped
 * rather than taking the whole track with it.
 */
export function decodeTrack(text: string | null | undefined): TrackFix[] {
  if (typeof text !== 'string' || text === '') return [];
  const out: TrackFix[] = [];
  for (const part of text.split(';')) {
    const [tag, file, rank] = part.split(',').map(Number);
    const fix = cleanFix([tag, file === undefined ? NaN : file / GRAIN, rank === undefined ? NaN : rank / GRAIN]);
    if (fix !== null) out.push(fix);
    if (out.length >= TRACK_MAX_FIXES) break;
  }
  return out;
}

/**
 * Tracks from anywhere that is not this code — the archive, the wire — rebuilt
 * fix by fix, so nothing but three numbers per fix survives. Null for anything
 * that is not a pair of tracks at all, which is what an archive written before
 * decision 0052 holds.
 */
export function sanitizeTracks(value: unknown): Tracks | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.w) || !Array.isArray(raw.b)) return null;
  return { w: cleanList(raw.w), b: cleanList(raw.b) };
}

function cleanList(list: unknown[]): TrackFix[] {
  const out: TrackFix[] = [];
  for (const item of list) {
    if (out.length >= TRACK_MAX_FIXES) break;
    if (!Array.isArray(item) || item.length !== 3) continue;
    const fix = cleanFix([item[0], item[1], item[2]]);
    if (fix !== null) out.push(fix);
  }
  return out;
}

function cleanFix([tag, file, rank]: unknown[]): TrackFix | null {
  if (typeof tag !== 'number' || !Number.isInteger(tag) || tag < 0) return null;
  if (typeof file !== 'number' || typeof rank !== 'number') return null;
  if (!Number.isFinite(file) || !Number.isFinite(rank)) return null;
  if (Math.abs(file) > TRACK_MAX_SQUARES || Math.abs(rank) > TRACK_MAX_SQUARES) return null;
  // Re-rounded, so a fix that arrives with more places than the grain leaves
  // with exactly the grain: nothing finer than a hundredth of a square exists.
  return [tag, Math.round(file * GRAIN) / GRAIN, Math.round(rank * GRAIN) / GRAIN];
}
