/**
 * The board screen: a field, drawn as a chessboard, with you on it.
 *
 * No chess yet — this is phase 1, so the pieces are the starting position and
 * nothing moves. What is being proved here is the part the whole concept rests
 * on: that standing somewhere real puts you on a square, and that the reach
 * circle reads as a fair statement of what you can touch.
 */

import { type FieldSpec, deriveGeometry, fromBoardPoint } from '../../shared/field.js';
import type { LatLng } from '../../shared/geo.js';
import { DEFAULT_REACH, accuracyTooPoor, effectiveReachM } from '../../shared/reach.js';
import { type Color, toSquare } from '../../shared/squares.js';
import { toBoardPoint } from '../../shared/field.js';
import { type GpsProvider, type GpsState, qualityLabel } from '../gps.js';
import { type Projection, drawBoard, squareUnderFoot, startingPieces } from '../render.js';
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
  onCanvas?(canvas: HTMLCanvasElement, toLatLng: (x: number, y: number) => LatLng): void;
}

export function mountBoard(root: HTMLElement, deps: BoardDeps): () => void {
  const geo = deriveGeometry(deps.field);
  const orientation = deps.orientation ?? 'w';
  const pieces = startingPieces();

  root.innerHTML = `
    <div class="board-screen">
      <canvas data-board></canvas>
      <div class="board-status">
        <dl class="readout">
          <dt>On</dt><dd data-square>—</dd>
          <dt>Reach</dt><dd data-reach>—</dd>
          <dt>Signal</dt><dd data-quality>—</dd>
        </dl>
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

  const paint = () => {
    const fix = state.fix;
    const accuracyM = fix?.accuracyM ?? 0;
    const reachM = effectiveReachM(accuracyM);

    projection = drawBoard(canvas, {
      geo,
      orientation,
      pieces,
      pos: fix?.pos ?? null,
      accuracyM,
      reachM,
    });

    const here = fix ? toBoardPoint(geo, fix.pos) : null;
    const under = here ? squareUnderFoot(geo, here) : null;
    set('[data-square]', under ? toSquare(under.file, under.rank) : fix ? 'off the board' : '—');
    // Reach is meaningless when the fix is too poor to move on, and saying a
    // number there would imply the game would accept a move.
    set(
      '[data-reach]',
      !fix ? '—' : accuracyTooPoor(accuracyM, DEFAULT_REACH) ? 'too vague' : `${reachM.toFixed(1)} m`,
    );
    set('[data-quality]', fix ? `${qualityLabel(state.quality)} ±${accuracyM.toFixed(0)} m` : 'waiting');
  };

  const set = (selector: string, text: string) => {
    const el = root.querySelector(selector);
    if (el) el.textContent = text;
  };

  const unsubscribe = deps.gps.subscribe((next) => {
    state = next;
    paint();
  });

  paint();
  deps.onCanvas?.(canvas, (x, y) =>
    projection ? fromBoardPoint(geo, projection.toBoard(x, y)) : deps.field.a1,
  );

  // The canvas is sized from its box, so a rotation has to redraw it.
  const onResize = () => paint();
  addEventListener('resize', onResize);

  return () => {
    unsubscribe();
    removeEventListener('resize', onResize);
    void screenLock.release();
    root.innerHTML = '';
  };
}
