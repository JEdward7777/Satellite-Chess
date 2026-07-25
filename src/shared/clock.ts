/**
 * Chess clock arithmetic, as pure functions over stored timestamps.
 *
 * Nothing here may live in memory between requests. The Durable Object
 * hibernates whenever both players are walking or thinking, so a running clock
 * has to be fully reconstructible from `startedAt` plus the two remaining
 * balances — there is no `setTimeout` to survive.
 */

import type { Color } from './squares.js';

export interface ClockState {
  whiteMs: number;
  blackMs: number;
  incrementMs: number;
  /** Whose clock is ticking, or would tick once the game is running. */
  active: Color;
  /**
   * Server time at which the active player's clock last started.
   * `null` means the clock is stopped (game not started, suspended, finished).
   */
  startedAt: number | null;
}

export function newClock(initialMs: number, incrementMs: number, active: Color = 'w'): ClockState {
  return { whiteMs: initialMs, blackMs: initialMs, incrementMs, active, startedAt: null };
}

export function other(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

function bankedMs(state: ClockState, color: Color): number {
  return color === 'w' ? state.whiteMs : state.blackMs;
}

function withBanked(state: ClockState, color: Color, ms: number): ClockState {
  return color === 'w' ? { ...state, whiteMs: ms } : { ...state, blackMs: ms };
}

/** How much time a player has right now, accounting for a running clock. */
export function remainingMs(state: ClockState, color: Color, now: number): number {
  const banked = bankedMs(state, color);
  if (state.startedAt === null || state.active !== color) return banked;
  return banked - Math.max(0, now - state.startedAt);
}

export function isRunning(state: ClockState): boolean {
  return state.startedAt !== null;
}

/** Start (or restart) the active player's clock. */
export function start(state: ClockState, now: number): ClockState {
  return { ...state, startedAt: now };
}

/**
 * Stop both clocks, banking whatever the active player has spent so far.
 *
 * Used for suspension. In over-the-board chess your clock runs no matter what,
 * but here a dropped connection is a network or GPS failure rather than a
 * decision, so it must not cost anyone time.
 */
export function freeze(state: ClockState, now: number): ClockState {
  if (state.startedAt === null) return state;
  const spent = Math.max(0, now - state.startedAt);
  const banked = Math.max(0, bankedMs(state, state.active) - spent);
  return { ...withBanked(state, state.active, banked), startedAt: null };
}

/**
 * Bank the mover's elapsed time, add their increment, and hand over.
 *
 * Increment is applied after the move completes, Fischer-style.
 */
export function applyMove(state: ClockState, now: number): ClockState {
  const frozen = freeze(state, now);
  const withIncrement = withBanked(
    frozen,
    frozen.active,
    bankedMs(frozen, frozen.active) + frozen.incrementMs,
  );
  return { ...withIncrement, active: other(frozen.active), startedAt: now };
}

/**
 * The exact instant the active player runs out, for `ctx.storage.setAlarm`.
 * `null` when the clock isn't running, in which case no flag can fall.
 */
export function flagFallAt(state: ClockState): number | null {
  if (state.startedAt === null) return null;
  return state.startedAt + bankedMs(state, state.active);
}

/** Whichever colour has flagged, or null. */
export function flaggedColor(state: ClockState, now: number): Color | null {
  if (state.startedAt === null) return null;
  return remainingMs(state, state.active, now) <= 0 ? state.active : null;
}

/** Both balances as of `now`, clamped at zero for display. */
export function snapshot(state: ClockState, now: number): { w: number; b: number } {
  return {
    w: Math.max(0, remainingMs(state, 'w', now)),
    b: Math.max(0, remainingMs(state, 'b', now)),
  };
}

/** mm:ss, or h:mm:ss past an hour, or tenths under ten seconds. */
export function formatClock(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = clamped / 1000;
  if (clamped < 10_000) return totalSeconds.toFixed(1);
  const s = Math.floor(totalSeconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export interface TimeControl {
  initialMs: number;
  incrementMs: number;
  label: string;
}

/**
 * Presets skewed long. A blitz clock on a 60 m field is a running race, not a
 * chess game — a1 to h8 is over 80 m of walking, twice, per exchange.
 */
export const TIME_CONTROLS: TimeControl[] = [
  { label: '10 min + 10s', initialMs: 10 * 60_000, incrementMs: 10_000 },
  { label: '20 min + 15s', initialMs: 20 * 60_000, incrementMs: 15_000 },
  { label: '30 min + 20s', initialMs: 30 * 60_000, incrementMs: 20_000 },
  { label: '45 min + 30s', initialMs: 45 * 60_000, incrementMs: 30_000 },
  { label: '60 min + 30s', initialMs: 60 * 60_000, incrementMs: 30_000 },
];

export const DEFAULT_TIME_CONTROL = TIME_CONTROLS[2];
