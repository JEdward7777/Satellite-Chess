/**
 * The two screens a field of your own gets: looking at one, and being offered one.
 *
 * They are in one file because they are two ends of the same act. Stage 6.4 is
 * sharing a field, and a share has a sender's screen and a receiver's screen;
 * splitting them would put the QR that is produced and the QR that is honoured
 * in different places, and the whole claim of decision 0016 is that they are the
 * same twelve bytes.
 *
 * The sender's screen is also where a copied field stops being a curiosity and
 * becomes property. Decision 0016 promises the recipient owns it outright — they
 * can rename it, re-calibrate it, or delete it — and until this screen existed
 * none of those three was reachable from anywhere in the app. A field arriving on
 * a phone with no way to get rid of it is not a gift.
 *
 * As everywhere else in this project the model is elsewhere (`client/fields.ts`,
 * `shared/fieldlink.ts`) and what is here is DOM, verified by driving Chromium
 * rather than by unit tests.
 */

import { type FieldSpec, checkCalibration, deriveGeometry } from '../../shared/field.js';
import { type FieldLink, encodeFieldLink, fieldUrl } from '../../shared/fieldlink.js';
import { encodeQr, qrSvg } from '../../shared/qr.js';
import type { FieldOffer } from '../fields.js';
import { copyLink, detectShareCapabilities, fieldShareData, shareLink } from '../share.js';

/**
 * Error correction for a field symbol, and the reasoning is not the invite's.
 *
 * A field link is self-contained, so it is three times the payload of a join
 * code and lands several QR versions higher before any recovery is bought. It is
 * also the one symbol in this app that may end up **printed on a sign at the
 * park**, read at an angle, in sunlight, by a phone that is not being held still
 * — and there the binding constraint is module size, not damage.
 *
 * So `M`, the same as the invite, and the sparsity is bought where it is cheaper:
 * the field id travels as an eight-byte digest and the name is capped at
 * sixty-four bytes (`shared/fieldlink.ts`). Those two decisions are worth more
 * modules than dropping to `L` would be, and they cost nothing anyone can see.
 */
const EC_LEVEL = 'M';

// ---------------------------------------------------------------------------
// A field you have
// ---------------------------------------------------------------------------

export interface FieldDeps {
  field: FieldSpec;
  /** Overridden in tests and by the browser drivers. */
  origin?: string;
  onOpenBoard(): void;
  onRecalibrate(): void;
  onRename(name: string): void;
  onDelete(): void;
  onBack(): void;
}

