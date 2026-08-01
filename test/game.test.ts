import { describe, expect, it } from 'vitest';

import { type FieldSpec, deriveGeometry } from '../src/shared/field.js';
import { fromLocal } from '../src/shared/geo.js';
import type { CarryState } from '../src/shared/protocol.js';
import {
  PROMOTION_CHOICES,
  carryGuidance,
  carryPrompt,
  carryReadout,
  metres,
  myReachBonusM,
  promotesOn,
} from '../src/client/views/game.js';

/** An 8 m board, axis-aligned so board space and metres east/north coincide. */
const A1 = { lat: 51.4779, lng: -0.0015 };
const SQUARE_M = 8;
const FIELD: FieldSpec = {
  id: 'f',
  name: 'test',
  a1: A1,
  h8: fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M }),
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};
const GEO = deriveGeometry(FIELD);

/** Board space, in metres: a1's centre is the origin, h8's is (56, 56). */
const at = (file: number, rank: number) => ({ u: file * SQUARE_M, v: rank * SQUARE_M });

function carry(over: Partial<CarryState> = {}): CarryState {
  return {
    color: 'w',
    from: 'e2',
    piece: 'p',
    at: 1_000,
    destinations: ['e3', 'e4'],
    ...over,
  };
}

describe('promotesOn', () => {
  it('promotes a white pawn on the eighth rank and nowhere else', () => {
    const white = { piece: 'p', color: 'w' } as const;
    expect(promotesOn(white, 'e8')).toBe(true);
    expect(promotesOn(white, 'a8')).toBe(true);
    expect(promotesOn(white, 'e7')).toBe(false);
    expect(promotesOn(white, 'e1')).toBe(false);
  });

  it('promotes a black pawn on the first rank instead', () => {
    const black = { piece: 'p', color: 'b' } as const;
    expect(promotesOn(black, 'e1')).toBe(true);
    expect(promotesOn(black, 'e8')).toBe(false);
  });

  it('never promotes anything that is not a pawn', () => {
    // A rook reaching the last rank is the ordinary case, not a question.
    for (const piece of ['r', 'n', 'b', 'q', 'k']) {
      expect(promotesOn({ piece, color: 'w' }, 'e8')).toBe(false);
    }
  });

  it('accepts an upper-case piece letter, since FEN spells colour that way', () => {
    expect(promotesOn({ piece: 'P', color: 'w' }, 'e8')).toBe(true);
  });

  it('offers four choices, and never a king or another pawn', () => {
    expect(PROMOTION_CHOICES.map((c) => c.type)).toEqual(['q', 'r', 'b', 'n']);
  });
});

describe('carryGuidance', () => {
  it('finds what is in reach from where the player stands', () => {
    // Standing on e2 of an 8 m board: e3's near edge is 4 m away, e4's is 12 m.
    const here = at(4, 1);
    expect(carryGuidance(GEO, here, 8, carry(), 'w').inReach).toEqual(['e3']);
    expect(carryGuidance(GEO, here, 13, carry(), 'w').inReach).toEqual(['e3', 'e4']);
    expect(carryGuidance(GEO, here, 2, carry(), 'w').inReach).toEqual([]);
    expect(carryGuidance(GEO, here, 8, carry(), 'w').mine).toBe(true);
  });

  it('reports the walk remaining, not the distance to the square', () => {
    // On e2, e4's near edge is 12 m off. With 8 m of reach that is 4 m of
    // walking — quoting 12 would send a player straight past it.
    const g = carryGuidance(GEO, at(4, 1), 8, carry({ destinations: ['e4'] }), 'w');
    expect(g.nearest?.square).toBe('e4');
    expect(g.nearest?.distanceM).toBeCloseTo(12, 5);
    expect(g.nearest?.walkM).toBeCloseTo(4, 5);
  });

  it('never reports a negative walk for somewhere already in reach', () => {
    const g = carryGuidance(GEO, at(4, 1), 8, carry({ destinations: ['e3'] }), 'w');
    expect(g.nearest?.walkM).toBe(0);
  });

  it('picks the nearest of several destinations', () => {
    const g = carryGuidance(GEO, at(0, 0), 4, carry({ from: 'a1', destinations: ['h8', 'c1', 'a4'] }), 'w');
    expect(g.nearest?.square).toBe('c1');
  });

  it('dedupes a promotion square, which arrives once per piece', () => {
    // chess.js enumerates e7-e8 four times, one per promotion. Four dots land
    // on one square harmlessly; "4 in reach" for one square does not.
    const g = carryGuidance(GEO, at(4, 6), 8, carry({ from: 'e7', destinations: ['e8', 'e8', 'e8', 'e8'] }), 'w');
    expect(g.destinations).toEqual(['e8']);
    expect(g.inReach).toEqual(['e8']);
  });

  it('says nothing about distance before the first fix', () => {
    const g = carryGuidance(GEO, null, 8, carry(), 'w');
    expect(g.inReach).toEqual([]);
    expect(g.nearest).toBeNull();
    expect(g.destinations).toEqual(['e3', 'e4']);
  });

  it('marks the opponent’s carry as not mine', () => {
    const g = carryGuidance(GEO, at(4, 1), 8, carry({ color: 'b' }), 'w');
    expect(g.mine).toBe(false);
  });

  it('carries the piece glyph, so the HUD and the board agree', () => {
    expect(carryGuidance(GEO, null, 8, carry({ piece: 'q' }), 'w').glyph).toBe('♛︎');
  });
});

