/**
 * Pinch zoom on the board: the arithmetic, and telling a tap from a gesture.
 *
 * On a long thin field a square can be a few pixels tall and a piece about
 * seven, so the board can be zoomed (stage 10.8, decision 0046). The zoom is a
 * uniform scale and a shift **in screen space**, applied on top of the fitted
 * projection in `render.ts`: no rotation, so the north arrow still points the
 * right way, and nothing in board space changes, so reach, legality and the
 * tap-to-square mapping all go through the same `Projection` they always did.
 *
 * Nothing here touches the DOM, and nothing is ever sent anywhere. The zoom
 * is per view and in memory: leave the board and it is gone.
 *
 * The one thing this file must get right is **that a drag is never a tap**. A
 * tap on the board lifts or places a piece, and a player panning the view
 * mid-walk who lifted something by accident has made a move they did not mean.
 * So a press becomes a tap only when it was the only finger down for its whole
 * life and never strayed more than {@link TAP_SLOP_PX} from where it landed.
 * Anything else — a pan, a pinch, a second finger, a cancel — is spent.
 */

import type { Projection } from './render.js';

/** Screen-to-screen: `zoomed = k * unzoomed + t`, in CSS pixels. */
export interface ZoomView {
  k: number;
  tx: number;
  ty: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * What a view is clamped against: the canvas, and the board's outline in
 * *unzoomed* canvas pixels.
 */
export interface ZoomFrame {
  width: number;
  height: number;
  board: Rect;
  /**
   * How far inside the canvas edge the board's edge may come once zoomed. The
   * same as the padding the unzoomed board already has, so zooming in never
   * shows more empty canvas beside the board than the whole-board view does.
   */
  margin: number;
}

export const IDENTITY: ZoomView = Object.freeze({ k: 1, tx: 0, ty: 0 });

/**
 * The most the board may be magnified. Six times turns a 7 px piece on a 5:1
 * field into a 42 px one, which is about a normal board app's size; more than
 * that and a phone shows less than one square, which is no way to walk.
 */
export const MAX_ZOOM = 6;

/**
 * How far a finger may wander and still be a tap, in CSS pixels.
 *
 * About Android's own touch slop (8 dp) and iOS's (10 pt). A walking thumb
 * that wobbles further than this has its tap ignored, and the player taps
 * again — the cheap failure. The other way round, a pan read as a tap, lifts
 * or places a piece.
 */
export const TAP_SLOP_PX = 10;

/**
 * While following, a dot that comes within this fraction of the canvas's
 * shorter side of any edge brings you back to the middle.
 *
 * Not a lock on the centre: GPS wanders a metre or two standing still, which
 * at 5x is fifty pixels, and a board that swims under a finger that is about
 * to tap is worse than one that does not follow at all. And not the smallest
 * shift that keeps you inside the band, which is what a first version did: a
 * player walking towards the top of the screen was then held against the
 * top, with nothing of where they were going in view. So the view holds
 * still, and turns the page when you reach its edge.
 */
export const FOLLOW_EDGE = 0.2;

export function isZoomed(view: ZoomView): boolean {
  return view.k > 1;
}

export function toZoomed(view: ZoomView, p: Point): Point {
  return { x: view.k * p.x + view.tx, y: view.k * p.y + view.ty };
}

export function fromZoomed(view: ZoomView, p: Point): Point {
  return { x: (p.x - view.tx) / view.k, y: (p.y - view.ty) / view.k };
}

/**
 * The fitted projection with a zoom laid over it.
 *
 * `scale` grows with the zoom, so anything sized in metres (squares, pieces,
 * the reach circle) grows with it and anything sized in pixels stays put.
 */
export function zoomProjection(base: Projection, view: ZoomView): Projection {
  if (!isZoomed(view)) return base;
  return {
    scale: base.scale * view.k,
    toScreen(bp) {
      return toZoomed(view, base.toScreen(bp));
    },
    toBoard(x, y) {
      const p = fromZoomed(view, { x, y });
      return base.toBoard(p.x, p.y);
    },
  };
}

/**
 * One axis of {@link clampView}. Where the zoomed board is narrower than the
 * canvas it is centred, which at 1x is exactly where `projectionFor` put it.
 * Where it is wider, neither edge may come further in than the margin, so
 * the board always fills the view and can never be pushed off it.
 */
function clampAxis(k: number, t: number, size: number, min: number, max: number, margin: number): number {
  const extent = k * (max - min);
  if (extent + 2 * margin <= size) return (size - k * (min + max)) / 2;
  const lo = size - margin - k * max;
  const hi = margin - k * min;
  return Math.min(hi, Math.max(lo, t));
}

/**
 * Hold a view inside its limits: 1x to {@link MAX_ZOOM}, and the board kept
 * on the canvas. Anything at or below 1x is exactly the whole board, so a
 * pinch that overshoots outwards lands on the ordinary view rather than on a
 * shrunken one.
 */
export function clampView(view: ZoomView, frame: ZoomFrame | null): ZoomView {
  const k = Math.min(MAX_ZOOM, view.k);
  if (!(k > 1) || !frame) return k > 1 ? { ...view, k } : IDENTITY;
  const { board, margin } = frame;
  return {
    k,
    tx: clampAxis(k, view.tx, frame.width, board.minX, board.maxX, margin),
    ty: clampAxis(k, view.ty, frame.height, board.minY, board.maxY, margin),
  };
}

/**
 * Two fingers, from where they went down to where they are now.
 *
 * The point of the board that was under the midpoint of the two fingers stays
 * under their midpoint, so the pinch zooms about the pinch and a two-finger
 * drag pans as well. Always computed from the gesture's start rather than
 * step by step, so rounding never accumulates over a long pinch.
 */
export function pinchView(
  start: ZoomView,
  from: [Point, Point],
  to: [Point, Point],
  frame: ZoomFrame | null,
): ZoomView {
  const d0 = Math.hypot(from[1].x - from[0].x, from[1].y - from[0].y);
  const d1 = Math.hypot(to[1].x - to[0].x, to[1].y - to[0].y);
  if (d0 < 1 || d1 < 1) return start;
  const k = Math.max(1, Math.min(MAX_ZOOM, (start.k * d1) / d0));
  const m0 = { x: (from[0].x + from[1].x) / 2, y: (from[0].y + from[1].y) / 2 };
  const m1 = { x: (to[0].x + to[1].x) / 2, y: (to[0].y + to[1].y) / 2 };
  const under = fromZoomed(start, m0);
  return clampView({ k, tx: m1.x - k * under.x, ty: m1.y - k * under.y }, frame);
}

/** One finger dragged by `dx`, `dy`. Nothing moves at 1x. */
export function panView(start: ZoomView, dx: number, dy: number, frame: ZoomFrame | null): ZoomView {
  if (!isZoomed(start)) return IDENTITY;
  return clampView({ k: start.k, tx: start.tx + dx, ty: start.ty + dy }, frame);
}

/** A view at the same zoom with `dot` (unzoomed pixels) in the middle. */
export function centreOn(view: ZoomView, dot: Point, frame: ZoomFrame): ZoomView {
  if (!isZoomed(view)) return IDENTITY;
  return clampView(
    { k: view.k, tx: frame.width / 2 - view.k * dot.x, ty: frame.height / 2 - view.k * dot.y },
    frame,
  );
}

/**
 * The view unchanged while `dot` is clear of the edge band ({@link
 * FOLLOW_EDGE}), and centred on it once it is not.
 *
 * Centred through the clamp, so a player near or off the edge of the board
 * sees the edge of the board rather than an empty canvas with a dot in it —
 * and, there, stays in the band without the view moving again, because the
 * clamped view is the same view every time.
 */
export function keepInFrame(view: ZoomView, dot: Point, frame: ZoomFrame): ZoomView {
  if (!isZoomed(view)) return IDENTITY;
  const edge = FOLLOW_EDGE * Math.min(frame.width, frame.height);
  const p = toZoomed(view, dot);
  const inside = p.x >= edge && p.x <= frame.width - edge && p.y >= edge && p.y <= frame.height - edge;
  return inside ? clampView(view, frame) : centreOn(view, dot, frame);
}

/** Whether `dot` (unzoomed pixels) is anywhere on the canvas in this view. */
export function onCanvas(view: ZoomView, dot: Point, frame: ZoomFrame): boolean {
  const p = toZoomed(view, dot);
  return p.x >= 0 && p.x <= frame.width && p.y >= 0 && p.y <= frame.height;
}

interface Finger {
  x: number;
  y: number;
}

/**
 * Pointers in, a view and taps out. Owns the zoom, and whether it follows you.
 *
 * **Following** (decision 0046): a zoomed view keeps your dot in frame as GPS
 * moves you, until you drag the view with one finger or pinch somewhere that
 * leaves you off screen — both mean "I am looking at something else". "Follow me"
 * and "Whole board" both turn it back on. Following never moves the view
 * while a finger is down, so it cannot fight a gesture.
 */
export class BoardGesture {
  private view: ZoomView = IDENTITY;
  private frame: ZoomFrame | null = null;
  private dot: Point | null = null;
  private following = true;

