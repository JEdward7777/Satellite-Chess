import { describe, expect, it } from 'vitest';

import { deriveGeometry } from '../src/shared/field.js';
import { fromLocal } from '../src/shared/geo.js';
import { DEFAULT_REACH } from '../src/shared/reach.js';
import type { GpsFix } from '../src/client/gps.js';
import {
  DEFAULT_FIELD_NAME,
  type CalibrationDraft,
  canSave,
  draftCheck,
  draftSpec,
  emptyDraft,
  recordTap,
  renameDraft,
  retap,
  tapRefusal,
} from '../src/client/views/calibrate.js';
import { createMemoryFieldStore } from '../src/client/store.js';

const A1 = { lat: 51.4779, lng: -0.0015 };
/** An 8 m board, due east/north: seven squares along each axis. */
const H1 = fromLocal(A1, { e: 7 * 8, n: 0 });
const H8 = fromLocal(A1, { e: 7 * 8, n: 7 * 8 });
const A8 = fromLocal(A1, { e: 0, n: 7 * 8 });

function fix(pos: { lat: number; lng: number }, accuracyM = 4, at = 1_000): GpsFix {
  return { pos, accuracyM, at };
}

/** The four corners of a board with `fileM` x `rankM` squares. */
function corners(fileM = 8, rankM = fileM, a1 = A1) {
  return {
    a1,
    h1: fromLocal(a1, { e: 7 * fileM, n: 0 }),
    h8: fromLocal(a1, { e: 7 * fileM, n: 7 * rankM }),
    a8: fromLocal(a1, { e: 0, n: 7 * rankM }),
  };
}

/** A draft with all four corners tapped, sitting on the review screen. */
function reviewed(
  spots: { a1: typeof A1; h1: typeof A1; h8: typeof A1; a8: typeof A1 } = corners(),
  accuracyM = 4,
): CalibrationDraft {
  let draft = emptyDraft();
  for (const name of ['a1', 'h1', 'h8', 'a8'] as const) {
    draft = recordTap(draft, name, fix(spots[name], accuracyM));
  }
  return draft;
}

describe('tapRefusal', () => {
  it('refuses before there is any position at all', () => {
    expect(tapRefusal(null)).toContain('Waiting');
  });

  it('refuses a fix the move validator would also refuse', () => {
    const refusal = tapRefusal(fix(A1, DEFAULT_REACH.maxAccuracyM + 1));
    expect(refusal).toContain('wrong place');
    expect(tapRefusal(fix(A1, DEFAULT_REACH.maxAccuracyM))).toBeNull();
  });
});

describe('the four taps', () => {
  it('walks the perimeter in order, then review', () => {
    const start = emptyDraft();
    expect(start.step).toBe('a1');

    const afterA1 = recordTap(start, 'a1', fix(A1));
    // Round the edge, not across it: h1 is next, not the far diagonal.
    expect(afterA1.step).toBe('h1');
    expect(afterA1.a1?.pos).toEqual(A1);

    const afterH1 = recordTap(afterA1, 'h1', fix(H1));
    expect(afterH1.step).toBe('h8');

    const afterH8 = recordTap(afterH1, 'h8', fix(H8));
    expect(afterH8.step).toBe('a8');

    expect(recordTap(afterH8, 'a8', fix(A8)).step).toBe('review');
  });

  it('keeps the accuracy of each tap for later diagnosis', () => {
    const draft = reviewed(corners(), 7);
    expect(draft.a1?.accuracyM).toBe(7);
    expect(draft.h1?.accuracyM).toBe(7);
    expect(draft.h8?.accuracyM).toBe(7);
    expect(draft.a8?.accuracyM).toBe(7);
  });

  it('derives the square size the field will really have', () => {
    const check = draftCheck(reviewed());
    expect(check?.ok).toBe(true);
    expect(check?.squareM).toBeCloseTo(8, 2);
    expect(check?.boardM).toBeCloseTo(64, 1);
    // Four clean corners describe a square board exactly, so nothing is left over.
    expect(check?.residualM).toBeCloseTo(0, 6);
  });

  it('keeps a rectangular pitch rectangular (decision 0028)', () => {
    // 10 m along the files, 6 m along the ranks — the case two taps could not
    // express at all, and which used to be forced into a square.
    const check = draftCheck(reviewed(corners(10, 6)));
    expect(check?.ok).toBe(true);
    expect(check?.fileM).toBeCloseTo(10, 2);
    expect(check?.rankM).toBeCloseTo(6, 2);
    // A 1.7:1 board is a pitch, not a mistake, and says nothing.
    expect(check?.warnings.join(' ')).not.toMatch(/longer one way/);
  });

  it('has no verdict until every corner exists', () => {
    expect(draftCheck(emptyDraft())).toBeNull();
    let draft = emptyDraft();
    for (const name of ['a1', 'h1', 'h8'] as const) {
      draft = recordTap(draft, name, fix(corners()[name]));
      expect(draftCheck(draft)).toBeNull();
    }
  });

  it('says nothing at all about a board that is genuinely sheared', () => {
    // Both far corners dragged 12 m along the files: still a parallelogram, so
    // the affine fit represents it exactly. Residual zero — and that is right
    // rather than a miss. Nothing in four points says this was a mistake instead
    // of the board someone meant to lay out on awkward ground.
    const sheared = {
      ...corners(),
      a8: fromLocal(A1, { e: 12, n: 7 * 8 }),
      h8: fromLocal(A1, { e: 7 * 8 + 12, n: 7 * 8 }),
    };
    const check = draftCheck(reviewed(sheared));
    expect(check?.residualM).toBeCloseTo(0, 6);
    expect(check?.ok).toBe(true);
  });

  it('shows a single mis-tap at about a quarter of its size', () => {
    // The least-squares fit spreads one corner's error over all four, which is
    // the whole point — but it means the residual understates the mistake, and
    // the warning threshold has to be set knowing that.
    const off = { ...corners(), a8: fromLocal(A1, { e: 12, n: 7 * 8 }) };
    expect(draftCheck(reviewed(off))?.residualM).toBeCloseTo(3, 1);
  });

  it('notices corners that do not make a straight-sided board at all', () => {
    // a8 tapped far up the rank axis, making the a-file a different length from
    // the h-file. That is not a parallelogram, so the fit cannot absorb it —
    // the one kind of mis-tap four corners can actually catch.
    const bent = { ...corners(), a8: fromLocal(A1, { e: 0, n: 7 * 8 + 40 }) };
    const check = draftCheck(reviewed(bent));
    expect(check?.residualM).toBeGreaterThan(2);
    expect(check?.warnings.join(' ')).toMatch(/straight-sided/);
  });

  it('warns about a board far longer one way than the other', () => {
    const check = draftCheck(reviewed(corners(14, 4)));
    expect(check?.warnings.join(' ')).toMatch(/longer one way/);
  });
});

