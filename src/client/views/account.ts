/**
 * The account screen, and the account line on home (stages 2.2.3–2.2.5).
 *
 * The screen answers three questions and offers one act. *Who* is this phone
 * signed in as; *how do we know* — checked just now, or remembered from the
 * last time there was a connection (2.2.4); *how long* will it stay signed in;
 * and sign out.
 *
 * "Clear" was the whole of the stage line, and the thing most worth being clear
 * about is what signing out does *not* do. Fields live on the phone first
 * (decision 0013), so they stay; games live on the account, so they stay there.
 * Somebody handing their phone to a friend needs to know both before they tap.
 */

import {
  type KnownIdentity,
  PREFLIGHT_WINDOW_MS,
  type SessionNotice,
  sessionNotice,
  timeSince,
  timeUntil,
  whoLabel,
} from '../account.js';
import { type SignOutResult, signInHref } from '../session.js';

export interface AccountDeps {
  identity: KnownIdentity | null;
  /** Whether the server confirmed `identity` on this launch. */
  confirmed: boolean;
  /** Where "sign in again" should return to. */
  next: string;
  /**
   * Flush the field sync, then ask the server. On success the page is sent back
   * through the launch check, so only a failure is ever rendered here.
   */
  onSignOut(): Promise<SignOutResult>;
  onBack(): void;
}

export function mountAccount(root: HTMLElement, deps: AccountDeps): () => void {
  const now = Date.now();
  const { identity } = deps;
  root.innerHTML = `
    <h1>Account</h1>
    <div class="account">
      ${
        identity === null
          ? `<p data-who-unknown>
               This phone has not been able to check who is signed in: there has
               been no connection since it last could.
             </p>`
          : `<p class="account-who">Signed in as <strong data-who>${escapeHtml(whoLabel(identity))}</strong></p>
             <p class="dim" data-checked>${escapeHtml(checkedWords(identity, deps.confirmed, now))}</p>
             ${expiryHtml(identity, deps.confirmed, now)}`
      }
      ${sessionNoticeHtml(sessionNotice(identity, deps.confirmed, now), deps.next)}
      <h2>Sign out</h2>
      <p class="dim">
        Signing out ends this phone's session. Your games and your record stay on
        your account. Fields saved on this phone stay on the phone, and whoever
        signs in here next will have them added to their account.
      </p>
      <p><button data-signout class="secondary">Sign out</button></p>
      <p class="notice" data-signout-failed hidden></p>
      <p><button data-back class="secondary">Back</button></p>
    </div>
  `;

  const button = root.querySelector<HTMLButtonElement>('[data-signout]');
  const failure = root.querySelector<HTMLElement>('[data-signout-failed]');
  button?.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = 'Signing out…';
    if (failure) failure.hidden = true;
    void deps.onSignOut().then((result) => {
      // A success navigates the page away, so reaching this line with one is
      // only possible in a test; either way the button comes back.
      button.disabled = false;
      button.textContent = 'Sign out';
      if (result === 'signed_out' || !failure) return;
      failure.dataset.signoutFailed = result;
      failure.textContent = signOutFailureWords(result);
      failure.hidden = false;
    });
  });
  root.querySelector<HTMLButtonElement>('[data-back]')?.addEventListener('click', deps.onBack);

  return () => {
    root.innerHTML = '';
  };
}

/**
 * Why a sign-out did not happen, and that nothing changed.
 *
 * The cookie is `HttpOnly`, so the phone cannot drop it by itself; only the
 * server can end a session. Saying "nothing has changed" matters, because the
 * worst reading of a failed sign-out is believing it worked.
 */
export function signOutFailureWords(result: Exclude<SignOutResult, 'signed_out'>): string {
  return result === 'offline'
    ? 'Signing out needs a connection: the server has to forget this phone, and it could not be reached. Nothing has changed — try again somewhere with signal.'
    : 'The server could not sign you out just now. Nothing has changed — try again in a moment.';
}

/**
 * Home's title row: the name of the app, who is signed in, and a way to the
 * account screen.
 *
 * Folded into the title rather than given a line of its own, because home is
 * already taller than a phone (O-16) and `check-games.mjs` holds it to two
 * screens with seven games listed — a separate line took it over. The answer to
 * "am I signed in?" deserves to be visible, not to be large.
 */
export function homeHeaderHtml(identity: KnownIdentity | null, confirmed: boolean): string {
  const who =
    identity === null
      ? `Sign-in not checked — no connection.`
      : `Signed in as <strong data-who>${escapeHtml(whoLabel(identity))}</strong>${
          confirmed ? '' : ` <span data-unconfirmed>· no connection</span>`
        }`;
  return `<header class="home-head" data-account-line>
    <div>
      <h1>Satellite Chess</h1>
      <p class="home-who dim">${who}</p>
    </div>
    <button data-account class="secondary">Account</button>
  </header>`;
}

/** The pre-flight warning (stage 2.2.3), or nothing. */
export function sessionNoticeHtml(notice: SessionNotice | null, next: string): string {
  if (notice === null) return '';
  return `<p class="notice${notice.tone === 'warning' ? ' warning' : ''}" data-session-notice="${notice.tone}">
    ${escapeHtml(notice.text)}
    ${
      notice.offerSignIn
        ? `<br /><a class="button session-renew" data-signin-again href="${escapeHtml(signInHref(next))}">Sign in again</a>`
        : ''
    }
  </p>`;
}

function checkedWords(identity: KnownIdentity, confirmed: boolean, now: number): string {
  return confirmed
    ? 'Checked with the server just now.'
    : `Not checked — no connection. Last confirmed ${timeSince(now - identity.confirmedAt)}.`;
}

function expiryHtml(identity: KnownIdentity, confirmed: boolean, now: number): string {
  if (identity.expiresAt === null) return '';
  if (identity.via === 'dev') {
    return `<p class="dim" data-expiry>A local test account. It ends ${escapeHtml(
      timeUntil(identity.expiresAt - now),
    )} and is never renewed.</p>`;
  }
  const until = new Date(identity.expiresAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
  });
  // The "moves further out" half is left off when the session is inside the
  // pre-flight window with a connection: it has just been opened with one and
  // did *not* move, which is the very thing the warning beside it is about.
  const slid = !(confirmed && identity.expiresAt - now < PREFLIGHT_WINDOW_MS);
  return `<p class="dim" data-expiry>${
    confirmed ? 'This phone stays signed in' : 'As of the last check, this phone stays signed in'
  } until ${escapeHtml(until)}.${
    slid ? ' Opening the app with a connection moves that a month further out.' : ''
  }</p>`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
