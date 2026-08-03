import { describe, expect, it } from 'vitest';

import { DEFAULT_TIME_CONTROL, TIME_CONTROLS } from '../src/shared/clock.js';
import { makeFieldSpec } from '../src/shared/field.js';
import {
  type CreateDraft,
  DEFAULT_TIME_CONTROL_INDEX,
  MAX_HANDICAP_M,
  clampHandicap,
  createGameBody,
  createRefusal,
  draftField,
  draftTimeControl,
  emptyDraft,
  reachBonuses,
  resolveColour,
} from '../src/client/views/create.js';

/**
 * The model half of the create screen. The DOM half is verified by driving
 * Chromium against `?sim=1` — every view bug in this project so far has been
 * invisible to a unit test and obvious in a screenshot.
 */

const A1 = { lat: 51.4779, lng: -0.0015 };
const H8 = { lat: 51.47841, lng: -0.00068 };

function field(name: string) {
  return makeFieldSpec(name, { a1: A1, h8: H8 });
}

const PARK = field('The park');
const COMMON = field('The common');
const FIELDS = [PARK, COMMON];

function draft(overrides: Partial<CreateDraft> = {}): CreateDraft {
  return { ...emptyDraft(FIELDS), ...overrides };
}

describe('emptyDraft', () => {
  it('starts on the most recently calibrated field', () => {
    // `store.list()` is newest-first, and the field someone just walked out is
    // overwhelmingly the one they are standing on.
    expect(emptyDraft(FIELDS).fieldId).toBe(PARK.id);
  });

  it('starts on the shared default time control rather than a copy of it', () => {
    expect(draftTimeControl(emptyDraft(FIELDS))).toBe(DEFAULT_TIME_CONTROL);
    expect(TIME_CONTROLS[DEFAULT_TIME_CONTROL_INDEX]).toBe(DEFAULT_TIME_CONTROL);
  });

  it('starts with no handicap', () => {
    expect(reachBonuses(emptyDraft(FIELDS), 'w')).toEqual({ w: 0, b: 0 });
  });

  it('survives having no fields at all', () => {
    // Reachable: the home screen only offers this once a field exists, but the
    // deep-link path in 6.2 will not be so careful.
    expect(() => emptyDraft([])).not.toThrow();
    expect(createRefusal(emptyDraft([]), [])).toMatch(/Calibrate a field/);
  });
});

describe('draftField', () => {
  it('finds the chosen field', () => {
    expect(draftField(draft({ fieldId: COMMON.id }), FIELDS)).toBe(COMMON);
  });

  it('falls back to the first rather than returning nothing', () => {
    // A field deleted on another tab must not leave the screen unusable.
    expect(draftField(draft({ fieldId: 'gone' }), FIELDS)).toBe(PARK);
  });
});

describe('resolveColour', () => {
  it('passes a chosen colour through', () => {
    expect(resolveColour('w')).toBe('w');
    expect(resolveColour('b')).toBe('b');
  });

  it('tosses a coin for random, both ways', () => {
    expect(resolveColour('random', () => 0.1)).toBe('w');
    expect(resolveColour('random', () => 0.9)).toBe('b');
  });
});

describe('reachBonuses', () => {
  // Decision 0004: the handicap is metres of reach, never seconds, and it is
  // chosen as "me" or "my opponent" because that is what a person setting up a
  // game in a park actually says.
  it('gives the metres to whichever colour the creator turned out to be', () => {
    const d = draft({ handicapTo: 'me', handicapM: 2 });
    expect(reachBonuses(d, 'w')).toEqual({ w: 2, b: 0 });
    expect(reachBonuses(d, 'b')).toEqual({ w: 0, b: 2 });
  });

  it('gives them to the other colour when the handicap is the opponent’s', () => {
    const d = draft({ handicapTo: 'opponent', handicapM: 3 });
    expect(reachBonuses(d, 'w')).toEqual({ w: 0, b: 3 });
    expect(reachBonuses(d, 'b')).toEqual({ w: 3, b: 0 });
  });

  it('ignores the metres when nobody is handicapped', () => {
    expect(reachBonuses(draft({ handicapTo: 'none', handicapM: 4 }), 'w')).toEqual({
      w: 0,
      b: 0,
    });
  });

  it('never emits more than the control offers', () => {
    // O-02 is about the reach ceiling rising with the bonus. This is not the fix
    // for it, but it is the bound that keeps today's games inside whatever cap
    // that observation eventually settles on.
    expect(reachBonuses(draft({ handicapTo: 'me', handicapM: 99 }), 'w').w).toBe(MAX_HANDICAP_M);
    expect(reachBonuses(draft({ handicapTo: 'me', handicapM: -5 }), 'w').w).toBe(0);
  });
});

describe('clampHandicap', () => {
  it('holds the range and rejects nonsense', () => {
    expect(clampHandicap(0)).toBe(0);
    expect(clampHandicap(MAX_HANDICAP_M + 1)).toBe(MAX_HANDICAP_M);
    expect(clampHandicap(-1)).toBe(0);
    expect(clampHandicap(Number.NaN)).toBe(0);
  });
});

describe('createGameBody', () => {
  it('sends what the worker validates', () => {
    const d = draft({ timeControl: 0, handicapTo: 'opponent', handicapM: 2 });
    const body = createGameBody(d, PARK, 'player-1234', 'w');
    expect(body).toEqual({
      playerId: 'player-1234',
      field: PARK,
      color: 'w',
      initialMs: TIME_CONTROLS[0].initialMs,
      incrementMs: TIME_CONTROLS[0].incrementMs,
      whiteReachBonusM: 0,
      blackReachBonusM: 2,
    });
  });

  it('sends the whole field, because the game snapshots it', () => {
    // A saved field is mutable and versioned; the game must carry its own copy
    // so a re-calibration elsewhere cannot reshape a game in progress.
    const body = createGameBody(draft(), PARK, 'player-1234', 'b');
    expect(body.field).toBe(PARK);
  });

  it('falls back to the default time control if the index is out of range', () => {
    const body = createGameBody(draft({ timeControl: 99 }), PARK, 'player-1234', 'w');
    expect(body.initialMs).toBe(DEFAULT_TIME_CONTROL.initialMs);
  });
});
