/**
 * The invite screen: a code, a QR, and a share sheet.
 *
 * Three ways to hand over the same thing, and all three are on screen at once on
 * purpose (stage 6.1.2). They fail differently:
 *
 * - **The QR** is the fastest, and needs a working camera, a granted permission
 *   and enough light. Any of those can go sideways in a park.
 * - **The typed code** needs nothing but eyes, and is the one you read aloud
 *   across a field. It is the smallest code path and so the most reliable.
 * - **The share sheet** is the one that works when your opponent is not standing
 *   next to you yet — which is the case decision 0015 cares most about, because
 *   it means they sign in at home on wifi rather than on one bar in a field.
 *
 * The URL is built from `location.origin`, so the QR points at whatever host the
 * app is actually being served from: `wrangler dev` on a laptop, a `workers.dev`
 * subdomain, or a custom domain later. Hard-coding it would produce a QR that
 * scans perfectly and goes to the wrong place, which is worse than one that
 * does not scan.
 */

import { formatJoinCode, joinUrl } from '../../shared/joincode.js';
import { encodeQr, qrSvg } from '../../shared/qr.js';
import type { FieldSpec } from '../../shared/field.js';
import type { Color } from '../../shared/squares.js';
import { type Invite, copyInvite, detectShareCapabilities, shareInvite } from '../share.js';

export interface InviteDeps {
  joinCode: string;
  field: FieldSpec;
  /** The creator's colour, so the screen can say which end to walk to. */
  colour: Color;
  /** Overridden in tests and by the deep-link driver. */
  origin?: string;
  onOpenBoard(): void;
  onLeave(): void;
}

/**
 * Error correction for the invite symbol.
 *
 * `M` rather than `L`: the symbol is scanned off a phone screen held at an angle
 * in daylight, often with a fingerprint across it, and the recovery is worth
 * more than the two versions it costs. Stage 6.4 prints one on a sign, where the
 * argument is stronger still.
 */
const EC_LEVEL = 'M';

export function inviteFor(joinCode: string, field: FieldSpec, origin: string): Invite {
  return { url: joinUrl(origin, joinCode), code: joinCode, fieldName: field.name };
}

export function mountInvite(root: HTMLElement, deps: InviteDeps): () => void {
  const origin = deps.origin ?? location.origin;
  const invite = inviteFor(deps.joinCode, deps.field, origin);
  const caps = detectShareCapabilities();

  // Encoded once. It never changes while this screen is up, and re-encoding on
  // every repaint would be the kind of waste that only shows up on an old phone.
  let symbol: string;
  try {
    symbol = qrSvg(encodeQr(invite.url, { ecLevel: EC_LEVEL }), {
      title: `Join code ${formatJoinCode(invite.code)}`,
    });
  } catch {
    // A URL too long to encode is not a reason to lose the screen: the code and
    // the share sheet still work, and they are the paths that matter most.
    symbol = '';
  }

  root.innerHTML = `
    <h1>Invite your opponent</h1>

    <div class="invite-code" data-join-code="${invite.code}">
      <span class="dim">Join code</span>
      <strong data-code>${formatJoinCode(invite.code)}</strong>
    </div>

    ${
      symbol
        ? `<figure class="invite-qr" data-qr>${symbol}
             <figcaption class="dim">Point a camera at this.</figcaption>
           </figure>`
        : `<p class="notice">Could not draw a QR code. Read the code out instead.</p>`
    }

    <p>
      <button data-share>${caps.shareSheet ? 'Share the invite' : 'Send the invite'}</button>
    </p>
    <p>
      <button data-copy class="secondary">Copy link</button>
    </p>
    <p class="dim" data-share-note>${escapeHtml(shareNote(invite.url))}</p>

    <h2>Then</h2>
    <p class="dim" data-start-note>${escapeHtml(startNote(deps.colour, deps.field))}</p>
    <p><button data-open>Open the board</button></p>
    <p><button data-leave class="secondary">Leave this game</button></p>
  `;

  const note = root.querySelector<HTMLElement>('[data-share-note]');
  const say = (message: string) => {
    if (note) note.textContent = message;
  };

  // Not `async`, and it does not await anything before `shareInvite`. The share
  // sheet needs the user gesture to still be live, and one `await` in front of
  // it is enough to lose it silently (decision 0015).
  root.querySelector<HTMLButtonElement>('[data-share]')?.addEventListener('click', () => {
    void shareInvite(invite).then((outcome) => {
      if (outcome.ok) {
        say(
          outcome.tier === 'clipboard'
            ? 'Link copied. Paste it wherever you like.'
            : 'Sent. Your opponent can open the link, or type the code.',
        );
        return;
      }
      // Cancelling the sheet is a decision, not a failure — say nothing about it.
      say(
        outcome.reason === 'cancelled'
          ? shareNote(invite.url)
          : 'Could not open a share sheet. Read the code out, or show the QR.',
      );
    });
  });

  root.querySelector<HTMLButtonElement>('[data-copy]')?.addEventListener('click', () => {
    void copyInvite(invite).then((outcome) => {
      say(outcome.ok ? 'Link copied.' : `Copy this by hand: ${invite.url}`);
    });
  });

  root.querySelector<HTMLButtonElement>('[data-open]')?.addEventListener('click', deps.onOpenBoard);
  root.querySelector<HTMLButtonElement>('[data-leave]')?.addEventListener('click', deps.onLeave);

  return () => {
    root.innerHTML = '';
  };
}

function shareNote(url: string): string {
  return `The link is ${url} — the last six characters are the code itself.`;
}

/**
 * What happens next, in physical terms.
 *
 * The game starts when both players are standing in their own start zones
 * (decision 0005), which means the useful instruction here is a direction to
 * walk in, not a button to press. See O-08: the clock can start while nobody is
 * looking at a phone, so it is worth saying so before it does.
 */
function startNote(colour: Color, field: FieldSpec): string {
  const rank = colour === 'w' ? 'a1–h1' : 'a8–h8';
  return (
    `Walk to your back rank — ${rank} on ${field.name}. ` +
    'The clock starts by itself once you are both standing on yours.'
  );
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
