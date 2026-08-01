/**
 * Taking a seat in someone else's game.
 *
 * One path for both ways in — a scanned `/j/CODE` and a code typed on the home
 * screen — because they are the same act and must fail the same way. The QR is
 * only a faster way to type six characters (decision 0015), so anything the
 * typed path tolerates the scanned one must too, and any failure either can hit
 * has to read the same to the person holding the phone.
 *
 * Two things come back from a successful join and both matter:
 *
 * - **The colour**, because it decides which end of the field you walk to.
 * - **The field**, because a phone that arrived by scanning a QR has calibrated
 *   nothing. The game snapshotted the creator's field when it was created
 *   (`snapshotField`), so the joiner has never needed to walk out a board — it
 *   just had no way to ask for one until now. That is stage 6.3, and without it
 *   a scan-to-play flow stops dead on the phone that scanned.
 *
 * Nothing here draws anything; `views/join.ts` does that. Split so the failure
 * mapping can be tested in node, which is where the interesting cases live —
 * a real server is a poor way to produce "no signal".
 */

import type { FieldSnapshot } from '../shared/field.js';
import { normaliseJoinCode } from '../shared/joincode.js';
import type { Color } from '../shared/squares.js';

/**
 * Why a join did not happen.
 *
 * Deliberately coarser than the server's error codes: what a player does next
 * is the same for "no such game" and "that game expired", and there is no way
 * for either end to tell those two apart anyway — an unclaimed game deletes
 * itself, and what is left is indistinguishable from a typo.
 */
export type JoinFailure =
  /** Not six usable characters. Refused here, before any request goes out. */
  | 'bad_code'
  /** Nothing at that code: a typo, or a game that expired unclaimed. */
  | 'not_found'
  /** Two players already, and neither of them is this phone. */
  | 'full'
  /** The request never reached a server. */
  | 'offline'
  /** It did, and something else went wrong. */
  | 'server';

export interface JoinSuccess {
  ok: true;
  /** Normalised, so it is the code the game is actually filed under. */
  code: string;
  colour: Color;
  /** The field the game is played on. The joiner may never have seen it before. */
  field: FieldSnapshot;
}

export interface JoinRejection {
  ok: false;
  reason: JoinFailure;
  /**
   * What went wrong, in the server's own words where it had any.
   *
   * The API writes its messages for someone standing in a field, so they are
   * shown as they arrive rather than translated (the same rule the game screen
   * follows for a rejected move).
   */
  message: string;
  /**
   * What to do about it. Always ours, because the server does not know how this
   * phone arrived — scanned, typed, or a link forwarded three times.
   */
  hint: string;
}

export type JoinOutcome = JoinSuccess | JoinRejection;

/** The fallback wording, for the failures the server never gets to describe. */
const DEFAULT_MESSAGE: Record<JoinFailure, string> = {
  bad_code: 'That is not a six-character game code.',
  not_found: 'No game with that code. It may have expired.',
  full: 'That game already has two players.',
  offline: 'Could not reach the game.',
  server: 'Something went wrong at the other end.',
};

/** What to try next. Short: it is read outdoors, probably in a hurry. */
const HINT: Record<JoinFailure, string> = {
  bad_code:
    'Codes are six characters. The letters I, L, O and U are never used, so a 1 is a one and a 0 is a zero.',
  not_found:
    'Check the code, or ask for the invite again — a game nobody joins is cleared after half an hour.',
  full: 'If one of those two is you, open the link on the phone you joined from first.',
  offline: 'Move somewhere with a signal and try again.',
  server: 'Try again in a moment.',
};

/** Map the API's error code onto what the player has to do about it. */
function failureFor(status: number, code: unknown): JoinFailure {
  if (code === 'game_full') return 'full';
  // A `bad_code` from the server means one this client thought was usable and
  // the server did not. Both ends fold through `normaliseJoinCode`, so it should
  // not happen — but if the two ever disagree, the player is told about the code
  // rather than about the game.
  if (code === 'bad_code') return 'bad_code';
  if (code === 'not_found' || status === 404) return 'not_found';
  return 'server';
}

function reject(reason: JoinFailure, message?: string): JoinRejection {
  return { ok: false, reason, message: message || DEFAULT_MESSAGE[reason], hint: HINT[reason] };
}

export interface JoinOptions {
  /** Injectable so a test need not run a server. */
  fetch?: typeof fetch;
  /** Overridable for tests; defaults to a same-origin request. */
  origin?: string;
}

/**
 * Ask for a seat in the game with this code.
 *
 * Idempotent at the far end: a phone that is already one of the two players gets
 * its own colour back rather than an error, so reopening an invite link — or
 * reloading the page mid-game — resumes instead of failing.
 */
export async function joinGame(
  rawCode: string,
  playerId: string,
  options: JoinOptions = {},
): Promise<JoinOutcome> {
  const code = normaliseJoinCode(rawCode);
  // Refused here rather than at the server: it saves a round trip on the phone
  // least likely to have signal, and the answer cannot differ.
  if (code === null) return reject('bad_code');

  const request = options.fetch ?? fetch;
  const url = `${options.origin ?? ''}/api/game/${encodeURIComponent(code)}`;

  let response: Response;
  try {
    response = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId }),
    });
  } catch {
    // A fetch only rejects when the request never got an answer — DNS, no
    // route, aeroplane mode. An HTTP error is a resolved promise.
    return reject('offline');
  }

  let body: { color?: Color; field?: FieldSnapshot; error?: string; message?: string };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // A body that is not JSON is not the API answering — a captive portal, or a
    // proxy's error page. Treat it as the server being unreachable in spirit.
    return response.ok ? reject('server') : reject(failureFor(response.status, null));
  }

  if (!response.ok) {
    return reject(failureFor(response.status, body.error), body.message);
  }
  if (!body.color || !body.field) {
    // A 200 that did not carry a seat and a field is a server we do not
    // understand. Better to say so than to open a board with no geometry.
    return reject('server');
  }

  return { ok: true, code, colour: body.color, field: body.field };
}
