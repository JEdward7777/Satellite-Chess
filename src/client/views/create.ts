/**
 * The create screen: which field, how long, which colour, and who gets a hand.
 *
 * Four choices, and each one is here because the game cannot sensibly guess it.
 * The field is a physical place two people have agreed on; the time control has
 * to pay for walking (decision 0012); colour matters more than usual because it
 * also decides *which end of the field you stand at*; and the handicap is reach,
 * not clock (decision 0004), which means it is a property of the game rather
 * than something either player can adjust once play starts.
 *
 * As everywhere else in this client, the model above the line is pure and tested
 * in node, and the DOM below it is verified by driving Chromium against `?sim=1`.
 */

import { DEFAULT_TIME_CONTROL, TIME_CONTROLS, type TimeControl } from '../../shared/clock.js';
import { type FieldSpec, deriveGeometry } from '../../shared/field.js';
import { DEFAULT_REACH, type ReachBonuses } from '../../shared/reach.js';
import type { Color } from '../../shared/squares.js';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** What the creator asked for. `random` is resolved before the game is made. */
export type ColourChoice = Color | 'random';

/**
 * Who the handicap is for, in the only terms the person setting it up has.
 *
 * Deliberately not "White" and "Black": the creator may not have chosen a colour
 * yet, and "give my opponent two metres" is a thing you say out loud in a park
 * whereas "set blackReachBonusM" is not.
 */
export type HandicapTo = 'none' | 'me' | 'opponent';

export interface CreateDraft {
  /** `FieldSpec.id`. */
  fieldId: string;
  /** Index into {@link TIME_CONTROLS}. */
  timeControl: number;
  colour: ColourChoice;
  handicapTo: HandicapTo;
  handicapM: number;
}

/**
 * The most reach a handicap can add from this screen.
 *
 * This is a bound on the control, not the fix for **O-02** — that observation is
 * about the reach *ceiling* rising with the bonus, and it says the right cap is a
 * measurement rather than a guess. Four metres is chosen so the worst case the UI
 * can produce stays close to what decision 0004 describes ("one or two metres
 * changes what you can stretch to"), and so that no game created today has a
 * handicap the eventual cap would have to invalidate.
 */
export const MAX_HANDICAP_M = 4;

/** Where the shared default sits in the list, so the two cannot drift apart. */
export const DEFAULT_TIME_CONTROL_INDEX = TIME_CONTROLS.indexOf(DEFAULT_TIME_CONTROL);

export function emptyDraft(fields: FieldSpec[]): CreateDraft {
  return {
    // The list is newest-first, so this is the field just calibrated — which is
    // overwhelmingly the one being played on.
    fieldId: fields[0]?.id ?? '',
    timeControl: DEFAULT_TIME_CONTROL_INDEX,
    colour: 'w',
    handicapTo: 'none',
    handicapM: 1,
  };
}

export function draftField(draft: CreateDraft, fields: FieldSpec[]): FieldSpec | undefined {
  return fields.find((f) => f.id === draft.fieldId) ?? fields[0];
}

export function draftTimeControl(draft: CreateDraft): TimeControl {
  return TIME_CONTROLS[draft.timeControl] ?? TIME_CONTROLS[DEFAULT_TIME_CONTROL_INDEX];
}

/** Clamp a metres value onto the range the control offers. */
export function clampHandicap(metres: number): number {
  if (!Number.isFinite(metres)) return 0;
  return Math.min(MAX_HANDICAP_M, Math.max(0, Math.round(metres)));
}

/**
 * Turn `random` into a real colour.
 *
 * Resolved on the client rather than the server so that the create screen can
 * say which end of the field to walk to before anyone starts walking. The coin
 * is injectable because a test that flakes one time in two is worse than no test.
 */
export function resolveColour(choice: ColourChoice, coin: () => number = Math.random): Color {
  if (choice !== 'random') return choice;
  return coin() < 0.5 ? 'w' : 'b';
}

/**
 * The per-colour reach bonus the API wants, from the per-person one the screen
 * asked for.
 */
