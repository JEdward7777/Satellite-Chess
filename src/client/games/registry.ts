/**
 * Fetch a game's art when it is first needed, and hand it out synchronously
 * after that (decision 0056).
 *
 * Each game's art is its own file (`/games/chess.js`), loaded with a dynamic
 * `import()`. `scripts/build-client.mjs` builds it apart from `app.js` and
 * rewrites the import below to that file's URL, with a hash of its content in
 * the query so a new deploy is never answered with an old file. In a test the
 * import resolves to the source as written.
 *
 * Views draw synchronously, so they ask {@link artFor}, which answers at once
 * with the art or null. Null means "not here yet": the board is drawn without
 * pieces and the view is called back to repaint when the art lands. A view
 * also starts the fetch at mount, so in practice the art arrives before the
 * socket's first snapshot does — it comes out of the service worker's cache,
 * where it was put when the app was installed.
 */

import type { GameType } from '../../shared/games/types.js';
import type { GameArt } from './types.js';

const LOADERS: Record<GameType, () => Promise<GameArt>> = {
  chess: () => import('./chess/index.js').then((module) => module.CHESS_ART),
};

/**
 * How long after a failed fetch before another is tried. A board repaints
 * many times a second; with no signal and no cached copy, each of those must
 * not be another request.
 */
const RETRY_AFTER_MS = 5_000;

const loaded = new Map<GameType, GameArt>();
const pending = new Map<GameType, Promise<GameArt>>();
const failedAt = new Map<GameType, number>();
const waiting = new Map<GameType, Set<() => void>>();

/** Fetch a game's art, or answer with it at once if it is already here. */
export function loadArt(type: GameType): Promise<GameArt> {
  const have = loaded.get(type);
  if (have !== undefined) return Promise.resolve(have);
  const inFlight = pending.get(type);
  if (inFlight !== undefined) return inFlight;
  const started = LOADERS[type]().then(
    (art) => {
      loaded.set(type, art);
      pending.delete(type);
      failedAt.delete(type);
      const callbacks = waiting.get(type);
      waiting.delete(type);
      for (const callback of callbacks ?? []) callback();
      return art;
    },
    (error: unknown) => {
      pending.delete(type);
      failedAt.set(type, Date.now());
      throw error;
    },
  );
  pending.set(type, started);
  return started;
}

/**
 * The art, if it is here; otherwise null, with the fetch started and
 * `onReady` called once it lands. A caller whose screen may be gone by then
 * checks that for itself in `onReady`.
 */
export function artFor(type: GameType, onReady?: () => void): GameArt | null {
  const have = loaded.get(type);
  if (have !== undefined) return have;
  if (onReady !== undefined) {
    const callbacks = waiting.get(type) ?? new Set<() => void>();
    callbacks.add(onReady);
    waiting.set(type, callbacks);
  }
  const failed = failedAt.get(type);
  if (!pending.has(type) && (failed === undefined || Date.now() - failed >= RETRY_AFTER_MS)) {
    loadArt(type).catch((error: unknown) => {
      console.error(`could not load the ${type} pieces`, error);
    });
  }
  return null;
}
