/*!
 * Chess piece artwork: the "cburnett" set by Colin M. L. Burnett, used here
 * under the terms of the BSD license it is offered under on Wikimedia Commons
 * (File:Chess_klt45.svg and its eleven siblings, retrieved 2026-09-24; the set
 * is also offered under GFDL and GPL, which this project does not rely on).
 *
 * Copyright (c) 2006 Colin M. L. Burnett. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 * 3. Neither the name of Colin M. L. Burnett nor the names of its contributors
 *    may be used to endorse or promote products derived from this software
 *    without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY COLIN M. L. BURNETT "AS IS" AND ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO
 * EVENT SHALL COLIN M. L. BURNETT BE LIABLE FOR ANY DIRECT, INDIRECT,
 * INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA,
 * OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 * LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 * NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
 * EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * How a chess piece looks, everywhere one is drawn (decision 0045).
 *
 * The pieces are the standard two-sided set that lichess and Wikipedia use:
 * white pieces are white with black line work, black pieces are black with
 * white interior lines. Players have read that convention for decades, and the
 * owner's outdoor games (O-30) showed that a home-made one-glyph-two-fills
 * scheme was not readable at a glance. This module is the art, transcribed
 * path for path from the SVG files, plus one function to draw a piece on a
 * canvas and one to write it as inline SVG, so the board, the carry readout and
 * the promotion picker all show the same pieces.
 *
 * It is bundled into `app.js`, never fetched: the service worker caches the
 * shell for a field with no signal, and a piece set on a CDN would be a board
 * of blanks there.
 *
 * ## Two looks
 *
 * - **`standard`**: the set as drawn above.
 * - **`disc`**: the owner's alternative. Each piece sits on a disc of its own
 *   team's color with a gray ring, so which side a piece belongs to is a large
 *   round patch rather than a thin line. The ring is gray (neither side's
 *   color) so that a white disc still shows on a light square and a black disc
 *   on a dark one. On its black disc, a black piece's outline is drawn in the
 *   same gray, because a black outline on a black disc would leave a pawn
 *   invisible. Nothing on a piece ever takes the *opponent's* color, which was
 *   the complaint in O-30.
 *
 * Each art layer names an *ink* ("body", "line", "detail") rather than a
 * color, and the look decides what each ink is. That keeps the twelve pieces
 * as faithful copies of the source while letting the disc look change one
 * color.
 */

import type { Color } from '../shared/squares.js';
import type { Piece, PieceType } from './render.js';

export type PieceLook = 'standard' | 'disc';

/**
 * The artwork's license, for the credits on the account screen.
 *
 * The BSD terms ask that a binary redistribution reproduce the notice "in the
 * documentation and/or other materials provided with the distribution". For a
 * web app the screen is the documentation a player has, and it is in the
 * bundle, so it is there with no signal too. `NOTICE` carries the same text in
 * the repository.
 */
export const PIECE_ART_CREDIT =
  'Chess pieces by Colin M. L. Burnett ("cburnett"), from Wikimedia Commons, used under the BSD license.';