  private readonly fingers = new Map<number, Finger>();
  /** Where the only finger landed, while it may still be a tap. */
  private press: { id: number; x: number; y: number } | null = null;
  /**
   * Set as soon as the current touch stops being a possible tap, and cleared
   * only when every finger is up. So the last finger off after a pinch, or a
   * finger that wandered back to where it started, is never a tap.
   */
  private spent = false;
  /** One-finger pan: the view and finger position it is measured from. */
  private panFrom: { id: number; x: number; y: number; view: ZoomView } | null = null;
  /** Two-finger pinch, likewise. */
  private pinchFrom: { ids: [number, number]; at: [Point, Point]; view: ZoomView } | null = null;
  private panned = false;
  /** Whether this touch pinched at some point. */
  private pinched = false;

  get zoom(): ZoomView {
    return this.view;
  }

  get isFollowing(): boolean {
    return this.following;
  }

  /** Whether any finger is down on the board. */
  get active(): boolean {
    return this.fingers.size > 0;
  }

  /**
   * Called on every paint with the canvas as it now is and where the player's
   * dot is (unzoomed pixels, or null without a fix). Re-clamps the view — the
   * canvas may have been resized — and, if following, keeps the dot in frame.
   */
  settle(frame: ZoomFrame, dot: Point | null): ZoomView {
    // The board was re-fitted (a rotation, a keyboard) under a finger that is
    // down: the square it landed on has moved, so it is no longer a tap.
    const refitted =
      this.frame !== null && (this.frame.width !== frame.width || this.frame.height !== frame.height);
    this.frame = frame;
    if (refitted) this.moveUnderFingers();
    this.dot = dot;
    let view = clampView(this.view, frame);
    if (this.following && dot && !this.active && isZoomed(view)) view = keepInFrame(view, dot, frame);
    this.view = view;
    return view;
  }

