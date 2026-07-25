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
/** A 8 m board: a1 to h8 is seven squares along each axis. */
const H8 = fromLocal(A1, { e: 7 * 8, n: 7 * 8 });

function fix(pos: { lat: number; lng: number }, accuracyM = 4, at = 1_000): GpsFix {
  return { pos, accuracyM, at };
}

/** A draft with both corners tapped, sitting on the review screen. */
function reviewed(a1 = A1, h8 = H8, accuracyM = 4): CalibrationDraft {
  return recordTap(recordTap(emptyDraft(), 'a1', fix(a1, accuracyM)), 'h8', fix(h8, accuracyM));
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

describe('the two taps', () => {
  it('walks a1, then h8, then review', () => {
    const start = emptyDraft();
    expect(start.step).toBe('a1');

    const afterA1 = recordTap(start, 'a1', fix(A1));
    expect(afterA1.step).toBe('h8');
    expect(afterA1.a1?.pos).toEqual(A1);

    const afterH8 = recordTap(afterA1, 'h8', fix(H8));
    expect(afterH8.step).toBe('review');
  });

  it('keeps the accuracy of each tap for later diagnosis', () => {
    const draft = reviewed(A1, H8, 7);
    expect(draft.a1?.accuracyM).toBe(7);
    expect(draft.h8?.accuracyM).toBe(7);
  });

  it('derives the square size the field will really have', () => {
    const check = draftCheck(reviewed());
    expect(check?.ok).toBe(true);
    expect(check?.squareM).toBeCloseTo(8, 2);
    expect(check?.boardM).toBeCloseTo(64, 1);
  });

  it('has no verdict until both corners exist', () => {
    expect(draftCheck(emptyDraft())).toBeNull();
    expect(draftCheck(recordTap(emptyDraft(), 'a1', fix(A1)))).toBeNull();
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
    const shrunk = recordTap(retap(reviewed(), 'h8'), 'h8', fix(fromLocal(A1, { e: 35, n: 35 })));
    expect(draftCheck(shrunk)!.squareM).toBeLessThan(before);
  });
});

describe('what may be saved', () => {
  it('refuses a board too small for GPS to resolve', () => {
    const tiny = reviewed(A1, fromLocal(A1, { e: 7, n: 7 }));
    expect(canSave(tiny)).toBe(false);
    expect(draftCheck(tiny)?.errors[0]).toContain('smaller than GPS can resolve');
    expect(draftSpec(tiny)).toBeNull();
  });

  it('refuses two taps in the same place', () => {
    expect(canSave(reviewed(A1, A1))).toBe(false);
  });

  it('warns without blocking on a board that is merely awkward', () => {
    const small = reviewed(A1, fromLocal(A1, { e: 21, n: 21 }));
    const check = draftCheck(small)!;
    expect(check.ok).toBe(true);
    expect(check.warnings.join(' ')).toContain('ambiguity');
  });

  it('warns when the corners were tapped on a vague fix', () => {
    const check = draftCheck(reviewed(A1, H8, 24))!;
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
    expect(deriveGeometry(spec).squareM).toBeCloseTo(draftCheck(draft)!.squareM, 6);
  });

  it('falls back to a default rather than saving a blank name', () => {
    expect(draftSpec(renameDraft(reviewed(), '   '))!.name).toBe(DEFAULT_FIELD_NAME);
  });

  it('re-calibrates an existing field in place, bumping its version', () => {
    const original = draftSpec(renameDraft(reviewed(), 'The rec ground'), { now: 1_000 })!;
    const moved = reviewed(A1, fromLocal(A1, { e: 70, n: 70 }));
    const updated = draftSpec(renameDraft(moved, 'The rec ground'), {
      existing: original,
      now: 2_000,
    })!;

    expect(updated.id).toBe(original.id);
    expect(updated.version).toBe(2);
    expect(updated.updatedAt).toBe(2_000);
    expect(deriveGeometry(updated).squareM).not.toBeCloseTo(deriveGeometry(original).squareM, 2);
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
    await store.save(draftSpec(reviewed(A1, fromLocal(A1, { e: 70, n: 70 })), {
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
