/**
 * The preview board: a field, drawn as a chessboard, with you on it, and
 * nobody else (O-49, decision 0051).
 *
 * It began in phase 1 as the screen that proved standing somewhere real puts
 * you on a square. It is now how a field is tried out before anybody is asked
 * to come and play on it: the square you resolve to, the reach circle and the
 * leeway a game would use, the accuracy the phone claims, and a plain verdict
 * on whether that is playable. Tap a square to ask whether a lift or a place
 * there would count from where you stand.
 *
 * **Nothing here is sent.** The verdict and the tap test run the game's own
 * reach rule on this phone (`client/preview.ts` over `shared/reach.ts`), so
 * the screen works with no signal on a field already saved to the phone, and
 * costs no requests. The reach dial is in memory, for this visit only.
 */

import {
  type FieldSpec,
  boardIndexOf,
  deriveGeometry,
  fromBoardPoint,
  toBoardPoint,
} from '../../shared/field.js';
import type { LatLng } from '../../shared/geo.js';
import {
  DEFAULT_REACH,
  MAX_REACH_SQUARES,
  MIN_REACH_SQUARES,
  REACH_STEP_SQUARES,
  accuracyTooPoor,
  clampReachSquares,
  reachFromSquares,
  refusedAccuracyWords,
} from '../../shared/reach.js';
import { type Color, type Square, toSquare } from '../../shared/squares.js';
import { type GpsProvider, type GpsState, qualityLabel } from '../gps.js';
import { pieceLook } from '../piece-look.js';
import { type PreviewLevel, previewVerdict, testSquare } from '../preview.js';
import { lengthWords } from '../../shared/units.js';
import { displayUnits } from '../units.js';
import {
  type Projection,
  canvasSizePx,
  drawBoard,
  squareUnderFoot,
  startingPieces,
  zoomFrameFor,
} from '../render.js';
import { BOARD_FRAME_HTML, attachBoardZoom } from './board-gestures.js';
import { browserScreenLockOptions, createScreenLock } from '../wakelock.js';

export interface BoardDeps {
  gps: GpsProvider;
  field: FieldSpec;
  /** Whose side is at the bottom. No game yet, so this is just a preference. */
  orientation?: Color;
  onBack(): void;
  /**
   * Called after the first paint with a way to turn a canvas touch into a
   * place on the field. Only the simulator uses it.
   */
  onCanvas?(
    canvas: HTMLCanvasElement,
    toLatLng: (x: number, y: number) => LatLng,
    zoomed: () => boolean,
  ): void;
}

/** The verdict box's look: red for no, amber for maybe, green for yes. */
const LEVEL_CLASS: Record<PreviewLevel, string> = {
  good: 'notice ok',
  tight: 'notice warning',
  poor: 'notice',
  refused: 'notice',
  waiting: 'notice quiet',
};

const TEST_HINT =
  'Tap a square to test whether a lift or a place there would count from where you stand.';

