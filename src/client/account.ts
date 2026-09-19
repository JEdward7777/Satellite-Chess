/**
 * Who this phone is signed in as, remembered across launches (stages 2.2.3–2.2.5).
 *
 * The data half of the account line on home and of `views/account.ts`. Split
 * from the views for the same reason `session.ts` is split from
 * `views/signin.ts`: the interesting cases are "no signal" and "a month later",
 * and neither is something a real server or a real clock produces on demand.
 *
 * ## What is cached, and what it is not for
 *
 * The launch check (`loadSession`) has three answers, and the third — `unknown`,
 * the server could not be asked — opens the app (decision 0035, rule 2). Until
 * stage 2.2.4 that was all it could do: the app opened, and did not know who it
 * was. So every confirmed launch now writes down the answer it got — the `sub`,
 * how the session was made, the address it was made with, and when it will run
 * out — and an `unknown` launch reads it back.
 *
 * **The cache is never an authority**, and that is the rule a future change is
 * most likely to break. It does not open the gate (rule 2 already does, with or
 * without it); it does not close it (only a real 401 does); and it is never
 * sent anywhere. Every request still carries the cookie and the server still
 * refuses every one of them without a live session. What the cache buys is
 * *words*: "signed in as you@example.com, last checked three days ago" instead
 * of silence, and a warning when the session it remembers is about to lapse.
 *
 * ## Times are this phone's, on purpose
 *
 * `/api/me` sends its expiry beside its own clock, and `loadSession` turns the
 * pair into a duration. Here the duration is added to *this phone's* clock at
 * the moment it arrived, so the stored `expiresAt` can be compared with
 * `Date.now()` on a later launch with no server to ask. That is the one
 * comparison `gotchas.md` allows: both sides of it are the same clock. A handset
 * whose clock is changed between launches moves its own warning, which is the
 * right thing for a warning to do.
 */

import { type SyncJournal, emptyJournalState } from './field-sync.js';
import type { SessionState } from './session.js';

type SignedIn = Extract<SessionState, { kind: 'signed_in' }>;

/** What the phone remembers about the last session the server confirmed. */
export interface KnownIdentity {
  /** The account key. Never shown to an opponent; shown here only for a dev account. */
  sub: string;
  via: 'dev' | 'google';
  /** The address the player signed in with, when the server knew it. */
  email: string | null;
  /** When the session runs out, on **this phone's** clock. Null if never said. */
  expiresAt: number | null;
  /** When the server last confirmed it, on this phone's clock. */
  confirmedAt: number;
}

/** The slice of `Storage` this needs, so a test can hand in a map. */
export interface IdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Where the identity lives. Beside the field journal, under the same prefix. */
const IDENTITY_KEY = 'satchess.identity';

/**
 * How close to its expiry a session has to be before home says so (stage 2.2.3).
 *
 * Three days: the warning is for "I will walk to the park tomorrow", and it has
 * to fire while there is still time to sign in at home on wifi. It rarely fires
 * at all, and that is by design rather than a sign it is broken — a launch with
 * a connection slides the session a month out (2.2.2), so a live session that
 * has just been checked is ~30 days from its end. What it catches is the case
 * where that did not happen: a renewal the server could not write, a session
 * last confirmed weeks ago, a dev token.
 */
export const PREFLIGHT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** The answer `/api/me` just gave, in the shape worth keeping. */
export function identityFromSession(state: SignedIn, localNow: number): KnownIdentity {
  return {
    sub: state.sub,
    via: state.via,
    email: state.email,
    expiresAt: state.expiresInMs === null ? null : localNow + state.expiresInMs,
    confirmedAt: localNow,
  };
}

/**
 * The identity this phone last had confirmed, or null.
 *
 * Every field is checked, because local storage is anybody's to edit and a
 * version of this app from before a field existed may have written the rest.
 * Anything malformed is null — the same as never having signed in, which is the
 * state rule 2 already copes with.
 */
