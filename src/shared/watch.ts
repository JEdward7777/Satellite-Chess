/**
 * Watching a game live, from indoors (stage 10.14, decision 0055, O-37).
 *
 * The owner's purpose: family inside the house follow the game being played
 * outside, on a link a player sends them. Both players agree before it works,
 * either can turn it off at any moment, and **a watcher never receives a
 * coordinate**. So a watcher is not sent the players' messages at all. The game
 * builds a separate view for watchers, in which every position has already been
 * turned into squares from a1's centre on the server, the same way the replay's
 * walks are (decision 0052). The board in that view has no anchor, no bearing and
 * no name, so nothing a watcher holds can be put back on a map.
 *
 * This file is that view's wire format and the few rules both ends need: the
 * link's shape, the cap, why a watcher's socket was closed, and how a fix
 * becomes a spot on the board.
 */

import type { ClockState } from './clock.js';
import { type FieldGeometry, toBoardIndex } from './field.js';
import type { GameResult, GameStatus } from './protocol.js';
import type { Color, Square } from './squares.js';

/**
 * How many watchers one game takes at once.
 *
 * The free tier's budget was sized for two seats (`reference/budget.md`). A
 * watcher costs one request to connect and nothing after that: it sends
 * nothing, and outbound messages are not billed. What a watcher does cost is a
 * share of every broadcast's work and a reconnect now and then, so the number
 * is kept to what a family indoors needs. Past it the link says so politely
 * and nobody already watching is moved off.
 */
export const WATCH_MAX_WATCHERS = 6;

/**
 * How far off the board a player's dot is still shown, in squares. Beyond it a
 * watcher reads "off the board" and gets no position at all: someone walking
 * to the car is not part of the game, and a point fifty squares away says which
 * way they went.
 */
export const WATCH_MARGIN_SQUARES = 3;

/** Positions are sent to a hundredth of a square, as the replay keeps them. */
const GRAIN = 100;

/**
 * Why a watcher's socket was closed, as a WebSocket close code. The 4000s are
 * the application's own range, so a browser hands them to the page unchanged.
 */
export const WATCH_CLOSE = {
  /** The link is not live: turned off, never on, superseded, or a guess. */
  notLive: 4001,
  /** The game ended, and the link with it. */
  over: 4002,
  /** Already {@link WATCH_MAX_WATCHERS} watching. */
  full: 4003,
  /** A watcher sent something. Watchers only receive. */
  sent: 4004,
} as const;

export type WatchCloseCode = (typeof WATCH_CLOSE)[keyof typeof WATCH_CLOSE];

/**
 * The reason sent with each close code. Short (a close reason is at most 123
 * bytes) and only a fallback: the page says it in its own words, by code.
 */
export const WATCH_CLOSE_REASON: Record<WatchCloseCode, string> = {
  [WATCH_CLOSE.notLive]: 'This watch link is not live.',
  [WATCH_CLOSE.over]: 'The game is over.',
  [WATCH_CLOSE.full]: 'Too many people are watching.',
  [WATCH_CLOSE.sent]: 'Watchers only receive.',
};

/** A place on the board, in squares from a1's centre: a1 is (0, 0), h8 is (7, 7). */
export interface WatchSpot {
  file: number;
  rank: number;
}

/**
 * Where a fix falls on the board, as a watcher may see it, or null when it is
 * not on or near the board (or not a position at all).
 *
 * The affine inverse that answers "which square am I on" for a move
 * (`toBoardIndex`), rounded to a hundredth of a square. Nothing else about the
 * fix survives: not its latitude, its accuracy or its time.
 */
export function watchSpot(geo: FieldGeometry, pos: { lat: number; lng: number } | null): WatchSpot | null {
  if (pos === null || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return null;
  const at = toBoardIndex(geo, pos);
  if (!Number.isFinite(at.file) || !Number.isFinite(at.rank)) return null;
  const lo = -WATCH_MARGIN_SQUARES;
  const hi = 7 + WATCH_MARGIN_SQUARES;
  if (at.file < lo || at.file > hi || at.rank < lo || at.rank > hi) return null;
  // `+ 0` turns a rounded -0 into 0, so the wire never says "-0".
  return { file: Math.round(at.file * GRAIN) / GRAIN + 0, rank: Math.round(at.rank * GRAIN) / GRAIN + 0 };
}

/** One player, as a watcher sees them. No account, no name, no coordinate. */
export interface WatchPlayer {
  connected: boolean;
  /** On their own back rank, by the server's own check. */
  inStartZone: boolean;
  /** Where they are on the board, or null when unknown or off it. */
  at: WatchSpot | null;
  /** Meters walked while the game was active, as the players' screens have it. */
  travelM: number;
}

/** Everything a watcher's page draws. Sent on every change, as a player's snapshot is. */
export interface WatchSnapshot {
  v: number;
  rev: number;
  status: GameStatus;
  fen: string;
  clock: ClockState;
  /** Server time this was built, for the clock's offset (`client/clock.ts`). */
  serverNow: number;
  /** The board's longer side, in meters: a dimension, never a place (decision 0018). */
  boardM: number;
  players: { w: WatchPlayer; b: WatchPlayer };
  /** Every move so far, in order, as SAN. */
  moves: string[];
  lastMove: { from: Square; to: Square; san: string; color: Color; carriedM: number } | null;
  /** A piece in someone's hand. No destinations: the watcher is not playing. */
  carry: { color: Color; from: Square; piece: string } | null;
  result: GameResult | null;
  /** Who stopped the game, while it is suspended. */
  suspension: { by: Color | null } | null;
}

/** The whole view, on connecting and after every change. */
export interface WatchStateMsg {
  t: 'watch_state';
  game: WatchSnapshot;
}

/** One player moved: their relay, already turned into squares. */
export interface WatchPosMsg {
  t: 'watch_pos';
  color: Color;
  at: WatchSpot | null;
}

export type WatchServerMsg = WatchStateMsg | WatchPosMsg;

/**
 * What the players' own snapshot says about watching (`GameSnapshot.watch`).
 *
 * `link` is the path of the live link, present only while both have agreed.
 * Only the two players are ever sent it.
 */
export interface WatchState {
  /** Who has asked to let people watch and is waiting on the other, or null. */
  offeredBy: Color | null;
  on: boolean;
  link: string | null;
}

/**
 * The link's last path segment: the game's object id (64 hex characters) and
 * a secret (22 base64url characters, 128 random bits), joined by a dot.
 *
 * The id lets the Worker find the game without a lookup table and without the
 * join code, which the link must not hold (a code opens a seat while one is
 * free). It is a one-way digest of the code inside the runtime, so it gives the
 * code away to nobody. The secret is what the game checks, and it is new each
 * time watching is turned on, so a link that was turned off stays dead.
 */
const WATCH_LINK = /^([0-9a-f]{64})\.([A-Za-z0-9_-]{22})$/;

export interface WatchLink {
  id: string;
  secret: string;
}

export function parseWatchLink(segment: string): WatchLink | null {
  const match = WATCH_LINK.exec(segment);
  return match === null ? null : { id: match[1]!, secret: match[2]! };
}

/** The page a watcher opens: `/w/<id>.<secret>`. */
export function watchPath(link: WatchLink): string {
  return `/w/${link.id}.${link.secret}`;
}

/** The watcher's socket, for that link. */
export function watchSocketPath(link: WatchLink): string {
  return `/api/watch/${link.id}.${link.secret}/ws`;
}
