/**
 * The one console-error rule every browser driver shares.
 *
 * A driver that asserts "nothing threw" has to know which errors are the
 * product working correctly, and there is exactly one such family: **a phone
 * that is not signed in asking the account a question.**
 *
 * `POST /api/fields/sync` and `GET /api/games` both answer 401 to a signed-out
 * phone, and both are *designed* to. Fields live on the phone whether or not
 * anyone has signed in (decision 0013), so the sync is skipped and the field
 * list is untouched; the game index is simply absent from the home screen
 * (decision 0033). Neither is a failure the player can see, and neither throws.
 *
 * The browser logs every failed request regardless of whether the code handled
 * it, so those lines appear in the console of every correct signed-out run.
 *
 * **Stage 2.5.1 made sign-in mandatory, so these are now rare rather than
 * usual.** Every driver signs in through `driver-signin.mjs` before its first
 * navigation, and a signed-in run should produce none of them. They are still
 * excluded because there is one honest window left: the gate's own `/api/me`
 * probe runs before any session exists on a genuinely signed-out load, which is
 * what a driver testing the gate itself is looking at.
 *
 * So this excludes those endpoints at that one status, and nothing else. A 500
 * from any of them, or a 401 from anywhere else, still counts — which is the
 * difference between this and the blanket "ignore failed resource loads" that
 * `check-clock.mjs` used to carry.
 */

/** Endpoints that answer 401 to a signed-out phone, by design. */
const SIGNED_OUT_401 = ['/api/fields/sync', '/api/games', '/api/me'];

/**
 * Should this console message be treated as a failure?
 *
 * Takes a playwright `ConsoleMessage`. Anything that is not an `error` is
 * ignored here so a caller can hand over every message it receives.
 */
export function isRealConsoleError(message) {
  if (message.type() !== 'error') return false;
  const url = message.location()?.url ?? '';
  const isExpected =
    message.text().includes('401') && SIGNED_OUT_401.some((path) => url.includes(path));
  return !isExpected;
}
