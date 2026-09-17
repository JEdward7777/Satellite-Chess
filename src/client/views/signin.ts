/**
 * The gate: the only screen an unauthenticated launch can reach (stage 2.5.1).
 *
 * Decision 0014 is blunt about this — "an unauthenticated launch goes to a
 * sign-in screen and nowhere else" — and the reason is worth restating on the
 * screen itself rather than only in a decision file. Sign-in is not here to
 * protect anything. It is here because the permanent record is the point of the
 * game: "you have walked 47 km playing chess" is only true if there is a durable
 * *you* for it to be true of, and an anonymous record evaporates with a browser
 * profile (decision 0019).
 *
 * So the screen says what signing in buys, in one line, rather than presenting a
 * wall and hoping. Somebody who has just been handed a QR code in a park is
 * about to be sent to Google by an app they have never opened, and the least
 * this can do is say why before it happens.
 *
 * ## What is deliberately not here
 *
 * No "continue without an account". There is no anonymous path to fall back to —
 * that is the whole of decision 0014, and the field fallback it rejected is
 * logged as O-01 rather than half-built here.
 */

import { signInFailureCause, signInHref } from '../session.js';

export interface SignInDeps {
  /** Where to return after Google. Carried through the flow cookie. */
  next: string;
  /**
   * Whether the server said its dev seam is reachable.
   *
   * Never true on a deployed build: it is `devSeamEnabled` answering, which
   * needs both `DEV_AUTH_SECRET` and a loopback hostname (decision 0029).
   */
  devSeam: boolean;
  /**
   * A failed sign-in's reason code, straight from `/?signin=failed&reason=…`.
   *
   * Rendered as a sentence naming the likely cause, with the code kept
   * underneath (stage 2.5.3). Both halves earn their place: the sentence is the
   * only part a player can act on, and the code is the only part that survives
   * being repeated down a phone line to somebody who can read this source.
   */
  reason: string | null;
  /** Mint a dev session and re-enter the app. Only wired when `devSeam`. */
  onDevSignIn(): void;
}

export function mountSignIn(root: HTMLElement, deps: SignInDeps): () => void {
  root.innerHTML = `
    <h1>Satellite Chess</h1>
    <div class="signin">
      <p class="signin-pitch">
        Chess played on real ground, where walking to a square is how you move a
        piece.
      </p>
      <p class="dim">
        Signing in is how the game keeps your record — every metre you walk, on
        every phone you play from. Without an account there is nowhere for it to
        go.
      </p>
      ${deps.reason === null ? '' : failureHtml(deps.reason)}
      <p>
        <a class="button" data-signin href="${escapeHtml(signInHref(deps.next))}">
          Sign in with Google
        </a>
      </p>
      ${
        // Drawn only where the seam's two locks are already open, which is
        // `wrangler dev` on loopback and nowhere else. The button is not the
        // lock: `/api/dev/session` 404s on a deployed build whatever is
        // rendered here.
        deps.devSeam
          ? `<p class="signin-dev">
               <button data-dev-signin class="secondary">Sign in as a test account</button>
               <span class="dim">Local development only.</span>
             </p>`
          : ''
      }
    </div>
  `;

  root
    .querySelector<HTMLButtonElement>('[data-dev-signin]')
    ?.addEventListener('click', deps.onDevSignIn);

  return () => {
    root.innerHTML = '';
  };
}

/**
 * That the last attempt failed, why it probably failed, and what it was called.
 *
 * `auth.ts` redirects every failure to `…?signin=failed&reason=<code>`, and
 * until stage 2.5.1 landed nothing rendered it at all — a failed sign-in landed
 * silently on the home screen, which is indistinguishable from a dead button.
 * 2.5.1 showed the code; 2.5.3 added the sentence above it.
 *
 * The code is kept, deliberately, even now that there is a sentence. It is the
 * only part of this that is exact, and it is what somebody can read out to a
 * person holding the source — `signInFailureCause` maps several different
 * server-side failures onto one reassuring paragraph, so the sentence alone
 * cannot be debugged from.
 *
 * `declined` is the exception at both ends: no cause sentence, and no code
 * either. The player closed Google's sheet on purpose, and quoting an error code
 * back at somebody for doing something deliberate is noise.
 */
function failureHtml(reason: string): string {
  const cause = signInFailureCause(reason);
  return `<p class="notice" data-signin-failed="${escapeHtml(reason)}">
    <strong>That sign-in did not finish.</strong>
    ${cause === null ? 'You can try again.' : `<span class="signin-cause">${escapeHtml(cause)}</span>`}
    ${reason === 'declined' ? '' : `<span class="signin-code dim">Reported as: ${escapeHtml(reason)}</span>`}
  </p>`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
