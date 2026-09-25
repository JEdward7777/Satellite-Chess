/**
 * Which piece look this phone shows: the standard set, or pieces on team discs.
 *
 * A per-device display preference, like the clock readout (`clock-debug.ts`),
 * and kept the same way: one `localStorage` key, read and written inside
 * try/catch, because some browsers throw on the accessor itself (O-28). A
 * browser that refuses storage still switches for as long as the page lives;
 * it just forgets on reload.
 *
 * It exists because the owner wants to compare the two looks outdoors and keep
 * one (stage `10.7`, decision 0045), so it is a switch rather than a setting
 * anybody is expected to think about. It never reaches the server: each phone
 * picks its own look, and the opponent never knows.
 */

import type { PieceLook } from './pieces.js';

/** The `localStorage` key. Words only; nothing here is secret. */
export const PIECE_LOOK_KEY = 'satchess.pieceLook';

/** The slice of `Storage` this needs, so a test need not have one. */
export type LookStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The stored look. Anything unreadable, or anything unknown, is the standard set. */
export function readPieceLook(storage: LookStorage | null): PieceLook {
  try {
    return storage?.getItem(PIECE_LOOK_KEY) === 'disc' ? 'disc' : 'standard';
  } catch {
    return 'standard';
  }
}

/** Remember the look where the phone lets us. Returns the look now in force. */
export function writePieceLook(storage: LookStorage | null, look: PieceLook): PieceLook {
  try {
    // The default is stored as nothing, so a phone that never touched the
    // switch follows whatever the default becomes after the comparison.
    if (look === 'disc') storage?.setItem(PIECE_LOOK_KEY, 'disc');
    else storage?.removeItem(PIECE_LOOK_KEY);
  } catch {
    // Private mode or a full store: it still switches for this page.
  }
  return look;
}

/** `localStorage`, or null where touching it throws (some private modes do). */
export function browserLookStorage(): LookStorage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * The look for this page, shared by every screen that draws a piece.
 *
 * Held in memory as well as in storage so that a browser that refuses storage
 * still gets a switch that works, and so that a screen already showing a board
 * repaints when the look is changed from the simulator panel.
 */
export interface PieceLookStore {
  get(): PieceLook;
  set(look: PieceLook): void;
  /** Called after every change. Returns the unsubscribe. */
  subscribe(fn: (look: PieceLook) => void): () => void;
}

export function createPieceLookStore(storage: LookStorage | null): PieceLookStore {
  let current = readPieceLook(storage);
  const listeners = new Set<(look: PieceLook) => void>();
  return {
    get: () => current,
    set(look) {
      current = writePieceLook(storage, look);
      for (const fn of [...listeners]) fn(current);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

let shared: PieceLookStore | null = null;

/** The page's one store, over the browser's storage. Made on first use. */
export function pieceLook(): PieceLookStore {
  shared ??= createPieceLookStore(browserLookStorage());
  return shared;
}
