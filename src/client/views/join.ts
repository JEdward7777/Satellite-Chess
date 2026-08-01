/**
 * The two screens a scanned invite can land on.
 *
 * Between opening `/j/ABC123` and seeing a board there is one request, and on
 * the phone this matters for — outdoors, on one bar, camera still warm — it can
 * take a while. Without a screen for that moment the app shows an empty page and
 * the person taps the QR again.
 *
 * The failure screen exists for the same reason from the other side: a link that
 * does not work must say *which* thing did not work. "No game with that code" and
 * "that game already has two players" send someone off to do completely different
 * things, and a single "could not join" sends them off to do nothing.
 *
 * The code is on screen in both, large and grouped, because it is the fallback
 * for every failure here — you can always read six characters out loud.
 */

import { formatJoinCode, isJoinCode } from '../../shared/joincode.js';
import type { JoinRejection } from '../join.js';

/**
 * The code, grouped where it can be.
 *
 * A code that failed to normalise is shown exactly as it was typed — grouping it
 * would insert a space into something that is already wrong, and the player is
 * being asked to compare it against what is on their friend's screen.
 */
function codeHtml(code: string): string {
  return escapeHtml(isJoinCode(code) ? formatJoinCode(code) : code);
}

export interface JoiningDeps {
  /** Already normalised, so it is what the game is filed under. */
  code: string;
  /** Shown only if the wait is long enough to be worth abandoning. */
  onCancel(): void;
}

/** "Joining ABC 123…" — up for one round trip, or for a lot longer on one bar. */
export function mountJoining(root: HTMLElement, deps: JoiningDeps): () => void {
  root.innerHTML = `
    <h1>Joining a game</h1>
    <div class="invite-code" data-join-code="${escapeHtml(deps.code)}">
      <span class="dim">Join code</span>
      <strong data-code>${codeHtml(deps.code)}</strong>
    </div>
    <p class="prompt" data-prompt>Taking a seat…</p>
    <p><button data-cancel class="secondary">Cancel</button></p>
  `;
  root.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', deps.onCancel);
  return () => {
    root.innerHTML = '';
  };
}

export interface JoinFailedDeps {
  code: string;
  rejection: JoinRejection;
  /** Offered for everything except a code that cannot be a code. */
  onRetry(): void;
  onHome(): void;
}

/** Why it did not work, and the one thing worth trying next. */
export function mountJoinFailed(root: HTMLElement, deps: JoinFailedDeps): () => void {
  // Retrying a code the client itself refused would send the same six characters
  // to the same place and get the same answer. Everything else — no signal, a
  // game not found because the creator has not finished making it — can change
  // between one tap and the next.
  const retryable = deps.rejection.reason !== 'bad_code';

  root.innerHTML = `
    <h1>Could not join</h1>
    <div class="invite-code" data-join-code="${escapeHtml(deps.code)}">
      <span class="dim">Join code</span>
      <strong data-code>${codeHtml(deps.code)}</strong>
    </div>
    <p class="notice" data-reason="${deps.rejection.reason}">${escapeHtml(deps.rejection.message)}</p>
    <p class="dim" data-hint>${escapeHtml(deps.rejection.hint)}</p>
    ${retryable ? '<p><button data-retry>Try again</button></p>' : ''}
    <p><button data-home class="secondary">Back to the home screen</button></p>
  `;

  root.querySelector<HTMLButtonElement>('[data-retry]')?.addEventListener('click', deps.onRetry);
  root.querySelector<HTMLButtonElement>('[data-home]')?.addEventListener('click', deps.onHome);
  return () => {
    root.innerHTML = '';
  };
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