  /**
   * Back to the whole board, following again.
   *
   * Called by the "Whole board" button, and by the game screen when the board
   * turns the other way up — which can happen mid-pinch, when the first
   * snapshot says which side this phone is. Fingers still down stay on
   * record: forgotten, each of their lifts would arrive unmatched, and a
   * lift through a board that has just been turned round is exactly the tap
   * nobody meant. So the touch is spent instead, and rebased on the new view.
   */
  reset(): void {
    this.view = IDENTITY;
    this.following = true;
    this.moveUnderFingers();
  }

  /** Put the dot in the middle, at the same zoom, and follow it from now on. */
  followMe(): void {
    this.following = true;
    if (this.dot && this.frame) this.view = centreOn(this.view, this.dot, this.frame);
    this.moveUnderFingers();
  }

  /**
   * The view has just been moved by something other than the fingers on the
   * glass. Whatever square they were over, they are not over it now, so the
   * touch can no longer be a tap; and any pan or pinch continues from the
   * new view rather than jumping back to the old one.
   */
  private moveUnderFingers(): void {
    if (this.fingers.size === 0) return;
    this.spent = true;
    this.press = null;
    this.startPinchOrPan();
  }

  /**
   * A finger went down. `primary` is the browser's `isPrimary`: true for the
   * first finger of a fresh touch, when no other is down. If fingers are still
   * on record then, their `pointerup` was lost somewhere, and holding on to
   * them would make every later tap look like a second finger — a board that
   * silently stops taking taps. So a primary finger starts afresh.
   */
  down(id: number, x: number, y: number, primary = this.fingers.size === 0): void {
    if (primary && this.fingers.size > 0) this.clearGesture();
    this.fingers.set(id, { x, y });
    if (this.fingers.size === 1) {
      this.press = this.spent ? null : { id, x, y };
      this.panFrom = { id, x, y, view: this.view };
      return;
    }
    // A second finger: whatever the first was doing, this is not a tap.
    this.spent = true;
    this.press = null;
    this.startPinchOrPan();
  }