export function mountField(root: HTMLElement, deps: FieldDeps): () => void {
  const spec = deps.field;
  const geo = deriveGeometry(spec);
  const origin = deps.origin ?? location.origin;

  // A blob, or nothing. The only way this throws is geometry no calibration
  // could have produced, and losing the QR is not a reason to lose the screen —
  // the same rule the invite screen follows.
  let url = '';
  let symbol = '';
  try {
    url = fieldUrl(origin, encodeFieldLink(spec));
    symbol = qrSvg(encodeQr(url, { ecLevel: EC_LEVEL }), { title: `The field ${spec.name}` });
  } catch {
    url = '';
    symbol = '';
  }

  const caps = detectShareCapabilities();

  root.innerHTML = `
    <h1 data-field-name>${escapeHtml(spec.name)}</h1>
    ${provenanceHtml(spec)}

    <dl class="readout">
      <dt>Squares</dt><dd data-square>${geo.squareM.toFixed(1)} m across</dd>
      <dt>Board</dt><dd data-board>${(geo.squareM * 8).toFixed(0)} m a side</dd>
      <dt>Facing</dt><dd data-bearing>${geo.bearingDeg.toFixed(0)}° (a→h)</dd>
    </dl>

    <p><button data-open>Open the board</button></p>

    <h2>Share this field</h2>
    ${
      url
        ? `<p class="dim">Anyone who opens this gets their own copy of ${escapeHtml(spec.name)} —
             the two corners and the name, nothing about you. It works on paper, so it can go
             on a sign.</p>
           <figure class="invite-qr" data-qr>${symbol}
             <figcaption class="dim">Point a camera at this.</figcaption>
           </figure>
           <p><button data-share>${caps.shareSheet ? 'Share the field' : 'Send the field'}</button></p>
           <p><button data-copy class="secondary">Copy link</button></p>
           <p class="dim" data-share-note>The whole field is in the link, so it needs no
             signal to open.</p>`
        : `<p class="notice" data-unshareable>This field is too large to fit in a link.</p>`
    }

    <h2>This copy is yours</h2>
    <p>
      <label>Name<br />
        <input data-name type="text" value="${escapeHtml(spec.name)}" maxlength="60" />
      </label>
    </p>
    <p><button data-rename class="secondary">Rename</button></p>
    <p><button data-recalibrate class="secondary">Re-calibrate it</button></p>
    <p><button data-delete class="secondary">Delete this field</button></p>
    <p><button data-back class="secondary">Back</button></p>
  `;

  const note = root.querySelector<HTMLElement>('[data-share-note]');
  const say = (message: string) => {
    if (note) note.textContent = message;
  };

  // Straight from the tap, with nothing awaited in front of it: one `await` and
  // the browser has discarded the gesture and `navigator.share` fails silently.
  root.querySelector<HTMLButtonElement>('[data-share]')?.addEventListener('click', () => {
    void shareLink(fieldShareData(spec.name, url)).then((outcome) => {
      if (outcome.ok) {
        say(
          outcome.tier === 'clipboard'
            ? 'Link copied. Paste it wherever you like.'
            : 'Sent. Opening it adds a copy of this field to their phone.',
        );
        return;
      }
      say(
        outcome.reason === 'cancelled'
          ? 'The whole field is in the link, so it needs no signal to open.'
          : 'Could not open a share sheet. Show the QR instead, or copy the link.',
      );
    });
  });

  root.querySelector<HTMLButtonElement>('[data-copy]')?.addEventListener('click', () => {
    void copyLink(url).then((outcome) => {
      say(outcome.ok ? 'Link copied.' : `Copy this by hand: ${url}`);
    });
  });

  root.querySelector<HTMLButtonElement>('[data-rename]')?.addEventListener('click', () => {
    const name = root.querySelector<HTMLInputElement>('[data-name]')?.value.trim() ?? '';
    // An empty name would leave a row in the list with nothing to tap on.
    if (name === '' || name === spec.name) return;
    deps.onRename(name);
  });

  root
    .querySelector<HTMLButtonElement>('[data-recalibrate]')
    ?.addEventListener('click', deps.onRecalibrate);

  // Two taps rather than a `confirm()`. The dialog is suppressed outright in a
  // few embeddings, and a delete that silently does nothing is worse than one
  // that asks; this also keeps the flow inside the page, where the drivers can
  // see it.
  const del = root.querySelector<HTMLButtonElement>('[data-delete]');
  del?.addEventListener('click', () => {
    if (del.dataset.armed === 'yes') {
      deps.onDelete();
      return;
    }
    del.dataset.armed = 'yes';
    del.textContent = `Really delete ${spec.name}?`;
  });

  root.querySelector<HTMLButtonElement>('[data-open]')?.addEventListener('click', deps.onOpenBoard);
  root.querySelector<HTMLButtonElement>('[data-back]')?.addEventListener('click', deps.onBack);

  return () => {
    root.innerHTML = '';
  };
}

/**
 * Where this field came from, when it did not come from here.
 *
 * Worth a line because the alternative is a phone quietly filling with ground
 * its owner has never walked, presented exactly as though they had.
 */
function provenanceHtml(spec: FieldSpec): string {
  if (!spec.origin) return '';
  const text =
    spec.origin.via === 'game'
      ? 'Kept from a game you played here.'
      : 'Shared with you. This copy is yours to change.';
  return `<p class="dim" data-origin="${spec.origin.via}">${text}</p>`;
}

// ---------------------------------------------------------------------------
// A field somebody sent you
// ---------------------------------------------------------------------------

export interface FieldOfferDeps {
  offer: FieldOffer;
  onAccept(): void;
  onOpen(): void;
  onDecline(): void;
}