describe('re-tapping a corner', () => {
  it('returns straight to the review, not to the start', () => {
    const draft = retap(reviewed(), 'a1');
    expect(draft.step).toBe('a1');
    // The other corner survives, which is the whole point of stage 1.2.3.
    expect(draft.h8?.pos).toEqual(H8);

    const moved = fromLocal(A1, { e: 3, n: 0 });
    const after = recordTap(draft, 'a1', fix(moved));
    expect(after.step).toBe('review');
    expect(after.a1?.pos).toEqual(moved);
  });

  it('keeps the name across a re-tap', () => {
    const named = renameDraft(reviewed(), 'The rec ground');
    expect(retap(named, 'h8').name).toBe('The rec ground');
  });

  it('changes the derived geometry', () => {
    const before = draftCheck(reviewed())!.squareM;
    const shrunk = recordTap(retap(reviewed(), 'h8'), 'h8', fix(fromLocal(A1, { e: 35, n: 56 })));
    expect(draftCheck(shrunk)!.squareM).toBeLessThan(before);
  });
});

describe('what may be saved', () => {
  it('refuses a board too small for GPS to resolve', () => {
    const tiny = reviewed(corners(1));
    expect(canSave(tiny)).toBe(false);
    expect(draftCheck(tiny)?.errors[0]).toContain('smaller than GPS can resolve');
    expect(draftSpec(tiny)).toBeNull();
  });

  it('refuses two taps in the same place', () => {
    expect(canSave(reviewed({ a1: A1, h1: A1, h8: A1, a8: A1 }))).toBe(false);
  });

  it('warns without blocking on a board that is merely awkward', () => {
    const small = reviewed(corners(3));
    const check = draftCheck(small)!;
    expect(check.ok).toBe(true);
    expect(check.warnings.join(' ')).toContain('ambiguity');
  });

  it('warns when the corners were tapped on a vague fix', () => {
    const check = draftCheck(reviewed(corners(), 24))!;
    expect(check.ok).toBe(true);
    expect(check.warnings.join(' ')).toContain('may be well off');
  });
});

describe('draftSpec', () => {
  it('produces a field whose geometry matches the review screen', () => {
    const draft = renameDraft(reviewed(), 'The rec ground');
    const spec = draftSpec(draft, { now: 5_000 })!;

    expect(spec.name).toBe('The rec ground');
    expect(spec.version).toBe(1);
    expect(spec.a1Accuracy).toBe(4);
    expect(deriveGeometry(spec).fileM).toBeCloseTo(draftCheck(draft)!.squareM, 6);
  });

  it('falls back to a default rather than saving a blank name', () => {
    expect(draftSpec(renameDraft(reviewed(), '   '))!.name).toBe(DEFAULT_FIELD_NAME);
  });

  it('re-calibrates an existing field in place, bumping its version', () => {
    const original = draftSpec(renameDraft(reviewed(), 'The rec ground'), { now: 1_000 })!;
    const moved = reviewed(corners(10));
    const updated = draftSpec(renameDraft(moved, 'The rec ground'), {
      existing: original,
      now: 2_000,
    })!;

    expect(updated.id).toBe(original.id);
    expect(updated.version).toBe(2);
    expect(updated.updatedAt).toBe(2_000);
    expect(deriveGeometry(updated).fileM).not.toBeCloseTo(deriveGeometry(original).fileM, 2);
  });
});

describe('field store', () => {
  it('round-trips a field', async () => {
    const store = createMemoryFieldStore();
    const spec = draftSpec(renameDraft(reviewed(), 'The rec ground'))!;
    await store.save(spec);

    expect(await store.get(spec.id)).toEqual(spec);
    expect(await store.list()).toEqual([spec]);
  });

  it('replaces a field rather than duplicating it on re-calibration', async () => {
    const store = createMemoryFieldStore();
    const first = draftSpec(reviewed(), { now: 1_000 })!;
    await store.save(first);
    await store.save(draftSpec(reviewed(corners(10)), {
      existing: first,
      now: 2_000,
    })!);

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].version).toBe(2);
  });

  it('lists the most recently calibrated field first', async () => {
    const store = createMemoryFieldStore();
    const older = draftSpec(renameDraft(reviewed(), 'Older'), { now: 1_000 })!;
    const newer = draftSpec(renameDraft(reviewed(), 'Newer'), { now: 9_000 })!;
    await store.save(older);
    await store.save(newer);

    expect((await store.list()).map((f) => f.name)).toEqual(['Newer', 'Older']);
  });
});
