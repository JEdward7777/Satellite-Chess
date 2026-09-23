/**
 * The post-game screen (stages 8.1, 8.2): how far you walked, and the game as a
 * file you can send.
 *
 * It is the record's data seen from inside one game, so it is laid out the same
 * way and for the same reason: **distance is the headline** and the move count
 * is the sentence under it (decision 0019). "You covered 2.4 km" is the thing a
 * player repeats to somebody who was not there, and this is the moment they
 * would say it — standing on the field with the game just finished.
 *
 * The honesty sentences (O-03, O-12) are the record's, word for word, and are
 * on the screen rather than behind a tap. This is stage `8.2.3`: the distance
 * is measured by the player's own phone and taken on trust, and the screen says
 * so beside the number rather than presenting a client-reported statistic as a
 * referee's ruling.
 *
 * ## The report is fetched once, at mount
 *
 * Not for speed. `navigator.share` must be reached with nothing awaited in
 * front of it (`gotchas.md`), so the PGN has to be a string in memory before
 * the Share button is ever tapped. Everything below the sheet is a rung of the
 * same ladder, ending in a `<textarea>` the player can select and a plain link
 * to `/api/game/:code/pgn` — a *server*-initiated download, which still saves a
 * file on the phones where a page-initiated one silently does nothing
 * (decision 0041).
 */

import type { GameReport } from '../../shared/review.js';
import type { Color } from '../../shared/squares.js';
import {
  DISTANCE_HONESTY,
  PGN_EXPLANATION,
  type ReviewTransport,
  headlineDetailWords,
  headlineWords,
  moveWords,
  pgnOf,
  resultWords,
  shareMessageWords,
  walkRows,
  whereWords,
} from '../review.js';
import { type ShareOutcome, copyText, sharePgn } from '../share.js';
import { walksOf } from '../../shared/review.js';

export interface ReviewViewDeps {
  joinCode: string;
  transport: ReviewTransport;
  onHome(): void;
  /** Overridden in tests and by the simulator; the app uses the real navigator. */
  share?: typeof sharePgn;
  copy?: typeof copyText;
}

export function mountReview(root: HTMLElement, deps: ReviewViewDeps): () => void {
  let live = true;
  root.innerHTML = `<section class="screen review" data-review>
    <h1>After the game</h1>
    <div data-review-body><p class="dim" data-review-loading>Reading the game…</p></div>
    <p><button class="secondary" data-review-home>Home</button></p>
  </section>`;

  const body = root.querySelector<HTMLElement>('[data-review-body]')!;
  root.querySelector<HTMLButtonElement>('[data-review-home]')?.addEventListener('click', () => {
    deps.onHome();
  });

  const load = (): void => {
    body.innerHTML = `<p class="dim" data-review-loading>Reading the game…</p>`;
    void deps.transport.read(deps.joinCode).then((result) => {
      // A request outlives its screen (`gotchas.md`), and this one is followed
      // by a walk off the field.
      if (!live) return;
      if (result.kind === 'ok') {
        draw(result.report, result.you);
        return;
      }
      body.innerHTML =
        result.kind === 'signed_out'
          ? `<p class="dim" data-review-unavailable="signed_out">Sign in to see this game. It is kept with your account.</p>`
          : `<p class="dim" data-review-unavailable="offline">
               This game is kept on the server, and this phone cannot reach it right now.
             </p>
             <p><button class="secondary" data-review-retry>Try again</button></p>`;
      body.querySelector('[data-review-retry]')?.addEventListener('click', load);
    });
  };

  function draw(report: GameReport, you: Color | null): void {
    // Built now, in one synchronous pass, so that the Share handler below has
    // nothing left to await. This is the whole reason the screen holds a report
    // rather than fetching one when the button is tapped.
    const pgn = pgnOf(report);
    body.innerHTML = reviewHtml(report, you, pgn, deps.joinCode);

    const say = (words: string): void => {
      const line = body.querySelector<HTMLElement>('[data-review-said]');
      if (line === null) return;
      line.textContent = words;
      line.hidden = words === '';
    };
    const toggle = body.querySelector<HTMLButtonElement>('[data-review-show]');
    const text = body.querySelector<HTMLTextAreaElement>('[data-review-text]');
    const showText = (shown: boolean): void => {
      if (text === null) return;
      text.hidden = !shown;
      if (toggle !== null) toggle.textContent = shown ? 'Hide the file' : 'Show the file';
    };
    const sayOutcome = (outcome: ShareOutcome, sent: string): void => {
      if (outcome.ok) say(outcome.tier === 'clipboard' ? 'Copied to the clipboard.' : sent);
      else if (outcome.reason === 'cancelled') say('');
      else {
        // The bottom of the ladder is a text a player can see, not one behind
        // another tap: the sentence says it is below, so it has to be.
        say('This phone would not share it. The text is below, and so is a download.');
        showText(true);
      }
    };

    body.querySelector<HTMLButtonElement>('[data-review-share]')?.addEventListener('click', () => {
      // No `await` on this path. `sharePgn` reaches `navigator.share`
      // synchronously; everything it needs was computed at mount.
      void (deps.share ?? sharePgn)({
        fileName: pgn.fileName,
        text: pgn.text,
        title: `${whereWords(report) || 'Satellite Chess'} — a game of Satellite Chess`,
        message: shareMessageWords(walksOf(report, you)[0] ?? null),
      }).then((outcome) => {
        if (live) sayOutcome(outcome, 'Sent.');
      });
    });

    body.querySelector<HTMLButtonElement>('[data-review-copy]')?.addEventListener('click', () => {
      void (deps.copy ?? copyText)(pgn.text).then((outcome) => {
        if (live) sayOutcome(outcome, 'Copied.');
      });
    });

    toggle?.addEventListener('click', () => {
      if (text !== null) showText(text.hidden !== false);
    });
  }

  load();

  return () => {
    live = false;
  };
}

