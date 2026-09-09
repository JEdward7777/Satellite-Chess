/**
 * The phone's half of the game index (stage 2.3.4).
 *
 * Two requests, and no store. This is the deliberate opposite of
 * `field-sync.ts`, and the difference is worth stating because the two look
 * like they should be symmetrical and are not:
 *
 * - A **field** is the phone's. It is written locally first, always, and syncs
 *   afterwards, because someone who has just walked out a board must never lose
 *   it to a bad signal (decision 0013).
 * - A **game index entry** is the *game's*. The phone cannot write one, does not
 *   cache one, and has nothing to merge (decision 0033). What it holds locally
 *   is the game it is currently in, which lives in the address bar.
 *
 * So there is no journal here, no acked map, and no delete-versus-never-had-it
 * problem — the whole apparatus `field-sync.ts` needs exists because the phone
 * is the origin of a field, and it is the origin of nothing here.
 *
 * The one thing this file does share with that one is its temperament: **a call
 * never rejects**. The list is an ornament on the home screen. A phone with no
 * signal, or no session, shows the screen it would have shown anyway.
 */

import { type ListedGame, listedGame } from '../shared/game-index.js';

/** What a list attempt came back with. */
export type GamesResult =
  | { kind: 'ok'; games: ListedGame[] }
  /** Not signed in. Normal, and the state every phone is in until stage 2.5.1. */
  | { kind: 'signed_out' }
  /** No signal, or the server said something unusable. */
  | { kind: 'unavailable' };

export interface GamesTransport {
  list(): Promise<GamesResult>;
  forget(joinCodes: readonly string[]): Promise<{ forgotten: string[]; kept: string[] }>;
}

/** The real one. Split out so the views can be driven without a network. */
export function browserGamesTransport(): GamesTransport {
  return {
    async list() {
      try {
        const response = await fetch('/api/games', {
          headers: { accept: 'application/json' },
        });
        if (response.status === 401) return { kind: 'signed_out' };
        if (!response.ok) return { kind: 'unavailable' };
        const body = (await response.json()) as { games?: unknown; now?: unknown };
        if (!Array.isArray(body.games)) return { kind: 'unavailable' };
        // Re-derived against this phone's clock rather than trusted from the
        // response. The countdown is measured in days and the answer travels
        // home in a pocket; a list rendered from a fetch made this morning would
        // otherwise still be claiming "in 3 days" tonight.
        const now = Date.now();
        return {
          kind: 'ok',
          games: (body.games as ListedGame[]).map((game) => listedGame(game, now)),
        };
      } catch {
        return { kind: 'unavailable' };
      }
    },

    async forget(joinCodes) {
      try {
        const response = await fetch('/api/games/forget', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ joinCodes }),
        });
        if (!response.ok) return { forgotten: [], kept: [...joinCodes] };
        const body = (await response.json()) as {
          forgotten?: unknown;
          kept?: { joinCode?: unknown }[];
        };
        return {
          forgotten: Array.isArray(body.forgotten) ? (body.forgotten as string[]) : [],
          kept: Array.isArray(body.kept)
            ? body.kept.map((entry) => String(entry?.joinCode ?? ''))
            : [],
        };
      } catch {
        // Nothing was forgotten, so nothing may be crossed off the screen. The
        // player taps again, and the second attempt is as safe as the first —
        // forgetting is idempotent at the far end.
        return { forgotten: [], kept: [...joinCodes] };
      }
    },
  };
}