export function readCachedIdentity(storage: IdentityStorage | null): KnownIdentity | null {
  if (storage === null) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(IDENTITY_KEY);
  } catch {
    // Some private modes throw on access rather than returning null.
    return null;
  }
  if (!raw) return null;
  let parsed: Partial<Record<keyof KnownIdentity, unknown>>;
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { sub, via, email, expiresAt, confirmedAt } = parsed;
  if (typeof sub !== 'string' || sub === '') return null;
  if (via !== 'dev' && via !== 'google') return null;
  if (!isFiniteNumber(confirmedAt)) return null;
  return {
    sub,
    via,
    email: typeof email === 'string' && email !== '' ? email : null,
    expiresAt: isFiniteNumber(expiresAt) ? expiresAt : null,
    confirmedAt,
  };
}

/** Remember a confirmed identity. A failed write is ignored: this is a nicety. */
export function writeCachedIdentity(storage: IdentityStorage | null, identity: KnownIdentity): void {
  try {
    storage?.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // A full or forbidden store costs the offline account line, nothing more.
  }
}

/** Forget it — on a 401, and on signing out. */
export function clearCachedIdentity(storage: IdentityStorage | null): void {
  try {
    storage?.removeItem(IDENTITY_KEY);
  } catch {
    // As above.
  }
}

/**
 * Forget everything this phone knew about the account it was signed in as —
 * the identity, and the field journal (decision 0039, rule 4).
 *
 * Called on **both** ways an account stops being this phone's: signing out, and
 * a launch that meets a 401 (a session that lapsed, or was ended in another
 * tab). The second matters as much as the first. The journal records what *one*
 * account acknowledged; left in place, the next account to sign in would have
 * its first sync read every field the last one held as "deleted elsewhere" and
 * remove it from the phone — decision 0032's one deletion rule, fed the wrong
 * account. Emptied, the next sign-in adopts those fields instead, which is the
 * journal's safe direction: it can resurrect, never lose.
 *
 * Fields themselves are never touched here. They are the phone's first
 * (decision 0013), and deleting them would lose any not yet synced.
 */
export function forgetAccount(
  storage: IdentityStorage | null,
  journal: Pick<SyncJournal, 'write'>,
): void {
  clearCachedIdentity(storage);
  try {
    journal.write(emptyJournalState());
  } catch {
    // A store that refuses writes has nothing in it to go stale.
  }
}

/**
 * What a launch does, given what the server said and what the phone remembers.
 *
 * **Three states in, and the gate is still decided by exactly one of them.**
 * `signed_out` is the only way to `gate`. `unknown` opens — with the cached
 * identity when there is one, *and without one when there is not*, and even
 * when the one it has has visibly run out. Each of those three is tempting to
 * "tighten" into a gate, and each would show a sign-in screen to somebody with
 * no signal to complete it, which is decision 0035's whole point. A lapsed
 * identity gets a notice on home (`sessionNotice`), not a closed door.
 */
export type Launch =
  | { kind: 'gate'; devSeam: boolean }
  | {
      kind: 'open';
      /** Who the phone is, as far as it knows. Null only if it has never known. */
      identity: KnownIdentity | null;
      /** True when the server said so on this launch; false when remembered. */
      confirmed: boolean;
    };

export function resolveLaunch(
  state: SessionState,
  cached: KnownIdentity | null,
  localNow: number,
): Launch {
  switch (state.kind) {
    case 'signed_out':
      return { kind: 'gate', devSeam: state.devSeam };
    case 'signed_in':
      return { kind: 'open', identity: identityFromSession(state, localNow), confirmed: true };
    case 'unknown':
      return { kind: 'open', identity: cached, confirmed: false };
  }
}

