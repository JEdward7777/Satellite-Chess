/**
 * Calibration: turn two walked-to corners into a board.
 *
 * The convention is decision 0002 — the taps are the **centres of a1 and h8**,
 * not the outer corners of the board. "Stand where the white rook goes" is an
 * instruction two people can agree on in a field; "stand at the mathematical
 * corner of an imaginary square" is not.
 *
 * The model below is pure and tested in node; the view under it is DOM and is
 * verified in a browser against `?sim=1`. Keeping the two apart is what makes a
 * flow whose whole input is a satellite testable at all.
 */

import {
  type CalibrationCheck,
  type FieldSpec,
  checkCalibration,
  makeFieldSpec,
  recalibrate,
} from '../../shared/field.js';
import type { LatLng } from '../../shared/geo.js';
import { accuracyTooPoor } from '../../shared/reach.js';
import { type GpsFix, type GpsProvider, type GpsState, qualityLabel } from '../gps.js';
import type { FieldStore } from '../store.js';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type Corner = 'a1' | 'h8';
export type CalibrateStep = Corner | 'review';

export interface CornerTap {
  pos: LatLng;
  accuracyM: number;
  at: number;
}

export interface CalibrationDraft {
  step: CalibrateStep;
  a1: CornerTap | null;
  h8: CornerTap | null;
  name: string;
}

export const DEFAULT_FIELD_NAME = 'My field';

export function emptyDraft(name = DEFAULT_FIELD_NAME): CalibrationDraft {
  return { step: 'a1', a1: null, h8: null, name };
}

/**
 * Why this tap cannot be accepted, or null if it can.
 *
 * The bar is the same one the move validator uses. A corner tapped at ±40 m
 * would put the whole board tens of metres from where the players think it is,
 * and every game on that field would inherit the error — so it is refused here
 * rather than warned about later.
 */
export function tapRefusal(fix: GpsFix | null): string | null {
  if (!fix) return 'Waiting for a position — stand still for a moment.';
  if (accuracyTooPoor(fix.accuracyM)) {
    return (
      `Your fix is only good to ±${Math.round(fix.accuracyM)} m. A corner tapped now would put ` +
      'the whole board in the wrong place. Wait for it to tighten, or move into the open.'
    );
  }
  return null;
}

export function recordTap(
  draft: CalibrationDraft,
  corner: Corner,
  fix: GpsFix,
): CalibrationDraft {
  const tap: CornerTap = { pos: fix.pos, accuracyM: fix.accuracyM, at: fix.at };
  const next = { ...draft, [corner]: tap };
  // Whichever corner was just set, the next screen is the one still missing —
  // and once both exist, the review. That is what lets a re-tap from the review
  // screen come straight back to it (stage 1.2.3).
  return { ...next, step: !next.a1 ? 'a1' : !next.h8 ? 'h8' : 'review' };
}

/** Go back to one corner without losing the other, or the name. */
export function retap(draft: CalibrationDraft, corner: Corner): CalibrationDraft {
  return { ...draft, step: corner };
}

export function renameDraft(draft: CalibrationDraft, name: string): CalibrationDraft {
  return { ...draft, name };
}

/** The verdict on the two corners, or null while one is still missing. */
export function draftCheck(draft: CalibrationDraft): CalibrationCheck | null {
  const { a1, h8 } = draft;
  if (!a1 || !h8) return null;
  return checkCalibration(
    { a1: a1.pos, h8: h8.pos },
    { worstAccuracyM: Math.max(a1.accuracyM, h8.accuracyM) },
  );
}

export function canSave(draft: CalibrationDraft): boolean {
  return draftCheck(draft)?.ok === true;
}

/**
 * Turn a finished draft into a saved field.
 *
 * Passing `existing` re-calibrates it in place and bumps its version, rather
 * than leaving the player with two fields of the same name. Games hold a
 * snapshot, so this cannot reshape a game already in progress.
 */
