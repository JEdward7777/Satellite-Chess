import { describe, expect, it } from 'vitest';

import { deriveGeometry, makeFieldSpec } from '../src/shared/field.js';
import { fromLocal } from '../src/shared/geo.js';
import {
  PIECE_LOOK_KEY,
  type LookStorage,
  createPieceLookStore,
  readPieceLook,
  writePieceLook,
} from '../src/client/piece-look.js';
import { DISC_RING, PIECE_LOOKS, inksFor, pieceSvg } from '../src/client/pieces.js';
import { type PieceType, pieceBoxPx, projectionFor } from '../src/client/render.js';

function memoryStorage(): LookStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const throwing: LookStorage = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  },
};

const TYPES: PieceType[] = ['k', 'q', 'r', 'b', 'n', 'p'];

describe('the piece look switch (decision 0045)', () => {
  it('is the standard set by default', () => {
    expect(readPieceLook(memoryStorage())).toBe('standard');
    expect(readPieceLook(null)).toBe('standard');
  });

  it('remembers discs, and forgets them again', () => {
    const storage = memoryStorage();
    writePieceLook(storage, 'disc');
    expect(storage.map.get(PIECE_LOOK_KEY)).toBe('disc');
    expect(readPieceLook(storage)).toBe('disc');
    writePieceLook(storage, 'standard');
    // The default is stored as nothing, so it follows the default if that moves.
    expect(storage.map.has(PIECE_LOOK_KEY)).toBe(false);
  });

  it('reads anything unknown as the standard set', () => {
    const storage = memoryStorage();
    storage.map.set(PIECE_LOOK_KEY, 'sparkly');
    expect(readPieceLook(storage)).toBe('standard');
  });

  it('survives a storage that throws, and still switches for the page (O-28)', () => {
    expect(readPieceLook(throwing)).toBe('standard');
    expect(writePieceLook(throwing, 'disc')).toBe('disc');
    const store = createPieceLookStore(throwing);
    store.set('disc');
    expect(store.get()).toBe('disc');
  });

  it('tells every screen showing a board when it changes', () => {
    const store = createPieceLookStore(memoryStorage());
    const seen: string[] = [];
    const off = store.subscribe((look) => seen.push(look));
    store.set('disc');
    off();
    store.set('standard');
    expect(seen).toEqual(['disc']);
  });
});

describe('piece colors (O-30)', () => {
  it('draws white pieces white and black pieces black, in both looks', () => {
    for (const look of PIECE_LOOKS) {
      expect(inksFor('w', look).body).toBe('#ffffff');
      expect(inksFor('b', look).body).toBe('#000000');
    }
  });

  it('never outlines a black piece in black on its own black disc', () => {
    expect(inksFor('b', 'standard').line).toBe('#000000');
    expect(inksFor('b', 'disc').line).toBe(DISC_RING);
  });

  it('never draws a piece in the other side’s color on a disc', () => {
    // The complaint in O-30 was an outline in the opponent's color. On a disc
    // a black piece's outline is gray, not white.
    expect(inksFor('b', 'disc').line).not.toBe('#ffffff');
  });
});

describe('pieceSvg', () => {
  it('draws all twelve pieces in both looks', () => {
    for (const look of PIECE_LOOKS) {
      for (const color of ['w', 'b'] as const) {
        for (const type of TYPES) {
          const svg = pieceSvg({ type, color }, look);
          expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 45 45"/);
          expect(svg).toContain(`data-piece="${color}${type}"`);
          expect(svg).toContain('<path ');
          expect(svg).not.toContain('undefined');
        }
      }
    }
  });

  it('puts a disc in the team color, with a gray ring, only in the disc look', () => {
    const white = pieceSvg({ type: 'b', color: 'w' }, 'disc');
    const black = pieceSvg({ type: 'b', color: 'b' }, 'disc');
    expect(white).toContain('<circle cx="22.5" cy="22.5" r="21.6" fill="#ffffff"/>');
    expect(black).toContain('<circle cx="22.5" cy="22.5" r="21.6" fill="#000000"/>');
    expect(white).toContain(`stroke="${DISC_RING}"`);
    expect(pieceSvg({ type: 'b', color: 'w' }, 'standard')).not.toContain('<circle');
  });

  it('gives the black set its white interior lines', () => {
    expect(pieceSvg({ type: 'b', color: 'b' }, 'standard')).toContain('stroke="#ffffff"');
    expect(pieceSvg({ type: 'b', color: 'w' }, 'standard')).not.toContain('stroke="#ffffff"');
  });
});

describe('pieceBoxPx', () => {
  const A1 = { lat: 51.4779, lng: -0.0015 };

  it('fills the cell, less a margin, on a square board', () => {
    const geo = deriveGeometry(
      makeFieldSpec('square', { a1: A1, h8: fromLocal(A1, { e: 56, n: 56 }) }),
    );
    const p = projectionFor(geo, 'w', 400, 400);
    const cell = geo.meanSquareM * p.scale;
    expect(pieceBoxPx(geo, p)).toBeCloseTo(cell * 0.94, 5);
  });

  it('fits the narrow way across a rectangular cell, not the mean', () => {
    // Files 12 m apart, ranks 4 m: a piece sized to the mean (about 6.9 m)
    // would spill a rank into its neighbors.
    const geo = deriveGeometry(
      makeFieldSpec('long', {
        a1: A1,
        h1: fromLocal(A1, { e: 84, n: 0 }),
        a8: fromLocal(A1, { e: 0, n: 28 }),
        h8: fromLocal(A1, { e: 84, n: 28 }),
      }),
    );
    const p = projectionFor(geo, 'w', 400, 400);
    expect(pieceBoxPx(geo, p)).toBeCloseTo(4 * p.scale * 0.94, 3);
  });
});