/**
 * Did the account change underneath the phone? (decision 0039, rule 4, the third
 * route.)
 *
 * Signing out and a 401 both go through `forgetAccount`. A straight switch does
 * not: the pre-flight warning's "Sign in again" goes to Google while the phone is
 * signed in as A, the account chooser can come back as B, the callback ends A's
 * session, and the next launch is simply `signed_in` as B — no 401, no sign-out.
 * The only evidence is that the `sub` the server confirms is not the one the
 * phone remembered. Left unnoticed, B's first sync would delete A's acknowledged
 * fields off the phone and push A's unsynced ones into B.
 *
 * True only on a *confirmed* launch whose `sub` differs from a remembered one.
 * No memory is not a change: with nothing cached there is nothing to compare,
 * and that case is undetectable here (O-27).
 */
export function accountChanged(cached: KnownIdentity | null, launch: Launch): boolean {
  return (
    launch.kind === 'open' &&
    launch.confirmed &&
    launch.identity !== null &&
    cached !== null &&
    cached.sub !== launch.identity.sub
  );
}

/** Something home should say about the session, above everything else. */
export interface SessionNotice {
  /** `warning` is act-soon; `notice` is already-happened. Matches the CSS. */
  tone: 'warning' | 'notice';
  text: string;
  /**
   * Whether a "sign in again" link belongs beside it. Only when there is a
   * connection to sign in over — offering Google to a phone that could not reach
   * our own server a second ago is a button that cannot work.
   */
  offerSignIn: boolean;
}

/**
 * The pre-flight check (stage 2.2.3): is the session about to lapse?
 *
 * Asked on home, because home is where somebody is before they set off, and
 * "while there is still wifi" is the whole point — the warning is worthless
 * once they are standing in the field.
 *
 * Silent for a dev session. Its token lasts twelve hours and is never renewed,
 * so every dev session is always inside the window, and a warning that is
 * always on is a warning nobody reads — least of all a browser driver's
 * screenshot, which would carry it on every home screen for ever.
 */
export function sessionNotice(
  identity: KnownIdentity | null,
  confirmed: boolean,
  localNow: number,
): SessionNotice | null {
  if (identity === null || identity.via === 'dev' || identity.expiresAt === null) return null;
  const remaining = identity.expiresAt - localNow;
  if (remaining >= PREFLIGHT_WINDOW_MS) return null;

  if (confirmed) {
    // With a connection, a session this close to its end means the renewal did
    // not happen (see PREFLIGHT_WINDOW_MS). A fresh sign-in is a fresh month.
    return {
      tone: 'warning',
      text: `Your sign-in on this phone runs out ${timeUntil(remaining)}. Sign in again now, while you have a connection — at the field there may be no signal to do it.`,
      offerSignIn: true,
    };
  }
  if (remaining <= 0) {
    // "Probably": the phone's own clock is the only evidence, and the server
    // cannot be asked. The app stays open regardless (decision 0035, rule 2).
    return {
      tone: 'notice',
      text: 'No connection, and the sign-in this phone had has probably run out. Calibrating a field still works. Starting or joining a game will need you to sign in again, somewhere with signal.',
      offerSignIn: false,
    };
  }
  return {
    tone: 'warning',
    text: `No connection right now, and your sign-in runs out ${timeUntil(remaining)}. Open the app somewhere with signal before then and it renews itself.`,
    offerSignIn: false,
  };
}

/** "in 5 hours", "in 2 days" — a lapse measured coarsely, because it is a warning. */
export function timeUntil(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return 'within the hour';
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  return `in ${Math.floor(hours / 24)} days`;
}

/** "just now", "3 hours ago", "2 days ago". */
export function timeSince(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / (60 * 1000));
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/**
 * Who, in words a person recognizes.
 *
 * The address when there is one. A dev account is named by its `sub`, because
 * that *is* its name — `white-player`, `dev-player` — and seeing it is how a
 * driver's screenshot shows which phone is which. A Google account with no
 * address (every session from before 2.2.5) is never named by its `sub`: a
 * twenty-one-digit number is not an answer to "who am I signed in as".
 */
export function whoLabel(identity: KnownIdentity): string {
  if (identity.email !== null) return identity.email;
  return identity.via === 'dev' ? `test account “${identity.sub}”` : 'your Google account';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