export function reachBonuses(draft: CreateDraft, myColour: Color): ReachBonuses {
  if (draft.handicapTo === 'none') return { w: 0, b: 0 };
  const metres = clampHandicap(draft.handicapM);
  const opponent: Color = myColour === 'w' ? 'b' : 'w';
  const recipient = draft.handicapTo === 'me' ? myColour : opponent;
  return { w: recipient === 'w' ? metres : 0, b: recipient === 'b' ? metres : 0 };
}

/** The body of `POST /api/game`. The server re-validates every field of it. */
export function createGameBody(
  draft: CreateDraft,
  field: FieldSpec,
  playerId: string,
  myColour: Color,
): Record<string, unknown> {
  const time = draftTimeControl(draft);
  const bonuses = reachBonuses(draft, myColour);
  return {
    playerId,
    field,
    color: myColour,
    initialMs: time.initialMs,
    incrementMs: time.incrementMs,
    whiteReachBonusM: bonuses.w,
    blackReachBonusM: bonuses.b,
  };
}

/** Why this draft cannot be submitted, or null. */
export function createRefusal(draft: CreateDraft, fields: FieldSpec[]): string | null {
  if (fields.length === 0) return 'Calibrate a field first — a game needs somewhere to be played.';
  if (!draftField(draft, fields)) return 'Choose a field.';
  return null;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export interface CreateDeps {
  fields: FieldSpec[];
  /** Called with the resolved draft. The caller does the network work. */
  onCreate(draft: CreateDraft, field: FieldSpec, colour: Color): void;
  onCancel(): void;
  /** Overridden in tests so the coin does not flake. */
  coin?(): number;
}

const COLOUR_LABELS: Record<ColourChoice, string> = {
  w: 'White',
  b: 'Black',
  random: 'Random',
};

/** Short enough to sit on one line each: a wrapped label makes the row ragged. */
const HANDICAP_LABELS: Record<HandicapTo, string> = {
  none: 'Nobody',
  me: 'Me',
  opponent: 'Opponent',
};

export function mountCreate(root: HTMLElement, deps: CreateDeps): () => void {
  let draft = emptyDraft(deps.fields);
  let creating = false;

  function paint(): void {
    root.innerHTML = html(draft, deps.fields);
    wire();
  }

  function update(next: Partial<CreateDraft>): void {
    draft = { ...draft, ...next };
    paint();
  }

  function wire(): void {
    // `querySelector<HTMLSelectElement>` does not compile under
    // `tsconfig.tools.json`, which is the one config where the DOM and Workers
    // globals coexist (decision 0021). `HTMLSelectElement` redeclares
    // `remove()`, and the merged `Element` already has HTMLRewriter's, which
    // returns something else — so the type argument fails a constraint that has
    // nothing to do with this code. Selecting untyped and casting the target
    // sidesteps it; the other views only ever ask for inputs and buttons, which
    // do not redeclare `remove` and so have never hit this.
    const onSelect = (selector: string, handle: (value: string) => void) => {
      root.querySelector(selector)?.addEventListener('change', (event) => {
        handle((event.target as HTMLSelectElement).value);
      });
    };
    onSelect('[data-field]', (value) => update({ fieldId: value }));
    onSelect('[data-time]', (value) => update({ timeControl: Number(value) }));
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-colour]')) {
      button.addEventListener('click', () => {
        update({ colour: button.dataset.colour as ColourChoice });
      });
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-handicap]')) {
      button.addEventListener('click', () => {
        update({ handicapTo: button.dataset.handicap as HandicapTo });
      });
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-metres]')) {
      button.addEventListener('click', () => {
        update({ handicapM: clampHandicap(draft.handicapM + Number(button.dataset.metres)) });
      });
    }
    root.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', deps.onCancel);
    root.querySelector<HTMLButtonElement>('[data-create]')?.addEventListener('click', () => {
      if (creating) return;
      const field = draftField(draft, deps.fields);
      if (!field || createRefusal(draft, deps.fields)) return;
      creating = true;
      deps.onCreate(draft, field, resolveColour(draft.colour, deps.coin));
    });
  }

  paint();
  return () => {
    root.innerHTML = '';
  };
}