export function draftSpec(
  draft: CalibrationDraft,
  opts: { existing?: FieldSpec; now?: number } = {},
): FieldSpec | null {
  const { a1, h8 } = draft;
  if (!a1 || !h8 || !canSave(draft)) return null;
  const name = draft.name.trim() || DEFAULT_FIELD_NAME;

  if (opts.existing) {
    return {
      ...recalibrate(opts.existing, a1.pos, h8.pos, {
        a1Accuracy: a1.accuracyM,
        h8Accuracy: h8.accuracyM,
        now: opts.now,
      }),
      name,
    };
  }
  return makeFieldSpec(name, a1.pos, h8.pos, {
    a1Accuracy: a1.accuracyM,
    h8Accuracy: h8.accuracyM,
    now: opts.now,
  });
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export interface CalibrateDeps {
  gps: GpsProvider;
  store: FieldStore;
  /** Called once the field is on disk, never before. */
  onSaved(spec: FieldSpec): void;
  existing?: FieldSpec;
}

const CORNER_BRIEF: Record<Corner, string> = {
  a1: 'Walk to the corner where White’s queenside rook stands — a1.',
  h8: 'Now walk to the diagonally opposite corner — h8, Black’s kingside rook.',
};

/** Mount the flow. Returns a teardown that also stops listening to the GPS. */
export function mountCalibrate(root: HTMLElement, deps: CalibrateDeps): () => void {
  let draft = deps.existing
    ? { ...emptyDraft(deps.existing.name) }
    : emptyDraft();
  let gpsState = deps.gps.state;
  let saving = false;

  const update = (next: CalibrationDraft) => {
    draft = next;
    paint();
  };

  const unsubscribe = deps.gps.subscribe((state) => {
    gpsState = state;
    // Repainting the review screen on every fix would eat the caret out of the
    // name box mid-word. Live accuracy only matters while aiming at a corner.
    if (draft.step !== 'review') paint();
  });

  function paint(): void {
    root.innerHTML = draft.step === 'review' ? reviewHtml(draft) : cornerHtml(draft, gpsState);
    wire();
  }

  function wire(): void {
    root.querySelector<HTMLButtonElement>('[data-tap]')?.addEventListener('click', () => {
      const fix = gpsState.fix;
      if (!fix || tapRefusal(fix)) return;
      update(recordTap(draft, draft.step as Corner, fix));
    });

    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-retap]')) {
      button.addEventListener('click', () => {
        update(retap(draft, button.dataset.retap as Corner));
      });
    }

    const name = root.querySelector<HTMLInputElement>('[data-name]');
    name?.addEventListener('input', () => {
      // Deliberately not repainting: the input is already showing the change,
      // and repainting would move the caret to the end of the line.
      draft = renameDraft(draft, name.value);
    });

    root.querySelector<HTMLButtonElement>('[data-save]')?.addEventListener('click', () => {
      void save();
    });
  }

  async function save(): Promise<void> {
    if (saving) return;
    const spec = draftSpec(draft, { existing: deps.existing });
    if (!spec) return;
    saving = true;
    try {
      // Decision 0013: on disk before anything else happens, and before anyone
      // is asked to sign in to anything.
      await deps.store.save(spec);
      deps.onSaved(spec);
    } finally {
      saving = false;
    }
  }

  paint();
  return () => {
    unsubscribe();
    root.innerHTML = '';
  };
}

function cornerHtml(draft: CalibrationDraft, state: GpsState): string {
  const corner = draft.step as Corner;
  const fix = state.fix;
  const refusal = tapRefusal(fix);
  const done = corner === 'a1' ? null : draft.a1;

  return `
    <h1>Calibrate a field</h1>
    <p data-brief>${escapeHtml(CORNER_BRIEF[corner])}</p>
    <dl class="readout">
      <dt>Signal</dt>
      <dd class="quality-${state.quality}" data-quality>${
        fix ? qualityLabel(state.quality) : 'Waiting for a fix…'
      }</dd>
      <dt>Accuracy</dt>
      <dd data-accuracy>${fix ? `±${fix.accuracyM.toFixed(0)} m` : '—'}</dd>
    </dl>
    ${state.error ? notice(state.error.message) : ''}
    ${refusal && fix ? notice(refusal) : ''}
    <p>
      <button data-tap ${refusal ? 'disabled' : ''}>
        I’m standing on ${corner}
      </button>
    </p>
    ${done ? `<p><button data-retap="a1" class="secondary">Re-do a1</button></p>` : ''}
  `;
}

function reviewHtml(draft: CalibrationDraft): string {
  const check = draftCheck(draft);
  if (!check) return '';

  return `
    <h1>Does this look right?</h1>
    <dl class="readout">
      <dt>Squares</dt>
      <dd data-square>${check.squareM.toFixed(1)} m across</dd>
      <dt>Board</dt>
      <dd data-board>${check.boardM.toFixed(0)} m a side</dd>
      <dt>Facing</dt>
      <dd data-bearing>${check.bearingDeg.toFixed(0)}° (a→h)</dd>
    </dl>
    ${check.errors.map(notice).join('')}
    ${check.warnings.map(warning).join('')}
    <p>
      <label>Name this field<br />
        <input data-name type="text" value="${escapeHtml(draft.name)}" maxlength="60" />
      </label>
    </p>
    <p>
      <button data-save ${check.ok ? '' : 'disabled'}>Save this field</button>
    </p>
    <p>
      <button data-retap="a1" class="secondary">Re-do a1</button>
      <button data-retap="h8" class="secondary">Re-do h8</button>
    </p>
  `;
}

function notice(message: string): string {
  return `<p class="notice" data-notice>${escapeHtml(message)}</p>`;
}

function warning(message: string): string {
  return `<p class="notice warning" data-warning>${escapeHtml(message)}</p>`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