  /** Returns whether the view changed. */
  move(id: number, x: number, y: number): boolean {
    const finger = this.fingers.get(id);
    if (!finger) return false;
    finger.x = x;
    finger.y = y;

    if (this.press && this.press.id === id) {
      if (Math.hypot(x - this.press.x, y - this.press.y) <= TAP_SLOP_PX) return false;
      this.press = null;
      this.spent = true;
    }

    const pinch = this.pinchFrom;
    if (pinch) {
      const a = this.fingers.get(pinch.ids[0]);
      const b = this.fingers.get(pinch.ids[1]);
      if (!a || !b) return false;
      return this.adopt(pinchView(pinch.view, pinch.at, [{ ...a }, { ...b }], this.frame), false);
    }
    const pan = this.panFrom;
    if (pan && pan.id === id && this.spent) {
      return this.adopt(panView(pan.view, x - pan.x, y - pan.y, this.frame), isZoomed(pan.view));
    }
    return false;
  }

  /**
   * A finger lifted. Returns the tap, if this was one, in canvas pixels.
   *
   * A `pointerup` for a finger this never saw go down is never a tap. It is
   * what a mouse dragged in from beside the canvas produces, and what any
   * bookkeeping slip here would produce — and a tap is a move, so the answer
   * to "I don't know where this finger has been" is always no. The browser
   * drivers send a `pointerdown` first, like a finger.
   */
  up(id: number, x: number, y: number): Point | null {
    if (!this.fingers.has(id)) return null;
    const press = this.press && this.press.id === id && !this.spent ? this.press : null;
    this.fingers.delete(id);
    if (this.fingers.size === 0) {
      this.endGesture();
      // Where the finger landed rather than where it lifted: within the slop
      // either way, and the landing is what the player aimed.
      return press ? { x: press.x, y: press.y } : null;
    }
    this.startPinchOrPan();
    return null;
  }

  /** The browser took the pointer back (a system gesture, a scroll). Never a tap. */
  cancel(id: number): void {
    if (!this.fingers.delete(id)) return;
    this.spent = true;
    this.press = null;
    if (this.fingers.size === 0) this.endGesture();
    else this.startPinchOrPan();
  }

  /** `panned`: moved by one finger, which is what stops following. */
  private adopt(view: ZoomView, panned: boolean): boolean {
    const changed = view.k !== this.view.k || view.tx !== this.view.tx || view.ty !== this.view.ty;
    this.view = view;
    if (changed && panned) this.panned = true;
    return changed;
  }

  /** Re-base whichever gesture the fingers now down make, from the view as it is. */
  private startPinchOrPan(): void {
    const ids = [...this.fingers.keys()];
    if (ids.length >= 2) {
      const a = this.fingers.get(ids[0])!;
      const b = this.fingers.get(ids[1])!;
      this.pinchFrom = { ids: [ids[0], ids[1]], at: [{ ...a }, { ...b }], view: this.view };
      this.panFrom = null;
      this.pinched = true;
    } else if (ids.length === 1) {
      const f = this.fingers.get(ids[0])!;
      this.pinchFrom = null;
      this.panFrom = { id: ids[0], x: f.x, y: f.y, view: this.view };
    }
  }

  private endGesture(): void {
    // A finger that dragged the view is looking at something else: stop
    // following. A pinch is not, unless it left the dot off screen — pinching
    // in on yourself is the commonest reason to zoom at all. The finger left
    // on the glass after a pinch always drifts a little, so a drag that
    // follows a pinch in the same touch is part of the pinch.
    if (this.panned && !this.pinched) this.following = false;
    if (this.dot && this.frame && isZoomed(this.view) && !onCanvas(this.view, this.dot, this.frame)) {
      this.following = false;
    }
    if (!isZoomed(this.view)) this.following = true;
    this.clearGesture();
  }

  private clearGesture(): void {
    this.fingers.clear();
    this.press = null;
    this.spent = false;
    this.panFrom = null;
    this.pinchFrom = null;
    this.panned = false;
    this.pinched = false;
  }
}