function html(draft: CreateDraft, fields: FieldSpec[]): string {
  const refusal = createRefusal(draft, fields);
  const selected = draftField(draft, fields);

  return `
    <h1>New game</h1>
    ${refusal ? `<p class="notice" data-notice>${escapeHtml(refusal)}</p>` : ''}

    <h2>Field</h2>
    <p>
      <select data-field ${fields.length === 0 ? 'disabled' : ''}>
        ${fields
          .map(
            (field) =>
              `<option value="${escapeHtml(field.id)}" ${
                field.id === selected?.id ? 'selected' : ''
              }>${escapeHtml(field.name)}</option>`,
          )
          .join('')}
      </select>
    </p>
    ${selected ? `<p class="dim" data-field-size>${fieldSummary(selected)}</p>` : ''}

    <h2>Time control</h2>
    <p>
      <select data-time>
        ${TIME_CONTROLS.map(
          (control, index) =>
            `<option value="${index}" ${index === draft.timeControl ? 'selected' : ''}>${
              escapeHtml(control.label)
            }</option>`,
        ).join('')}
      </select>
    </p>
    <p class="dim">
      The increment pays for walking, not for thinking — it is the reason the
      shortest option here is still ten minutes.
    </p>

    <h2>You play</h2>
    <div class="choices" data-colours>
      ${(['w', 'b', 'random'] as ColourChoice[])
        .map(
          (choice) =>
            `<button data-colour="${choice}" class="choice ${
              draft.colour === choice ? 'is-on' : ''
            }" aria-pressed="${draft.colour === choice}">${COLOUR_LABELS[choice]}</button>`,
        )
        .join('')}
    </div>
    <p class="dim" data-colour-note>${escapeHtml(colourNote(draft.colour))}</p>

    <h2>Extra reach</h2>
    <div class="choices" data-handicaps>
      ${(['none', 'me', 'opponent'] as HandicapTo[])
        .map(
          (choice) =>
            `<button data-handicap="${choice}" class="choice ${
              draft.handicapTo === choice ? 'is-on' : ''
            }" aria-pressed="${draft.handicapTo === choice}">${HANDICAP_LABELS[choice]}</button>`,
        )
        .join('')}
    </div>
    ${
      draft.handicapTo === 'none'
        ? `<p class="dim">Both players reach the same distance.</p>`
        : `<div class="stepper" data-stepper>
             <button data-metres="-1" class="secondary" ${
               draft.handicapM <= 0 ? 'disabled' : ''
             } aria-label="Less reach">−</button>
             <strong data-handicap-m>+${clampHandicap(draft.handicapM)} m</strong>
             <button data-metres="1" class="secondary" ${
               draft.handicapM >= MAX_HANDICAP_M ? 'disabled' : ''
             } aria-label="More reach">+</button>
           </div>
           <p class="dim" data-handicap-note>${escapeHtml(handicapNote(draft))}</p>`
    }

    <p>
      <button data-create ${refusal ? 'disabled' : ''}>Create the game</button>
    </p>
    <p><button data-cancel class="secondary">Back</button></p>
  `;
}

function fieldSummary(field: FieldSpec): string {
  const geo = deriveGeometry(field);
  return `${geo.squareM.toFixed(1)} m squares · ${(geo.squareM * 8).toFixed(0)} m a side`;
}

function colourNote(choice: ColourChoice): string {
  if (choice === 'random') return 'The coin is tossed when the game is created.';
  // Which colour you are is also which end you walk to, which is worth saying
  // before anyone starts walking.
  return choice === 'w'
    ? 'You start on the a1–h1 rank and move first.'
    : 'You start on the a8–h8 rank and move second.';
}

function handicapNote(draft: CreateDraft): string {
  const metres = clampHandicap(draft.handicapM);
  const who = draft.handicapTo === 'me' ? 'You' : 'Your opponent';
  return (
    `${who} may stretch ${metres} m further than the usual ${DEFAULT_REACH.baseM} m. ` +
    'Both players see the circle, so it is a stated fact rather than a hidden setting.'
  );
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