export const PIECE_ART_LICENSE = `Copyright (c) 2006 Colin M. L. Burnett. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of Colin M. L. Burnett nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY COLIN M. L. BURNETT "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL COLIN M. L. BURNETT BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

export const PIECE_LOOKS: readonly PieceLook[] = ['standard', 'disc'];

type Ink = 'body' | 'line' | 'detail';

interface ArtLayer {
  d: string;
  fill?: Ink;
  stroke?: Ink;
  /** In the art's own units, a 45 x 45 box. The source's default is 1.5. */
  width?: number;
  cap?: 'butt' | 'round';
  join?: 'miter' | 'round';
  /** An SVG `matrix(a b c d e f)`, used once, for the knight's eye. */
  transform?: readonly [number, number, number, number, number, number];
}

interface PieceArt {
  /** The source's own nudge down its box, in art units. */
  dy: number;
  rule: CanvasFillRule;
  layers: readonly ArtLayer[];
}

/** The size of the source's box, in its own units. */
const ART_BOX = 45;

/**
 * The gray of a disc's ring, and of a black piece's outline on its disc.
 *
 * Mid-gray on purpose: about 3.5:1 against a white disc, 2.7:1 against the
 * light square and 6:1 against black, so the ring separates a white disc from
 * a light square and the outline separates a black piece from its disc.
 */
export const DISC_RING = '#8a8a8a';

/** A circle as a path, since the source uses `<circle>` for the queen's crown. */
function circle(cx: number, cy: number, r: number): string {
  return `M ${cx + r},${cy} A ${r},${r} 0 1 1 ${cx - r},${cy} A ${r},${r} 0 1 1 ${cx + r},${cy} z`;
}

const QUEEN_BALLS = [
  circle(6, 12, 2),
  circle(14, 9, 2),
  circle(22.5, 8, 2),
  circle(31, 9, 2),
  circle(39, 12, 2),
];

const KING_BODY =
  'M 12.5,37 C 18,40.5 27,40.5 32.5,37 L 32.5,30 C 32.5,30 41.5,25.5 38.5,19.5 C 34.5,13 25,16 22.5,23.5 L 22.5,27 L 22.5,23.5 C 20,16 10.5,13 6.5,19.5 C 3.5,25.5 12.5,30 12.5,30 L 12.5,37';
const KING_HEAD =
  'M 22.5,25 C 22.5,25 27,17.5 25.5,14.5 C 25.5,14.5 24.5,12 22.5,12 C 20.5,12 19.5,14.5 19.5,14.5 C 18,17.5 22.5,25 22.5,25';
const KING_BANDS =
  'M 12.5,30 C 18,27 27,27 32.5,30 M 12.5,33.5 C 18,30.5 27,30.5 32.5,33.5 M 12.5,37 C 18,34 27,34 32.5,37';

const BISHOP_BASE =
  'M 9,36 C 12.39,35.03 19.11,36.43 22.5,34 C 25.89,36.43 32.61,35.03 36,36 C 36,36 37.65,36.54 39,38 C 38.32,38.97 37.35,38.99 36,38.5 C 32.61,37.53 25.89,38.96 22.5,37.5 C 19.11,38.96 12.39,37.53 9,38.5 C 7.65,38.99 6.68,38.97 6,38 C 7.35,36.54 9,36 9,36 z';
const BISHOP_BODY =
  'M 15,32 C 17.5,34.5 27.5,34.5 30,32 C 30.5,30.5 30,30 30,30 C 30,27.5 27.5,26 27.5,26 C 33,24.5 33.5,14.5 22.5,10.5 C 11.5,14.5 12,24.5 17.5,26 C 17.5,26 15,27.5 15,30 C 15,30 14.5,30.5 15,32 z';
const BISHOP_TOP = 'M 25 8 A 2.5 2.5 0 1 1 20,8 A 2.5 2.5 0 1 1 25 8 z';
const BISHOP_MITRE = 'M 17.5,26 L 27.5,26 M 15,30 L 30,30 M 22.5,15.5 L 22.5,20.5 M 20,18 L 25,18';

const KNIGHT_NECK = 'M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18';
const KNIGHT_HEAD =
  'M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10';
const KNIGHT_NOSTRIL = 'M 9.5 25.5 A 0.5 0.5 0 1 1 8.5,25.5 A 0.5 0.5 0 1 1 9.5 25.5 z';
const KNIGHT_EYE = 'M 15 15.5 A 0.5 1.5 0 1 1 14,15.5 A 0.5 1.5 0 1 1 15 15.5 z';
const KNIGHT_EYE_MATRIX = [0.866, 0.5, -0.5, 0.866, 9.693, -5.173] as const;
const KNIGHT_MANE =
  'M 24.55,10.4 L 24.1,11.85 L 24.6,12 C 27.75,13 30.25,14.49 32.5,18.75 C 34.75,23.01 35.75,29.06 35.25,39 L 35.2,39.5 L 37.45,39.5 L 37.5,39 C 38,28.94 36.62,22.15 34.25,17.66 C 31.88,13.17 28.46,11.02 25.06,10.5 L 24.55,10.4 z';

const PAWN =
  'm 22.5,9 c -2.21,0 -4,1.79 -4,4 0,0.89 0.29,1.71 0.78,2.38 C 17.33,16.5 16,18.59 16,21 c 0,2.03 0.94,3.84 2.41,5.03 C 15.41,27.09 11,31.58 11,39.5 H 34 C 34,31.58 29.59,27.09 26.59,26.03 28.06,24.84 29,23.03 29,21 29,18.59 27.67,16.5 25.72,15.38 26.21,14.71 26.5,13.89 26.5,13 c 0,-2.21 -1.79,-4 -4,-4 z';

const QUEEN_CROWN =
  'M 9,26 C 17.5,24.5 30,24.5 36,26 L 38.5,13.5 L 31,25 L 30.7,10.9 L 25.5,24.5 L 22.5,10 L 19.5,24.5 L 14.3,10.9 L 14,25 L 6.5,13.5 L 9,26 z';
const QUEEN_BASE =
  'M 9,26 C 9,28 10.5,28 11.5,30 C 12.5,31.5 12.5,31 12,33.5 C 10.5,34.5 11,36 11,36 C 9.5,37.5 11,38.5 11,38.5 C 17.5,39.5 27.5,39.5 34,38.5 C 34,38.5 35.5,37.5 34,36 C 34,36 34.5,34.5 33,33.5 C 32.5,31 32.5,31.5 33.5,30 C 34.5,28 36,28 36,26 C 27.5,24.5 17.5,24.5 9,26 z';
const QUEEN_BAND_1 = 'M 11.5,30 C 15,29 30,29 33.5,30';
const QUEEN_BAND_2 = 'M 12,33.5 C 18,32.5 27,32.5 33,33.5';

/** A filled, outlined shape: the commonest layer in the set. */
const solid = (d: string, extra: Partial<ArtLayer> = {}): ArtLayer => ({
  d,
  fill: 'body',
  stroke: 'line',
  ...extra,
});

/**
 * The twelve pieces, one entry per file on Commons (`Chess_{p}{l|d}t45.svg`).
 *
 * The white and black versions are not recolorings of each other: the black
 * set carries extra white lines (the king's inner arcs, the queen's bands, the
 * rook's courses, the knight's mane) that the white set draws in black or not
 * at all. They are therefore copied separately.
 */
const ART: Record<Color, Record<PieceType, PieceArt>> = {
  w: {
    k: {
      dy: 0,
      rule: 'evenodd',
      layers: [
        { d: 'M 22.5,11.63 L 22.5,6 M 20,8 L 25,8', stroke: 'line', join: 'miter' },
        solid(KING_HEAD, { cap: 'butt', join: 'miter' }),
        solid(KING_BODY),
        { d: KING_BANDS, stroke: 'line' },
      ],
    },
    q: {
      dy: 0,
      rule: 'nonzero',
      layers: [
        solid(QUEEN_CROWN, { cap: 'butt' }),
        solid(QUEEN_BASE, { cap: 'butt' }),
        { d: QUEEN_BAND_1, stroke: 'line', cap: 'butt' },
        { d: QUEEN_BAND_2, stroke: 'line', cap: 'butt' },
        ...QUEEN_BALLS.map((d) => solid(d, { cap: 'butt' })),
      ],
    },
    r: {
      dy: 0.3,
      rule: 'evenodd',
      layers: [
        solid('M 9,39 L 36,39 L 36,36 L 9,36 L 9,39 z', { cap: 'butt' }),
        solid('M 12,36 L 12,32 L 33,32 L 33,36 L 12,36 z', { cap: 'butt' }),
        solid('M 11,14 L 11,9 L 15,9 L 15,11 L 20,11 L 20,9 L 25,9 L 25,11 L 30,11 L 30,9 L 34,9 L 34,14', {
          cap: 'butt',
        }),
        solid('M 34,14 L 31,17 L 14,17 L 11,14'),
        solid('M 31,17 L 31,29.5 L 14,29.5 L 14,17', { cap: 'butt', join: 'miter' }),
        solid('M 31,29.5 L 32.5,32 L 12.5,32 L 14,29.5'),
        { d: 'M 11,14 L 34,14', stroke: 'line', join: 'miter' },
      ],
    },
    b: {
      dy: 0.6,
      rule: 'evenodd',
      layers: [
        solid(BISHOP_BASE, { cap: 'butt' }),
        solid(BISHOP_BODY, { cap: 'butt' }),
        solid(BISHOP_TOP, { cap: 'butt' }),
        { d: BISHOP_MITRE, stroke: 'line', join: 'miter' },
      ],
    },
    n: {
      dy: 0.3,
      rule: 'evenodd',
      layers: [
        solid(KNIGHT_NECK),
        solid(KNIGHT_HEAD),
        { d: KNIGHT_NOSTRIL, fill: 'line', stroke: 'line' },
        { d: KNIGHT_EYE, fill: 'line', stroke: 'line', transform: KNIGHT_EYE_MATRIX },
      ],
    },
    p: {
      dy: 0,
      rule: 'nonzero',
      layers: [solid(PAWN, { join: 'miter' })],
    },
  },
  b: {
    k: {
      dy: 0,
      rule: 'evenodd',
      layers: [
        { d: 'M 22.5,11.63 L 22.5,6 M 20,8 L 25,8', stroke: 'line', join: 'miter' },
        solid(KING_HEAD, { cap: 'butt', join: 'miter' }),
        solid(KING_BODY),
        {
          d: 'M 32,29.5 C 32,29.5 40.5,25.5 38.03,19.85 C 34.15,14 25,18 22.5,24.5 L 22.5,26.6 L 22.5,24.5 C 20,18 10.85,14 6.97,19.85 C 4.5,25.5 13,29.5 13,29.5',
          stroke: 'detail',
        },
        { d: KING_BANDS, stroke: 'detail' },
      ],
    },
    q: {
      dy: 0,
      rule: 'nonzero',
      layers: [
        solid(QUEEN_CROWN, { cap: 'butt' }),
        solid(QUEEN_BASE),
        solid(QUEEN_BAND_1),
        solid(QUEEN_BAND_2),
        ...QUEEN_BALLS.map((d) => solid(d)),
        { d: 'M 11,38.5 A 35,35 1 0 0 34,38.5', stroke: 'line', cap: 'butt' },
        {
          d: 'M 11,29 A 35,35 1 0 1 34,29 M 12.5,31.5 L 32.5,31.5 M 11.5,34.5 A 35,35 1 0 0 33.5,34.5 M 10.5,37.5 A 35,35 1 0 0 34.5,37.5',
          stroke: 'detail',
        },
      ],
    },
    r: {
      dy: 0.3,
      rule: 'evenodd',
      layers: [
        solid('M 9,39 L 36,39 L 36,36 L 9,36 L 9,39 z', { cap: 'butt' }),
        solid('M 12.5,32 L 14,29.5 L 31,29.5 L 32.5,32 L 12.5,32 z', { cap: 'butt' }),
        solid('M 12,36 L 12,32 L 33,32 L 33,36 L 12,36 z', { cap: 'butt' }),
        solid('M 14,29.5 L 14,16.5 L 31,16.5 L 31,29.5 L 14,29.5 z', { cap: 'butt', join: 'miter' }),
        solid('M 14,16.5 L 11,14 L 34,14 L 31,16.5 L 14,16.5 z', { cap: 'butt' }),
        solid(
          'M 11,14 L 11,9 L 15,9 L 15,11 L 20,11 L 20,9 L 25,9 L 25,11 L 30,11 L 30,9 L 34,9 L 34,14 L 11,14 z',
          { cap: 'butt' },
        ),
        {
          d: 'M 12,35.5 L 33,35.5 M 13,31.5 L 32,31.5 M 14,29.5 L 31,29.5 M 14,16.5 L 31,16.5 M 11,14 L 34,14',
          stroke: 'detail',
          width: 1,
          join: 'miter',
        },
      ],
    },
    b: {
      dy: 0.6,
      rule: 'evenodd',
      layers: [
        solid(BISHOP_BASE, { cap: 'butt' }),
        solid(BISHOP_BODY, { cap: 'butt' }),
        solid(BISHOP_TOP, { cap: 'butt' }),
        { d: BISHOP_MITRE, stroke: 'detail', join: 'miter' },
      ],
    },
    n: {
      dy: 0.3,
      rule: 'evenodd',
      layers: [
        solid(KNIGHT_NECK),
        solid(KNIGHT_HEAD),
        { d: KNIGHT_NOSTRIL, fill: 'detail', stroke: 'detail' },
        { d: KNIGHT_EYE, fill: 'detail', stroke: 'detail', transform: KNIGHT_EYE_MATRIX },
        { d: KNIGHT_MANE, fill: 'detail' },
      ],
    },
    p: {
      dy: 0,
      rule: 'nonzero',
      layers: [solid(PAWN, { join: 'miter' })],
    },
  },
};

/** What each ink is, for one side in one look. */
export function inksFor(color: Color, look: PieceLook): Record<Ink, string> {
  if (color === 'w') return { body: '#ffffff', line: '#000000', detail: '#000000' };
  return {
    body: '#000000',
    // A black outline on a black disc is no outline, and the pawn, which has
    // no interior lines at all, would vanish into its own disc.
    line: look === 'disc' ? DISC_RING : '#000000',
    detail: '#ffffff',
  };
}

/** The disc's own fill. The team's color, which is the whole point of it. */
function discFill(color: Color): string {
  return color === 'w' ? '#ffffff' : '#000000';
}

/**
 * Proportions, as fractions of the box a piece is given.
 *
 * On a disc the art shrinks so the disc shows as a ring of team color around
 * it, not as a background hidden behind the piece.
 */
const DISC_RADIUS = 0.48;
const DISC_RING_WIDTH = 0.07;
const ART_ON_DISC = 0.78;

/**
 * Stroke widths never fall below this many screen pixels.
 *
 * The source's 1.5-unit line is a third of a pixel on a 10 px piece, which a
 * phone antialiases to a gray smudge. Squares on a long, thin field get that
 * small, so the lines thicken rather than fade.
 */
const MIN_LINE_PX = 1;

/** Path2D objects, made once: parsing a path string every repaint is waste. */
const pathCache = new Map<string, Path2D>();
function pathOf(d: string): Path2D {
  let path = pathCache.get(d);
  if (!path) {
    path = new Path2D(d);
    pathCache.set(d, path);
  }
  return path;
}

/**
 * Draw one piece centered on (`cx`, `cy`) in a box `boxPx` pixels across.
 *
 * Leaves the context's transform, fill, stroke and line settings as it found
 * them, so a caller can draw other things around pieces without resetting.
 */
export function drawPiece(
  ctx: CanvasRenderingContext2D,
  piece: Piece,
  look: PieceLook,
  cx: number,
  cy: number,
  boxPx: number,
): void {
  ctx.save();
  let artPx = boxPx;
  if (look === 'disc') {
    const ringPx = Math.max(1.5, boxPx * DISC_RING_WIDTH);
    const radius = boxPx * DISC_RADIUS;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = discFill(piece.color);
    ctx.fill();
    // Inside the edge, so the ring never spills on to the next square.
    ctx.beginPath();
    ctx.arc(cx, cy, radius - ringPx / 2, 0, Math.PI * 2);
    ctx.strokeStyle = DISC_RING;
    ctx.lineWidth = ringPx;
    ctx.stroke();
    artPx = boxPx * ART_ON_DISC;
  }

  const art = ART[piece.color][piece.type];
  const inks = inksFor(piece.color, look);
  const k = artPx / ART_BOX;
  ctx.translate(cx - artPx / 2, cy - artPx / 2 + art.dy * k);
  ctx.scale(k, k);
  for (const layer of art.layers) {
    ctx.save();
    if (layer.transform) ctx.transform(...layer.transform);
    const path = pathOf(layer.d);
    if (layer.fill) {
      ctx.fillStyle = inks[layer.fill];
      ctx.fill(path, art.rule);
    }
    if (layer.stroke) {
      ctx.strokeStyle = inks[layer.stroke];
      ctx.lineWidth = Math.max(layer.width ?? 1.5, MIN_LINE_PX / k);
      ctx.lineCap = layer.cap ?? 'round';
      ctx.lineJoin = layer.join ?? 'round';
      ctx.stroke(path);
    }
    ctx.restore();
  }
  ctx.restore();
}

/** A number as markup, without floating-point tails like 21.599999999999998. */
function short(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/**
 * The same piece as inline SVG markup, for the HTML around the board.
 *
 * Built from the same layers as {@link drawPiece}, so the carry readout and the
 * promotion picker cannot drift from the board. Sized by CSS (`width`/`height`
 * are left to the stylesheet); `aria-hidden`, because every place that shows
 * one also names the piece or its square in words.
 */
export function pieceSvg(piece: Piece, look: PieceLook): string {
  const art = ART[piece.color][piece.type];
  const inks = inksFor(piece.color, look);
  let disc = '';
  let scale = 1;
  if (look === 'disc') {
    const ring = ART_BOX * DISC_RING_WIDTH;
    const radius = ART_BOX * DISC_RADIUS;
    const mid = ART_BOX / 2;
    disc =
      `<circle cx="${mid}" cy="${mid}" r="${short(radius)}" fill="${discFill(piece.color)}"/>` +
      `<circle cx="${mid}" cy="${mid}" r="${short(radius - ring / 2)}" fill="none" stroke="${DISC_RING}" stroke-width="${short(ring)}"/>`;
    scale = ART_ON_DISC;
  }
  const offset = (ART_BOX * (1 - scale)) / 2;
  const layers = art.layers
    .map((layer) => {
      const attrs = [
        `d="${layer.d}"`,
        `fill="${layer.fill ? inks[layer.fill] : 'none'}"`,
        `fill-rule="${art.rule}"`,
      ];
      if (layer.stroke) {
        attrs.push(
          `stroke="${inks[layer.stroke]}"`,
          `stroke-width="${layer.width ?? 1.5}"`,
          `stroke-linecap="${layer.cap ?? 'round'}"`,
          `stroke-linejoin="${layer.join ?? 'round'}"`,
        );
      }
      if (layer.transform) attrs.push(`transform="matrix(${layer.transform.join(' ')})"`);
      return `<path ${attrs.join(' ')}/>`;
    })
    .join('');
  return (
    `<svg class="piece" viewBox="0 0 ${ART_BOX} ${ART_BOX}" aria-hidden="true" focusable="false" data-piece="${piece.color}${piece.type}">` +
    disc +
    `<g transform="translate(${short(offset)} ${short(offset + art.dy * scale)}) scale(${scale})">${layers}</g>` +
    `</svg>`
  );
}
