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
 *
 * ## The replay (stage 8.3, decision 0052)
 *
 * The board at every step of the game, with the carry that made it and both
 * players' walks over it, stepped through with Back and Next, a scrubber, or
 * a tap on a move in the list. It is drawn from the same held report, so it
 * reads the same for a live game and an archived one, and **scrubbing sends
 * nothing**: once the screen has loaded, it works with no signal.
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
import type { Units } from '../../shared/units.js';
import { displayUnits } from '../units.js';
import { pieceLook } from '../piece-look.js';
import { canvasSizePx, zoomFrameFor } from '../render.js';
import {
  type ReplayFrame,
  carryWords,
  clampPly,
  replayFens,
  replayFrame,
  replayHeadWords,
  walkNoteWords,
} from '../replay.js';
import { REPLAY_GEOMETRY, drawReplay } from '../replay-draw.js';
import { BOARD_FRAME_HTML, attachBoardZoom } from './board-gestures.js';

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
  /** Undoes whatever the drawn replay attached: its zoom, its listeners. */
  let unmountReplay: (() => void) | null = null;
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
    const units = displayUnits().get();
    body.innerHTML = reviewHtml(report, you, pgn, deps.joinCode, units);
    unmountReplay?.();
    unmountReplay = mountReplay(body, report, you ?? 'w', units);

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
        title: `${whereWords(report, units) || 'Satellite Chess'} — a game of Satellite Chess`,
        message: shareMessageWords(walksOf(report, you)[0] ?? null, units),
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
    unmountReplay?.();
    unmountReplay = null;
  };
}

/**
 * Wire the replay that {@link reviewHtml} laid out: the board, the three
 * controls, and the move list as a fourth. Opens on the last step, the
 * position the game ended in. Returns the teardown.
 */
function mountReplay(body: HTMLElement, report: GameReport, orientation: Color, units: Units): () => void {
  const section = body.querySelector<HTMLElement>('[data-replay]');
  const canvas = section?.querySelector<HTMLCanvasElement>('[data-board]') ?? null;
  if (section === null || canvas === null) return () => {};
  const fens = replayFens(report);
  const plies = fens.length - 1;
  let ply = plies;
  const looks = pieceLook();
  const scrub = section.querySelector<HTMLInputElement>('[data-replay-scrub]');
  const prev = section.querySelector<HTMLButtonElement>('[data-replay-prev]');
  const next = section.querySelector<HTMLButtonElement>('[data-replay-next]');

  const zoom = attachBoardZoom({
    canvas,
    controls: section.querySelector<HTMLElement>('[data-zoom-controls]'),
    onChange: () => paint(),
  });

  const paint = (): void => {
    const frame = replayFrame(report, fens, ply);
    const { width, height } = canvasSizePx(canvas);
    const { frame: zoomFrame } = zoomFrameFor(REPLAY_GEOMETRY, orientation, width, height);
    drawReplay(canvas, { frame, orientation, look: looks.get(), zoom: zoom.settle(zoomFrame, null) });
    // At 1x a finger on the board scrolls the page, which is long; zoomed in,
    // it pans the board instead, as on the game screen.
    canvas.style.touchAction = zoom.zoomed() ? 'none' : 'pan-y';
    describe(frame);
  };

  const describe = (frame: ReplayFrame): void => {
    // For a driver and a screen reader: which step is up.
    section.dataset.ply = String(frame.ply);
    section.dataset.fen = frame.fen.split(' ')[0] ?? '';
    const head = section.querySelector<HTMLElement>('[data-replay-head]');
    if (head) head.textContent = replayHeadWords(frame);
    const carry = section.querySelector<HTMLElement>('[data-replay-carry]');
    if (carry) carry.innerHTML = replayCarryHtml(frame, units);
    if (scrub && scrub.value !== String(frame.ply)) scrub.value = String(frame.ply);
    if (prev) prev.disabled = frame.ply <= 0;
    if (next) next.disabled = frame.ply >= frame.plies;
    for (const item of body.querySelectorAll<HTMLElement>('[data-replay-to]')) {
      const current = Number(item.dataset.replayTo) === frame.ply;
      if (current) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    }
  };

  const go = (to: number): void => {
    ply = clampPly(to, plies);
    paint();
  };

  const onPrev = () => go(ply - 1);
  const onNext = () => go(ply + 1);
  const onScrub = () => go(Number(scrub?.value ?? ply));
  const onPick = (event: Event) => {
    const item = (event.target as Element | null)?.closest<HTMLElement>('[data-replay-to]');
    if (!item) return;
    go(Number(item.dataset.replayTo));
    // The board is above the list; a player who tapped a move wants to see it.
    section.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };
  prev?.addEventListener('click', onPrev);
  next?.addEventListener('click', onNext);
  scrub?.addEventListener('input', onScrub);
  body.addEventListener('click', onPick);
  const offLook = looks.subscribe(() => paint());
  const onResize = () => paint();
  addEventListener('resize', onResize);
  paint();

  return () => {
    zoom.detach();
    offLook();
    removeEventListener('resize', onResize);
    prev?.removeEventListener('click', onPrev);
    next?.removeEventListener('click', onNext);
    scrub?.removeEventListener('input', onScrub);
    body.removeEventListener('click', onPick);
  };
}

