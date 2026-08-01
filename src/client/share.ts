/**
 * Sharing an invite, through whatever the device actually has.
 *
 * Decision 0015 is the specification: the OS share sheet first, then a
 * `mailto:` link, then the clipboard. One generic path covers Mail, Messages,
 * WhatsApp, Signal, AirDrop and copy-link, because the OS already knows which
 * apps the player has installed and we do not have to care — and the Worker
 * sends no email, so there is no provider account, no DKIM, and no way to abuse
 * us as a spam cannon.
 *
 * Two things about `navigator.share` decide the shape of everything below.
 *
 * **It needs a real user gesture, and it must be called synchronously from the
 * tap handler.** One `await` before it and the browser has forgotten the tap;
 * the call then rejects with no visible cause, which is the exact failure decision
 * 0015 warns about. So `shareInvite` does no asynchronous work before it decides
 * — the message is composed by pure functions the caller could have called
 * itself, and the tier is chosen by looking at `navigator`, not by trying.
 *
 * **A dismissed sheet rejects.** Backing out of the share sheet throws
 * `AbortError`, and treating that as a failure would pop a mail client at
 * someone who has just decided not to share. Cancelling is a successful outcome
 * of asking; only a genuine failure falls through to the next tier.
 */

import { formatJoinCode } from '../shared/joincode.js';

/** Everything the tiers need to say. */
export interface Invite {
  /** The full `https://host/j/CODE` link. */
  url: string;
  /** The canonical six-character code. */
  code: string;
  /** The field's name, when there is one worth naming. */
  fieldName?: string;
}

export type ShareTier = 'share-sheet' | 'mailto' | 'clipboard' | 'manual';

export type ShareOutcome =
  /** It went somewhere: the sheet accepted it, or the mail client opened. */
  | { ok: true; tier: ShareTier }
  /** The player backed out of the sheet. Not a failure, and not worth retrying. */
  | { ok: false; tier: ShareTier; reason: 'cancelled' }
  /** Nothing worked. The code and the QR on screen are still the answer. */
  | { ok: false; tier: ShareTier; reason: 'failed' };

/** What the platform can do. Passed in so the decision is testable without a browser. */
export interface ShareCapabilities {
  shareSheet: boolean;
  clipboard: boolean;
  /** `mailto:` needs somewhere to navigate to. Absent only in odd embeddings. */
  navigate: boolean;
}

export function detectShareCapabilities(nav: Navigator = navigator): ShareCapabilities {
  return {
    // `canShare` is checked as well as `share`, because a few embedded webviews
    // expose `share` and then reject everything they are given.
    shareSheet: typeof nav.share === 'function',
    clipboard: typeof nav.clipboard?.writeText === 'function',
    navigate: true,
  };
}

export function preferredTier(caps: ShareCapabilities): ShareTier {
  if (caps.shareSheet) return 'share-sheet';
  if (caps.navigate) return 'mailto';
  if (caps.clipboard) return 'clipboard';
  return 'manual';
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

const SUBJECT = 'A game of Satellite Chess';

/**
 * The share payload.
 *
 * The code appears in the text *and* is already the last part of the URL, which
 * is deliberate: several share targets keep only one of `text` and `url`, and a
 * recipient who ends up with just the link can still read the code off the end
 * of it and type it in. That redundancy is the reason the code is in the path
 * rather than a query parameter.
 */
export function inviteShareData(invite: Invite): { title: string; text: string; url: string } {
  const where = invite.fieldName ? ` at ${invite.fieldName}` : '';
  return {
    title: SUBJECT,
    text: `Come and play chess on a real field${where}. Join code ${formatJoinCode(invite.code)}.`,
    url: invite.url,
  };
}

/**
 * A `mailto:` for the second tier.
 *
 * Body rather than subject carries the link, because a subject line is often
 * truncated and is never auto-linked. The line break is `\r\n`, which is what
 * the `mailto:` grammar wants — a bare `\n` is dropped by some clients and the
 * message arrives as one run-on paragraph.
 */
export function inviteMailto(invite: Invite): string {
  const { text, url } = inviteShareData(invite);
  const body = `${text}\r\n\r\n${url}\r\n`;
  return `mailto:?subject=${encodeURIComponent(SUBJECT)}&body=${encodeURIComponent(body)}`;
}

// ---------------------------------------------------------------------------
// Doing it
// ---------------------------------------------------------------------------

export interface ShareDeps {
  nav?: Navigator;
  /** Overridden in tests; in the app this is a plain assignment to `location`. */
  navigate?(href: string): void;
}

/**
 * Offer the invite to the OS, falling back a tier at a time.
 *
 * **Call this straight from the click handler.** It reaches `navigator.share`
 * with nothing awaited in front of it, which is the only way the browser will
 * accept the gesture.
 */
export function shareInvite(invite: Invite, deps: ShareDeps = {}): Promise<ShareOutcome> {
  const nav = deps.nav ?? navigator;
  const caps = detectShareCapabilities(nav);

  if (caps.shareSheet) {
    // No `await` above this line. Deliberately.
    return nav
      .share(inviteShareData(invite))
      .then<ShareOutcome>(() => ({ ok: true, tier: 'share-sheet' }))
      .catch((error: unknown): Promise<ShareOutcome> | ShareOutcome => {
        if (isAbort(error)) return { ok: false, tier: 'share-sheet', reason: 'cancelled' };
        // A share sheet that failed for any other reason — no targets, a
        // webview that lied about supporting it — should still get the invite
        // out, so keep going down the tiers.
        return fallback(invite, caps, deps);
      });
  }

  return fallback(invite, caps, deps);
}

function fallback(
  invite: Invite,
  caps: ShareCapabilities,
  deps: ShareDeps,
): Promise<ShareOutcome> {
  if (caps.navigate) {
    try {
      (deps.navigate ?? defaultNavigate)(inviteMailto(invite));
      return Promise.resolve<ShareOutcome>({ ok: true, tier: 'mailto' });
    } catch {
      // A device with no mail client configured. Nothing is thrown on most
      // platforms — the navigation simply does nothing — so this is belt and
      // braces rather than the expected path.
    }
  }
  return copyInvite(invite, deps);
}

/** The last tier that can still act: put the link on the clipboard. */
export function copyInvite(invite: Invite, deps: ShareDeps = {}): Promise<ShareOutcome> {
  const nav = deps.nav ?? navigator;
  if (typeof nav.clipboard?.writeText !== 'function') {
    return Promise.resolve<ShareOutcome>({ ok: false, tier: 'manual', reason: 'failed' });
  }
  return nav.clipboard
    .writeText(invite.url)
    .then<ShareOutcome>(() => ({ ok: true, tier: 'clipboard' }))
    .catch<ShareOutcome>(() => ({ ok: false, tier: 'clipboard', reason: 'failed' }));
}

function defaultNavigate(href: string): void {
  location.href = href;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
