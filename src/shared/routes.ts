/**
 * The paths the app owns, in one place, because two very different pieces of
 * code have to agree about them.
 *
 * The Worker needs to know which paths are *client-side* routes, so it can
 * answer them with the app shell instead of letting the assets binding 404 them
 * (a QR scan lands on `/j/ABC123`, and there is no file there). The client needs
 * to know what such a path *means*, so it can open the right screen. If those
 * two lists ever disagree the failure is silent in both directions — a route the
 * Worker serves but the client ignores looks like a broken link, and a route the
 * client understands but the Worker 404s never reaches the client at all.
 *
 * So: one parser, imported by both. See O-06.
 *
 * A path that does not parse is deliberately *not* an app route. `/j/nonsense`
 * gets an honest 404 from the edge rather than a 200 of HTML, because a code
 * that cannot be a code was never a link to a game.
 */

import { normaliseJoinCode } from './joincode.js';

export type AppRoute =
  /** `/j/CODE` — a game invite (decision 0015). The code is already normalised. */
  | { kind: 'join'; code: string }
  /** `/f/<blob>` — a self-contained field, encoded in the URL (decision 0016). */
  | { kind: 'field'; blob: string };

/**
 * The longest `/f/<blob>` we will treat as a route.
 *
 * Twelve bytes of geometry plus a name; decision 0016 sizes the geometry at
 * sixteen base64url characters, so this is generous room for the name and still
 * short enough that a junk path cannot be echoed back at length.
 */
const MAX_FIELD_BLOB = 256;

/** base64url, as produced by the field encoder — no padding, no slashes. */
const FIELD_BLOB = /^[A-Za-z0-9_-]+$/;

/**
 * Read a pathname as an app route, or `null` if it is not one.
 *
 * `null` covers both "the home screen" (`/`) and "a real asset" (`/app.js`);
 * neither needs rewriting, and the client falls back to home. Callers pass
 * `URL.pathname`, so the input is already percent-decoded per segment only where
 * the browser chose to — decode explicitly rather than assuming.
 */
export function parseAppRoute(pathname: string): AppRoute | null {
  const match = /^\/([jf])\/([^/]+)\/?$/.exec(pathname);
  if (match === null) return null;

  let segment: string;
  try {
    segment = decodeURIComponent(match[2]);
  } catch {
    // A malformed percent-escape is not a route.
    return null;
  }

  if (match[1] === 'j') {
    // Folded through the same normaliser as typed entry, so a link that was
    // retyped by hand with an O for a 0 still resolves.
    const code = normaliseJoinCode(segment);
    return code === null ? null : { kind: 'join', code };
  }

  if (segment.length > MAX_FIELD_BLOB || !FIELD_BLOB.test(segment)) return null;
  return { kind: 'field', blob: segment };
}

/**
 * True when the Worker must answer this path with the shell rather than hand it
 * to the assets binding.
 *
 * Separate from `parseAppRoute` only so the Worker's intent reads plainly at the
 * call site; it is the same question.
 */
export function isAppRoute(pathname: string): boolean {
  return parseAppRoute(pathname) !== null;
}