describe('carryReadout', () => {
  const from = (over: Partial<CarryState>, here = at(4, 1), reach = 8) =>
    carryReadout(carryGuidance(GEO, here, reach, carry(over), 'w'));

  it('is a dash when nothing is in hand', () => {
    expect(carryReadout(null)).toBe('—');
  });

  it('counts what can be placed on right now', () => {
    expect(from({}, at(4, 1), 13)).toContain('2 in reach');
    expect(from({}, at(4, 1), 8)).toContain('1 in reach');
  });

  it('names the nearest square and the walk to it when nothing is in reach', () => {
    // e4 is 12 m off with no reach allowance at all, so 12 m of walking.
    const line = from({ destinations: ['e4'] }, at(4, 1), 0);
    expect(line).toContain('e4');
    expect(line).toContain('12 m');
  });

  it('marks the opponent’s carry rather than telling them where to walk', () => {
    expect(from({ color: 'b' })).toContain('theirs');
  });
});

describe('carryPrompt', () => {
  const promptFor = (
    over: Partial<CarryState>,
    here: { u: number; v: number } | null = at(4, 1),
    reach = 8,
  ) =>
    carryPrompt(carryGuidance(GEO, here, reach, carry(over), 'w'));

  it('sends the player walking when nothing is in reach', () => {
    const line = promptFor({ destinations: ['e4'] }, at(4, 1), 2);
    expect(line).toContain('Walk');
    expect(line).toContain('e4');
  });

  it('invites a tap once something is in reach', () => {
    expect(promptFor({}, at(4, 1), 13)).toContain('2 in reach');
  });

  it('admits to waiting rather than inventing a distance', () => {
    expect(promptFor({}, null)).toContain('Waiting');
  });

  it('says whose carry it is when it is not yours', () => {
    expect(promptFor({ color: 'b' })).toContain('opponent');
  });
});

describe('metres', () => {
  it('keeps a decimal only where it means something', () => {
    expect(metres(4.26)).toBe('4.3 m');
    expect(metres(41.6)).toBe('42 m');
  });
});

describe('myReachBonusM', () => {
  /**
   * Decision 0004's handicap, as the screen sees it.
   *
   * This was wrong for a whole phase and no test noticed: the client computed
   * reach with no bonus at all, so a handicapped player's circle was drawn
   * smaller than the one the server would actually judge by. That does not fail
   * their moves — the Durable Object still accepts them — it tells them a move
   * is out of reach when it is not, and they believe it and walk further. Found
   * by `scripts/check-invite.mjs` reading `12.0 m` off the board and getting
   * `10.0 m`.
   */
  const snapshot = (over: Record<string, unknown> = {}) =>
    ({
      you: 'b',
      players: {
        w: { color: 'w', reachBonusM: 0 },
        b: { color: 'b', reachBonusM: 2 },
      },
      ...over,
    }) as unknown as Parameters<typeof myReachBonusM>[0];

  it('reads the bonus for the colour this phone is playing', () => {
    expect(myReachBonusM(snapshot())).toBe(2);
    expect(myReachBonusM(snapshot({ you: 'w' }))).toBe(0);
  });

  it('is zero before the first snapshot', () => {
    expect(myReachBonusM(null)).toBe(0);
  });

  it('is zero when the seat is still empty', () => {
    // Reachable while waiting for an opponent: the joiner's `PlayerView` is
    // null until they connect, and the screen still has to draw a circle.
    expect(myReachBonusM(snapshot({ players: { w: null, b: null } }))).toBe(0);
  });
});