/** The lines under the board: who moved what, where it was picked up, how far, where it went down. */
export function replayCarryHtml(frame: ReplayFrame, units: Units = 'metric'): string {
  const words = carryWords(frame.move, units);
  if (words === null) return `<p class="dim">The position before anyone moved.</p>`;
  return `<p><strong>${escapeHtml(words.who)}</strong></p>
    <p data-replay-lift><span class="replay-key replay-key-lift" aria-hidden="true"></span>${escapeHtml(words.lift)}</p>
    <p data-replay-carried>${keepUnit(escapeHtml(words.carried))}</p>
    <p data-replay-place><span class="replay-key replay-key-place" aria-hidden="true"></span>${escapeHtml(words.place)}</p>`;
}

/** The screen itself. Pure, so a test can read what a player would. */
export function reviewHtml(
  report: GameReport,
  you: Color | null,
  pgn: { text: string; fileName: string },
  joinCode: string,
  units: Units = 'metric',
): string {
  const mine = walksOf(report, you)[0] ?? null;
  const rows = walkRows(report, you, units);
  const moves = report.moves.map((move) => moveWords(move, units));

  return `<p class="review-result" data-review-result>${escapeHtml(resultWords(report, you))}</p>
    <p class="dim" data-review-where>${escapeHtml(whereWords(report, units))}</p>
    <p class="record-headline" data-review-distance>${keepUnit(escapeHtml(headlineWords(mine, units)))}</p>
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
    ${replayHtml(report, units)}
    ${
      moves.length === 0
        ? `<p class="dim" data-review-moves>Nobody moved.</p>`
        : `<h3>Every carry</h3>
           <p class="dim">Tap a move to see it on the board.</p>
           <ol class="review-moves" data-review-moves>
             ${moves
               .map(
                 (move, index) => `<li><button type="button" class="review-move" data-replay-to="${index + 1}">
                   <span class="review-ply">${escapeHtml(move.ply)}</span>
                   <strong>${escapeHtml(move.san)}</strong>
                   <span class="dim">${keepUnit(escapeHtml(move.detail))}</span>
                 </button></li>`,
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
 * The replay's frame: a heading, the board, and the controls. Drawn by
 * {@link mountReplay}; laid out here so a test can read it. A game with no
 * moves has nothing to step through and gets no replay.
 */
function replayHtml(report: GameReport, units: Units): string {
  const fens = replayFens(report);
  const plies = fens.length - 1;
  if (plies === 0) return '';
  const last = replayFrame(report, fens, plies);
  return `<section class="review-replay" data-replay data-ply="${plies}">
      <h3>Replay</h3>
      <p class="review-replay-head" data-replay-head>${escapeHtml(replayHeadWords(last))}</p>
      ${BOARD_FRAME_HTML}
      <div class="replay-controls">
        <button type="button" class="secondary" data-replay-prev aria-label="Back one step">‹ Back</button>
        <input type="range" min="0" max="${plies}" step="1" value="${plies}" data-replay-scrub
               aria-label="Step through the game">
        <button type="button" class="secondary" data-replay-next aria-label="Forward one step" disabled>Next ›</button>
      </div>
      <div class="replay-carry" data-replay-carry>${replayCarryHtml(last, units)}</div>
      <p class="dim" data-replay-note>${escapeHtml(walkNoteWords(report))}</p>
    </section>`;
}

/**
 * Every number held on one line with its unit. A phone's width otherwise
 * breaks "You covered 43 m" or "longest carry 41 m" before the "m", which
 * leaves a unit sitting alone under its number. Applied to escaped text, so the
 * only thing it can introduce is the entity.
 */
function keepUnit(html: string): string {
  return html.replace(/(\d) (km|m|mi|yd|ft|min|s)\b/g, '$1&nbsp;$2');
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
