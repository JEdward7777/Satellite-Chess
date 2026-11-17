/**
 * Taking a seat in a remote game: which of your own fields, and the
 * disclosure (stage 12.2, decision 0060 points 1 and 4).
 *
 * A remote game is played on two fields, and the joiner brings theirs. The
 * phone learns the game is remote from the server's first answer
 * (`field_required`, with nothing written), and comes here: choose a field
 * this phone already has, or calibrate one and come back, and accept the
 * note about your location. Only then does the join go again, with both.
 *
 * Shown on every remote join, never remembered: the acceptance is for this
 * game. A seat already held is re-joined without coming here at all, because
 * the server answers it with the seat.
 *
 * As everywhere in this client, the model above the line is pure and tested
 * in node, and the DOM below is checked by driving Chromium against `?sim=1`.
 */

import { type FieldSpec, deriveGeometry, describeSquares } from '../../shared/field.js';
import { formatJoinCode } from '../../shared/joincode.js';
import type { Units } from '../../shared/units.js';
import { DISCLOSURE_NEEDED, disclosureHtml } from '../disclosure.js';
import { displayUnits } from '../units.js';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Why the join cannot be sent yet, or null. */
export function remoteJoinRefusal(field: FieldSpec | undefined, accepted: boolean): string | null {
  if (field === undefined) return 'Calibrate a field first. You play this game on a field of your own.';
  if (!accepted) return DISCLOSURE_NEEDED;
  return null;
}

/** The field to start on: the one asked for, else the newest, which is the list's first. */
export function startingField(fields: readonly FieldSpec[], preferred?: string): FieldSpec | undefined {
  return fields.find((f) => f.id === preferred) ?? fields[0];
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export interface RemoteJoinDeps {
  /** Already normalised. */
  code: string;
  /** This phone's fields, newest first. */
  fields: FieldSpec[];
  /** Chosen to start with, when there is one: a field just calibrated for this. */
  preferredFieldId?: string;
  /** Called with the field and the box checked. The caller does the network work. */
  onJoin(field: FieldSpec): void;
  /** Calibrate a new field, and come back here with it. */
  onCalibrate(): void;
  onCancel(): void;
}

export function mountRemoteJoin(root: HTMLElement, deps: RemoteJoinDeps): () => void {
  let chosen = startingField(deps.fields, deps.preferredFieldId);
  let accepted = false;
  let joining = false;

  function paint(): void {
    root.innerHTML = html(deps, chosen, accepted, displayUnits().get());
    root.querySelector('[data-field]')?.addEventListener('change', (event) => {
      // Untyped and cast: see `views/create.ts` on `HTMLSelectElement`.
      const id = (event.target as HTMLSelectElement).value;
      chosen = deps.fields.find((f) => f.id === id) ?? chosen;
      paint();
    });
    root.querySelector<HTMLInputElement>('[data-disclosure]')?.addEventListener('change', (event) => {
      accepted = (event.target as HTMLInputElement).checked;
      paint();
    });
    root.querySelector<HTMLButtonElement>('[data-calibrate]')?.addEventListener('click', deps.onCalibrate);
    root.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', deps.onCancel);
    root.querySelector<HTMLButtonElement>('[data-join]')?.addEventListener('click', () => {
      if (joining || chosen === undefined || remoteJoinRefusal(chosen, accepted) !== null) return;
      joining = true;
      deps.onJoin(chosen);
    });
  }

  paint();
  return () => {
    root.innerHTML = '';
  };
}

function html(deps: RemoteJoinDeps, chosen: FieldSpec | undefined, accepted: boolean, units: Units): string {
  const refusal = remoteJoinRefusal(chosen, accepted);
  return `
    <h1>Join a game on two fields</h1>
    <div class="invite-code" data-join-code="${escapeHtml(deps.code)}">
      <span class="dim">Join code</span>
      <strong data-code>${escapeHtml(formatJoinCode(deps.code))}</strong>
    </div>
    <p class="dim" data-remote-intro>
      You play this game on a field of your own, and your opponent on theirs.
      The larger board shrinks to the smaller one's squares, so a move is the same walk for both of you.
    </p>

    <h2>Your field</h2>
    ${
      deps.fields.length === 0
        ? `<p class="dim" data-no-fields>You have no fields yet. Calibrate one where you will play.</p>`
        : `<p>
      <select data-field>
        ${deps.fields
          .map(
            (field) =>
              `<option value="${escapeHtml(field.id)}" ${field.id === chosen?.id ? 'selected' : ''}>${escapeHtml(
                field.name,
              )}</option>`,
          )
          .join('')}
      </select>
    </p>
    ${chosen ? `<p class="dim" data-field-size>${escapeHtml(fieldSummary(chosen, units))}</p>` : ''}`
    }
    <p><button data-calibrate class="secondary">Calibrate a new field</button></p>

    ${disclosureHtml(accepted)}
    ${refusal ? `<p class="dim" data-join-hint>${escapeHtml(refusal)}</p>` : ''}
    <p><button data-join ${refusal ? 'disabled' : ''}>Join the game</button></p>
    <p><button data-cancel class="secondary">Cancel</button></p>
  `;
}

function fieldSummary(field: FieldSpec, units: Units): string {
  try {
    return describeSquares(deriveGeometry(field), units);
  } catch {
    return '';
  }
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