/** The screen itself. Pure, so a test can read what a player would. */
export function reviewHtml(
  report: GameReport,
  you: Color | null,
  pgn: { text: string; fileName: string },
  joinCode: string,
): string {
  const mine = walksOf(report, you)[0] ?? null;
  const rows = walkRows(report, you);
  const moves = report.moves.map(moveWords);

  return `<p class="review-result" data-review-result>${escapeHtml(resultWords(report, you))}</p>
    <p class="dim" data-review-where>${escapeHtml(whereWords(report))}</p>
    <p class="record-headline" data-review-distance>${keepUnit(escapeHtml(headlineWords(mine)))}</p>
    <p class="dim" data-review-coverage>${escapeHtml(headlineDetailWords(mine))}</p>
    <dl class="record-stats" data-review-walks>
      ${rows
        .map(
          (row) => `<div>
            <dt>${escapeHtml(row.who)}</dt>
            <dd><strong>${keepUnit(escapeHtml(row.distance))}</strong><br><span class="dim">${keepUnit(escapeHtml(row.detail))}</span></dd>
          </div>`,
        )
        .join('')}
    </dl>
    ${
      moves.length === 0
        ? `<p class="dim" data-review-moves>Nobody moved.</p>`
        : `<h3>Every carry</h3>
           <ol class="review-moves" data-review-moves>
             ${moves
               .map(
                 (move) => `<li>
                   <span class="review-ply">${escapeHtml(move.ply)}</span>
                   <strong>${escapeHtml(move.san)}</strong>
                   <span class="dim">${keepUnit(escapeHtml(move.detail))}</span>
                 </li>`,
               )
               .join('')}
           </ol>`
    }
    <div class="review-pgn" data-review-pgn>
      <h3>The game as a file</h3>
      <p class="dim">${escapeHtml(PGN_EXPLANATION)}</p>
      <p>
        <button data-review-share>Share PGN</button>
        <button class="secondary" data-review-copy>Copy</button>
        <button class="secondary" data-review-show>Show the file</button>
      </p>
      <p class="dim" data-review-said hidden></p>
      <textarea class="review-text" data-review-text readonly rows="10" hidden>${escapeHtml(pgn.text)}</textarea>
      <p>
        <a data-review-download
           href="/api/game/${encodeURIComponent(joinCode)}/pgn"
           download="${escapeHtml(pgn.fileName)}">Download ${escapeHtml(pgn.fileName)}</a>
      </p>
    </div>
    <div class="record-honesty dim" data-review-honesty>
      ${DISTANCE_HONESTY.map((sentence) => `<p>${escapeHtml(sentence)}</p>`).join('')}
    </div>`;
}

/**
 * Every number held on one line with its unit. A phone's width otherwise
 * breaks "You covered 43 m" or "longest carry 41 m" before the "m", which
 * leaves a unit sitting alone under its number. Applied to escaped text, so the
 * only thing it can introduce is the entity.
 */
function keepUnit(html: string): string {
  return html.replace(/(\d) (km|m|min|s)\b/g, '$1&nbsp;$2');
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