/**
 * `/f/<blob>` has resolved, and this is the answer to "do you want it?".
 *
 * Always asked, never assumed. A link opened out of curiosity, or forwarded
 * three times, must not write to somebody's phone on its own — that is the
 * difference between this and the field a game brings, which the player has
 * accepted by taking a seat in the game (decision 0027).
 */
export function mountFieldOffer(root: HTMLElement, deps: FieldOfferDeps): () => void {
  const { incoming } = deps.offer;
  const check = checkCalibration({ a1: incoming.a1, h8: incoming.h8 });
  const name = incoming.name || 'A field';

  const heading =
    deps.offer.kind === 'update'
      ? 'A newer version of a field you have'
      : deps.offer.kind === 'have'
        ? 'You already have this field'
        : 'Add this field?';

  root.innerHTML = `
    <h1>${escapeHtml(heading)}</h1>
    <div class="invite-code field-name" data-field-offer="${deps.offer.kind}">
      <span class="dim">Field</span>
      <strong data-name>${escapeHtml(name)}</strong>
    </div>

    <dl class="readout">
      <dt>Squares</dt><dd data-square>${check.squareM.toFixed(1)} m across</dd>
      <dt>Board</dt><dd data-board>${check.boardM.toFixed(0)} m a side</dd>
      <dt>Facing</dt><dd data-bearing>${check.bearingDeg.toFixed(0)}° (a→h)</dd>
    </dl>

    ${check.errors.map((m) => `<p class="notice" data-notice>${escapeHtml(m)}</p>`).join('')}
    ${check.warnings.map((m) => `<p class="notice warning" data-warning>${escapeHtml(m)}</p>`).join('')}

    <p class="dim" data-explain>${escapeHtml(explain(deps.offer))}</p>

    ${
      check.ok
        ? deps.offer.kind === 'have'
          ? `<p><button data-open>Open it</button></p>`
          : `<p><button data-accept>${
              deps.offer.kind === 'update' ? 'Update my copy' : 'Add it to my fields'
            }</button></p>`
        : ''
    }
    <p><button data-decline class="secondary">Not now</button></p>
  `;

  root.querySelector<HTMLButtonElement>('[data-accept]')?.addEventListener('click', deps.onAccept);
  root.querySelector<HTMLButtonElement>('[data-open]')?.addEventListener('click', deps.onOpen);
  root.querySelector<HTMLButtonElement>('[data-decline]')?.addEventListener('click', deps.onDecline);

  return () => {
    root.innerHTML = '';
  };
}

/**
 * What accepting actually does, in one sentence.
 *
 * The `have` case is the one that needs saying: nothing is wrong, nothing will
 * happen, and without a sentence explaining that, a link that appears to do
 * nothing reads as a broken link.
 */
function explain(offer: FieldOffer): string {
  switch (offer.kind) {
    case 'new':
      return 'You get your own copy — rename it, re-calibrate it or delete it, and none of ' +
        'that touches the sender\'s. Nothing is sent back.';
    case 'update':
      return `Whoever calibrated ${offer.existing.name} has since done it again. Taking this ` +
        'replaces your corners with theirs. Games already in progress keep the old shape.';
    case 'have':
      return 'It is the same field, at the same calibration. There is nothing to add.';
  }
}

/** A `/f/<blob>` that is not a field. Short, because there is nothing to do about it. */
export function mountFieldLinkFailed(root: HTMLElement, onHome: () => void): () => void {
  root.innerHTML = `
    <h1>That link is not a field</h1>
    <p class="notice" data-reason="bad_field">The field in this link could not be read.</p>
    <p class="dim" data-hint>Links get cut short when they are pasted into a chat, and half a
      link cannot be repaired. Ask for it again, or walk the field out yourself — it takes
      about a minute.</p>
    <p><button data-home class="secondary">Back to the home screen</button></p>
  `;
  root.querySelector<HTMLButtonElement>('[data-home]')?.addEventListener('click', onHome);
  return () => {
    root.innerHTML = '';
  };
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