export function mountBoard(root: HTMLElement, deps: BoardDeps): () => void {
  const geo = deriveGeometry(deps.field);
  const orientation = deps.orientation ?? 'w';
  const pieces = startingPieces();

  root.innerHTML = `
    <div class="board-screen">
      ${BOARD_FRAME_HTML}
      <div class="board-status">
        <div class="notice quiet preview-verdict" data-verdict>
          <strong data-verdict-head>—</strong>
          <p data-verdict-why></p>
          <div data-verdict-notes></div>
        </div>
        <dl class="readout">
          <dt>On</dt><dd data-square>—</dd>
          <dt>Reach</dt><dd data-reach>—</dd>
          <dt>Leeway</dt><dd data-leeway>—</dd>
          <dt>Signal</dt><dd data-quality>—</dd>
          <dt>Pieces</dt><dd><button class="look-toggle" data-look-toggle aria-label="Switch piece look">—</button></dd>
        </dl>
        <p class="preview-test" data-test>${TEST_HINT}</p>
        <p class="dim">Leeway is how far your dot can stray from the middle of the square you
          stand on before a move there is refused.</p>
        <div class="stepper" data-reach-stepper>
          <button data-reach-step="-${REACH_STEP_SQUARES}" class="secondary" aria-label="Less reach">−</button>
          <strong data-reach-squares>—</strong>
          <button data-reach-step="${REACH_STEP_SQUARES}" class="secondary" aria-label="More reach">+</button>
        </div>
        <p class="dim">The reach a game is created with. Try it here; nothing is saved.</p>
        <p class="dim" data-edges>The phone cannot see fences, trees or water. Walk the four
          edges to check the whole board is ground you can play on.</p>
        <p class="dim">Trying ${escapeHtml(deps.field.name)} alone. Nothing is sent.</p>
        <p><button data-back class="secondary">Back</button></p>
      </div>
    </div>
  `;

  const canvas = root.querySelector<HTMLCanvasElement>('[data-board]')!;
  root.querySelector<HTMLButtonElement>('[data-back]')?.addEventListener('click', deps.onBack);

  // The board is the screen you walk with, so it is the screen that must not
  // sleep. Held for exactly as long as this view is mounted.
  const screenLock = createScreenLock(browserScreenLockOptions());
  void screenLock.acquire();

  let state: GpsState = deps.gps.state;
  let projection: Projection | null = null;
  const looks = pieceLook();
  /** The reach dial, in squares. In memory only: this visit, this screen. */
  let reachSquares = DEFAULT_REACH.baseSquares;
  /** The square last tapped, tested again on every fix as the player walks. */
  let target: Square | null = null;

  // The same pinch zoom as the game screen (stage 10.8). A tap tests the
  // square under it, through the projection the player was looking at.
  const zoom = attachBoardZoom({
    canvas,
    controls: root.querySelector<HTMLElement>('[data-zoom-controls]'),
    onTap: (at) => {
      const square = squareAtPointer(at.x, at.y);
      // A tap off the board clears the test rather than leaving a stale one.
      target = square;
      paint();
    },
    onChange: () => paint(),
  });

  function squareAtPointer(x: number, y: number): Square | null {
    if (!projection) return null;
    // Through the affine inverse, as the game screen does: on a skewed board
    // only the fitted board knows which square a place on the glass is.
    const bi = boardIndexOf(geo, projection.toBoard(x, y));
    const file = Math.round(bi.file);
    const rank = Math.round(bi.rank);
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return toSquare(file, rank);
  }

  const paint = () => {
    const fix = state.fix;
    const units = displayUnits().get();
    const cfg = reachFromSquares(reachSquares);
    const accuracyM = fix?.accuracyM ?? 0;
    const verdict = previewVerdict(geo, fix ? fix.accuracyM : null, cfg, units);
    const reachM = verdict.reachM;
    const { width, height } = canvasSizePx(canvas);
    const { frame, base } = zoomFrameFor(geo, orientation, width, height);

    projection = drawBoard(canvas, {
      geo,
      zoom: zoom.settle(frame, fix ? base.toScreen(toBoardPoint(geo, fix.pos)) : null),
      orientation,
      pieces,
      pos: fix?.pos ?? null,
      accuracyM,
      reachM,
      look: looks.get(),
      target,
    });

    const here = fix ? toBoardPoint(geo, fix.pos) : null;
    const under = here ? squareUnderFoot(geo, here) : null;
    set('[data-square]', under ? toSquare(under.file, under.rank) : fix ? 'off the board' : '—');
    // Reach is meaningless when the fix is too poor to move on, and saying a
    // number there would imply the game would accept a move.
    const vague = fix !== null && accuracyTooPoor(accuracyM, cfg);
    set('[data-reach]', !fix ? '—' : vague ? 'too vague' : lengthWords(reachM, units, 1));
    set('[data-leeway]', lengthWords(verdict.leewayM, units, 1));
    set(
      '[data-quality]',
      // To one decimal, as the verdict sentence says it, so the two agree. A
      // fix too vague to move on reads exactly as the "Not playable" sentence
      // and the tap test say it: past the limit, never level with it.
      fix
        ? `${qualityLabel(state.quality)} ${
            vague
              ? refusedAccuracyWords(accuracyM, cfg.maxAccuracyM, units)
              : `±${lengthWords(accuracyM, units, 1)}`
          }`
        : 'waiting',
    );

    const box = root.querySelector<HTMLElement>('[data-verdict]');
    if (box) {
      box.className = `${LEVEL_CLASS[verdict.level]} preview-verdict`;
      box.dataset.level = verdict.level;
    }
    set('[data-verdict-head]', verdict.headline);
    set('[data-verdict-why]', verdict.reason);
    const notes = root.querySelector<HTMLElement>('[data-verdict-notes]');
    if (notes) {
      const html = verdict.notes.map((n) => `<p data-verdict-note>${escapeHtml(n)}</p>`).join('');
      // Only when it changed, so a fix a second does not churn the DOM.
      if (notes.innerHTML !== html) notes.innerHTML = html;
    }

    const test = root.querySelector<HTMLElement>('[data-test]');
    if (test && target !== null) {
      const result = testSquare(geo, fix ? { pos: fix.pos, accuracyM: fix.accuracyM } : null, target, cfg, units);
      test.textContent = result.words;
      test.dataset.square = result.square;
      test.dataset.ok = result.ok === null ? 'unknown' : String(result.ok);
    } else if (test && test.dataset.square !== undefined) {
      test.textContent = TEST_HINT;
      delete test.dataset.square;
      delete test.dataset.ok;
    }

    set('[data-reach-squares]', `${formatSquares(reachSquares)} squares`);
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-reach-step]')) {
      const step = Number(button.dataset.reachStep);
      button.disabled = step < 0 ? reachSquares <= MIN_REACH_SQUARES : reachSquares >= MAX_REACH_SQUARES;
    }
    const lookToggle = root.querySelector<HTMLButtonElement>('[data-look-toggle]');
    if (lookToggle) lookToggle.textContent = looks.get() === 'disc' ? 'On discs' : 'Standard';
  };

  const set = (selector: string, text: string) => {
    const el = root.querySelector(selector);
    if (el && el.textContent !== text) el.textContent = text;
  };

  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-reach-step]')) {
    button.addEventListener('click', () => {
      reachSquares = clampReachSquares(reachSquares + Number(button.dataset.reachStep));
      paint();
    });
  }
  // The look switch, as on the game screen (decision 0045), so both looks can
  // be compared on the field before a game rather than during one.
  root.querySelector<HTMLButtonElement>('[data-look-toggle]')?.addEventListener('click', () => {
    looks.set(looks.get() === 'disc' ? 'standard' : 'disc');
  });

  const unsubscribe = deps.gps.subscribe((next) => {
    state = next;
    paint();
  });

  paint();
  deps.onCanvas?.(
    canvas,
    (x, y) => (projection ? fromBoardPoint(geo, projection.toBoard(x, y)) : deps.field.a1),
    zoom.zoomed,
  );

  // The canvas is sized from its box, so a rotation has to redraw it.
  const onResize = () => paint();
  addEventListener('resize', onResize);
  const offLook = looks.subscribe(() => paint());

  return () => {
    offLook();
    zoom.detach();
    unsubscribe();
    removeEventListener('resize', onResize);
    void screenLock.release();
    root.innerHTML = '';
  };
}

/** Two decimals at most, and no trailing zeroes: 0.4, 0.45, 1.5. As the create screen says it. */
function formatSquares(squares: number): string {
  return String(Number(squares.toFixed(2)));
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
