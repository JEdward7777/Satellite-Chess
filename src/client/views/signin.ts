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

import { signInHref } from '../session.js';

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
   * Shown plainly rather than translated. Naming the *likely cause* in a
   * sentence — no signal, a Safari handoff from a home-screen PWA — is stage
   * 2.5.3; until then the honest thing is to say that it failed and show what
   * the server called it, because silently re-offering the button is what makes
   * a failure look like a loop.
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
 * That the last attempt failed, and what it was called.
 *
 * `auth.ts` redirects every failure to `…?signin=failed&reason=<code>`, and
 * until stage 2.5.1 landed nothing rendered it at all — a failed sign-in landed
 * silently on the home screen. A code is not a sentence, but it is honest, and
 * it is the difference between "that did not work" and a button that appears to
 * do nothing when pressed twice.
 */
function failureHtml(reason: string): string {
  return `<p class="notice" data-signin-failed="${escapeHtml(reason)}">
    That sign-in did not finish${reason === 'declined' ? '' : ` (${escapeHtml(reason)})`}.
    You can try again.
  </p>`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
