/**
 * The board's pinch zoom, wired to a canvas and two small buttons.
 *
 * The arithmetic and the tap-or-gesture rule are in `client/board-zoom.ts`,
 * where they are unit-tested; this file only feeds it pointer events and
 * shows or hides the buttons. Shared by the game screen and the practice
 * board, which draw through the same `drawBoard`.
 *
 * No double-tap to reset (decision 0046). On this board two quick taps on one
 * square are a lift and a put-back, so a double-tap gesture would either eat a
 * real pair of taps or make a move on the way to resetting the view. The reset
 * is a button instead, shown only while zoomed.
 */

import { BoardGesture, type Point, type ZoomFrame, type ZoomView, isZoomed } from '../board-zoom.js';

export interface BoardZoom {
  /**
   * The view to draw with, given the canvas as it is now and the player's dot
   * in unzoomed canvas pixels. Call on every paint.
   */
  settle(frame: ZoomFrame, dot: Point | null): ZoomView;
  /** Whether the board is zoomed in at all. The simulator's drag stands down while it is. */
  zoomed(): boolean;
  /** Back to the whole board, following. */
  reset(): void;
  detach(): void;
}

export interface BoardZoomDeps {
  canvas: HTMLCanvasElement;
  /** Holds `[data-zoom-follow]` and `[data-zoom-reset]`; hidden at 1x. */
  controls: HTMLElement | null;
  /** A tap, in canvas CSS pixels. Only ever a tap: never the end of a pan or a pinch. */
  onTap?(at: Point): void;
  /** The view changed: repaint. */
  onChange(): void;
}

export function attachBoardZoom(deps: BoardZoomDeps): BoardZoom {
  const { canvas, controls } = deps;
  const gesture = new BoardGesture();
  const follow = controls?.querySelector<HTMLButtonElement>('[data-zoom-follow]') ?? null;
  const reset = controls?.querySelector<HTMLButtonElement>('[data-zoom-reset]') ?? null;
  let hasDot = false;

  const local = (event: PointerEvent): Point => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const syncControls = () => {
    const zoomed = isZoomed(gesture.zoom);
    // For the browser driver (`scripts/check-zoom.mjs`), which has to aim at a
    // square on a zoomed board: the view as `k tx ty`.
    const { k, tx, ty } = gesture.zoom;
    canvas.dataset.zoom = `${k} ${tx} ${ty}`;
    if (controls) controls.hidden = !zoomed;
    if (follow) follow.hidden = !zoomed || gesture.isFollowing || !hasDot;
  };

  const onDown = (event: PointerEvent) => {
    const p = local(event);
    gesture.down(event.pointerId, p.x, p.y, event.isPrimary);
    // So a finger that slides off the canvas mid-pan still reports its lift
    // here. Throws for a pointer the browser does not know (a synthetic one).
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Nothing to capture.
    }
  };
  // A finger reports moves faster than the screen refreshes, and each paint
  // redraws the whole board, so moves are repainted at most once a frame.
  let frameQueued: number | null = null;
  const onMove = (event: PointerEvent) => {
    const p = local(event);
    if (!gesture.move(event.pointerId, p.x, p.y) || frameQueued !== null) return;
    frameQueued = requestAnimationFrame(() => {
      frameQueued = null;
      deps.onChange();
    });
  };
  const onUp = (event: PointerEvent) => {
    const p = local(event);
    const tap = gesture.up(event.pointerId, p.x, p.y);
    // The tap first, through the projection the player was looking at when
    // they aimed. The repaint after it may move the view — following stands
    // down while a finger is on the glass and resumes here — and a tap mapped
    // through that newer view could name the square next door.
    if (tap) deps.onTap?.(tap);
    // Repaint either way: a gesture that has just ended may have stopped
    // following, which changes the buttons.
    deps.onChange();
  };
  const onCancel = (event: PointerEvent) => {
    gesture.cancel(event.pointerId);
    deps.onChange();
  };
  // The browser took the capture back without a lift (the element was hidden,
  // another element captured it). After a normal lift this arrives for a
  // finger already forgotten, and `cancel` ignores it.
  const onLostCapture = (event: PointerEvent) => gesture.cancel(event.pointerId);
  const onFollow = () => {
    gesture.followMe();
    deps.onChange();
  };
  const onReset = () => {
    gesture.reset();
    deps.onChange();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('lostpointercapture', onLostCapture);
  follow?.addEventListener('click', onFollow);
  reset?.addEventListener('click', onReset);
  syncControls();

  return {
    settle(frame, dot) {
      hasDot = dot !== null;
      const view = gesture.settle(frame, dot);
      syncControls();
      return view;
    },
    zoomed: () => isZoomed(gesture.zoom),
    reset() {
      gesture.reset();
      syncControls();
    },
    detach() {
      if (frameQueued !== null) cancelAnimationFrame(frameQueued);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('lostpointercapture', onLostCapture);
      follow?.removeEventListener('click', onFollow);
      reset?.removeEventListener('click', onReset);
    },
  };
}

/** The markup for the canvas and its two buttons, the same on both screens. */
export const BOARD_FRAME_HTML = `
  <div class="board-frame">
    <canvas data-board></canvas>
    <div class="zoom-controls" data-zoom-controls hidden>
      <button type="button" class="secondary" data-zoom-follow hidden>Follow me</button>
      <button type="button" class="secondary" data-zoom-reset>Whole board</button>
    </div>
  </div>`;
