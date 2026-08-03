/**
 * Calibration: turn four walked-to corners into a board.
 *
 * The convention is decision 0002 — the taps are the **centres of corner
 * squares**, not the outer corners of the board. "Stand where the white rook
 * goes" is an instruction two people can agree on in a field; "stand at the
 * mathematical corner of an imaginary square" is not.
 *
 * **Four taps, walked round the edge** (decision 0028): a1, h1, h8, a8. Not the
 * diagonal, which is what two taps used to walk. The perimeter is further —
 * about 170 m against 80 — but in a game whose currency is distance walked that
 * is not much of a price, and it buys two things the diagonal could not:
 *
 * - the board may be a **rectangle or a parallelogram**, so it can be laid into
 *   a pitch instead of forcing a square onto it; and
 * - the fit is **over-determined**, so a corner tapped in the wrong place has
 *   somewhere to show up. With two taps and four unknowns the fit passes
 *   through both points whatever they are, and a mis-tap is invisible.
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

export type Corner = 'a1' | 'h1' | 'h8' | 'a8';
export type CalibrateStep = Corner | 'review';

/** Round the edge, not across it. The order the player is walked through. */
export const CORNER_STEPS: readonly Corner[] = ['a1', 'h1', 'h8', 'a8'];

export interface CornerTap {
  pos: LatLng;
  accuracyM: number;
  at: number;
}

export interface CalibrationDraft {
  step: CalibrateStep;
  a1: CornerTap | null;
  h1: CornerTap | null;
  h8: CornerTap | null;
  a8: CornerTap | null;
  name: string;
}

export const DEFAULT_FIELD_NAME = 'My field';

export function emptyDraft(name = DEFAULT_FIELD_NAME): CalibrationDraft {
  return { step: 'a1', a1: null, h1: null, h8: null, a8: null, name };
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
  // Whichever corner was just set, the next screen is the first one still
  // missing — and once all four exist, the review. That is what lets a re-tap
  // from the review screen come straight back to it (stage 1.2.3), rather than
  // marching the player round the remaining corners again.
  const missing = CORNER_STEPS.find((name) => next[name] === null);
  return { ...next, step: missing ?? 'review' };
}

/** Go back to one corner without losing the other, or the name. */
export function retap(draft: CalibrationDraft, corner: Corner): CalibrationDraft {
  return { ...draft, step: corner };
}

export function renameDraft(draft: CalibrationDraft, name: string): CalibrationDraft {
  return { ...draft, name };
}

/** The verdict on the corners, or null while any is still missing. */
export function draftCheck(draft: CalibrationDraft): CalibrationCheck | null {
  const taps = CORNER_STEPS.map((name) => draft[name]);
  if (taps.some((tap) => tap === null)) return null;
  const [a1, h1, h8, a8] = taps as CornerTap[];
  return checkCalibration(
    { a1: a1.pos, h1: h1.pos, h8: h8.pos, a8: a8.pos },
    { worstAccuracyM: Math.max(...taps.map((tap) => (tap as CornerTap).accuracyM)) },
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
  if (!canSave(draft)) return null;
  const taps = CORNER_STEPS.map((name) => draft[name]);
  if (taps.some((tap) => tap === null)) return null;
  const [a1, h1, h8, a8] = taps as CornerTap[];
  const name = draft.name.trim() || DEFAULT_FIELD_NAME;
  const corners = { a1: a1.pos, h1: h1.pos, h8: h8.pos, a8: a8.pos };
  const accuracy = {
    a1: a1.accuracyM,
    h1: h1.accuracyM,
    h8: h8.accuracyM,
    a8: a8.accuracyM,
  };

  if (opts.existing) {
    return {
      ...recalibrate(opts.existing, corners, { accuracy, now: opts.now }),
      name,
    };
  }
  return makeFieldSpec(name, corners, { accuracy, now: opts.now });
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export interface CalibrateDeps {
  gps: GpsProvider;
  store: FieldStore;
  /** Called once the field is on disk, never before. */
  onSaved(spec: FieldSpec): void;
  /**
   * A way out without saving, offered only when there is somewhere to go back to.
   *
   * There was not one while a phone with no fields landed here automatically:
   * calibrating *was* the first run, and "back" meant nothing. Since stage 6.3 a
   * phone that has never calibrated anything still has a home screen — it can
   * join a game on someone else's field — so walking in here by accident has to
   * be undoable.
   */
  onCancel?(): void;
  existing?: FieldSpec;
}

/**
 * Round the edge in order, and the copy has to say so.
 *
 * "The next corner" is ambiguous standing in a field; naming the piece that
 * stands there is not, and going the wrong way round produces a bow-tie the fit
 * cannot make sense of. `checkCalibration` catches it after the fact — this is
 * what stops it happening.
 */
const CORNER_BRIEF: Record<Corner, string> = {
  a1: 'Walk to the corner where White’s queenside rook stands — a1.',
  h1: 'Now walk along White’s back rank to the far end — h1, White’s kingside rook.',
  h8: 'Now straight up the side of the field to h8, Black’s kingside rook.',
  a8: 'Last one: along Black’s back rank to a8, and the board is closed.',
};

/** "2 of 4", so nobody wonders how much walking is left. */
function stepNumber(corner: Corner): string {
  return `${CORNER_STEPS.indexOf(corner) + 1} of ${CORNER_STEPS.length}`;
}

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
    const screen = draft.step === 'review' ? reviewHtml(draft) : cornerHtml(draft, gpsState);
    root.innerHTML = deps.onCancel
      ? `${screen}<p><button data-cancel class="secondary">Not now</button></p>`
      : screen;
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

    const cancel = deps.onCancel;
    if (cancel) {
      root.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', cancel);
    }
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
  const done = CORNER_STEPS.filter((name) => draft[name] !== null && name !== corner);

  return `
    <h1>Calibrate a field</h1>
    <p class="dim" data-step>Corner ${stepNumber(corner)}</p>
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
    ${
      done.length === 0
        ? ''
        : `<p>${done
            .map((name) => `<button data-retap="${name}" class="secondary">Re-do ${name}</button>`)
            .join(' ')}</p>`
    }
  `;
}

function reviewHtml(draft: CalibrationDraft): string {
  const check = draftCheck(draft);
  if (!check) return '';

  return `
    <h1>Does this look right?</h1>
    <dl class="readout">
      <dt>Squares</dt>
      <dd data-square>${
        Math.abs(check.fileM - check.rankM) < 0.1
          ? `${check.fileM.toFixed(1)} m across`
          : `${check.fileM.toFixed(1)} m along the files, ${check.rankM.toFixed(1)} m along the ranks`
      }</dd>
      <dt>Board</dt>
      <dd data-board>${check.boardM.toFixed(0)} m across</dd>
      <dt>Facing</dt>
      <dd data-bearing>${check.bearingDeg.toFixed(0)}° (a→h)</dd>
      <dt>Corner fit</dt>
      <dd data-residual>±${check.residualM.toFixed(1)} m</dd>
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
      ${CORNER_STEPS.map(
        (name) => `<button data-retap="${name}" class="secondary">Re-do ${name}</button>`,
      ).join('\n      ')}
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
