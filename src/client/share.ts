/**
 * Sharing a link, through whatever the device actually has.
 *
 * Two kinds of link go through here — an invitation to a game (decision 0015)
 * and a field (decision 0016, stage 6.4). The ladder is identical for both, so
 * it is written once against a payload; only the sentence differs.
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

/**
 * What actually goes to the OS: a title, a sentence, and a link.
 *
 * Two things are shared through this ladder — an invitation to a game and a
 * field (decision 0016) — and the ladder cannot tell them apart, which is the
 * point. Composing the words is the caller's job; getting them out of the phone
 * is this file's.
 */
export interface SharePayload {
  title: string;
  text: string;
  url: string;
}

/** Everything the tiers need to say. */
export interface Invite {
  /** The full `https://host/j/CODE` link. */
  url: string;
  /** The canonical six-character code. */
  code: string;
  /** The field's name, when there is one worth naming. */
  fieldName?: string;
}

export type ShareTier = 'share-file' | 'share-sheet' | 'mailto' | 'clipboard' | 'manual';

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
export function inviteShareData(invite: Invite): SharePayload {
  const where = invite.fieldName ? ` at ${invite.fieldName}` : '';
  return {
    title: SUBJECT,
    text: `Come and play chess on a real field${where}. Join code ${formatJoinCode(invite.code)}.`,
    url: invite.url,
  };
}

/**
 * The same, for a field rather than a game (stage 6.4).
 *
 * No code to read out, because there is nothing at the far end to look a code up
 * in: the link *is* the field. So the sentence has to carry what the recipient
 * is being offered — a place, by name — since a bare URL with a hundred
 * characters of base64 in it reads like something to be suspicious of.
 */
export function fieldShareData(name: string, url: string): SharePayload {
  return {
    title: `${name} — a Satellite Chess field`,
    text: `Here is ${name}, laid out as a chessboard. Open this to add it to your fields.`,
    url,
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
export function mailtoFor(payload: SharePayload): string {
  const body = `${payload.text}\r\n\r\n${payload.url}\r\n`;
  return `mailto:?subject=${encodeURIComponent(payload.title)}&body=${encodeURIComponent(body)}`;
}

export function inviteMailto(invite: Invite): string {
  return mailtoFor(inviteShareData(invite));
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
export function shareLink(payload: SharePayload, deps: ShareDeps = {}): Promise<ShareOutcome> {
  const nav = deps.nav ?? navigator;
  const caps = detectShareCapabilities(nav);

  if (caps.shareSheet) {
    // No `await` above this line. Deliberately.
    return nav
      .share(payload)
      .then<ShareOutcome>(() => ({ ok: true, tier: 'share-sheet' }))
      .catch((error: unknown): Promise<ShareOutcome> | ShareOutcome => {
        if (isAbort(error)) return { ok: false, tier: 'share-sheet', reason: 'cancelled' };
        // A share sheet that failed for any other reason — no targets, a
        // webview that lied about supporting it — should still get the link
        // out, so keep going down the tiers.
        return fallback(payload, caps, deps);
      });
  }

  return fallback(payload, caps, deps);
}

/** The invite, through the same ladder. Kept as its own name because it reads. */
export function shareInvite(invite: Invite, deps: ShareDeps = {}): Promise<ShareOutcome> {
  return shareLink(inviteShareData(invite), deps);
}

function fallback(
  payload: SharePayload,
  caps: ShareCapabilities,
  deps: ShareDeps,
): Promise<ShareOutcome> {
  if (caps.navigate) {
    try {
      (deps.navigate ?? defaultNavigate)(mailtoFor(payload));
      return Promise.resolve<ShareOutcome>({ ok: true, tier: 'mailto' });
    } catch {
      // A device with no mail client configured. Nothing is thrown on most
      // platforms — the navigation simply does nothing — so this is belt and
      // braces rather than the expected path.
    }
  }
  return copyLink(payload.url, deps);
}

/** The last tier that can still act: put the link on the clipboard. */
export function copyLink(url: string, deps: ShareDeps = {}): Promise<ShareOutcome> {
  const nav = deps.nav ?? navigator;
  if (typeof nav.clipboard?.writeText !== 'function') {
    return Promise.resolve<ShareOutcome>({ ok: false, tier: 'manual', reason: 'failed' });
  }
  return nav.clipboard
    .writeText(url)
    .then<ShareOutcome>(() => ({ ok: true, tier: 'clipboard' }))
    .catch<ShareOutcome>(() => ({ ok: false, tier: 'clipboard', reason: 'failed' }));
}

export function copyInvite(invite: Invite, deps: ShareDeps = {}): Promise<ShareOutcome> {
  return copyLink(invite.url, deps);
}

function defaultNavigate(href: string): void {
  location.href = href;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

// ---------------------------------------------------------------------------
// A game, as a file (stage 8.1, decision 0041)
// ---------------------------------------------------------------------------

/** The PGN, and the sentence that goes with it. */
export interface PgnShare {
  /** `satellite-chess-2026-09-23-riverside-park.pgn` — never the join code (O-34). */
  fileName: string;
  /** The file itself. Already a string: nothing may be awaited to get it. */
  text: string;
  title: string;
  /** One line for a share target that shows a message beside the attachment. */
  message: string;
}

/**
 * Send the game somewhere, as a file if the phone can manage it.
 *
 * The ladder is the invitation's with one rung added at the top and one taken
 * off the bottom (decision 0041):
 *
 * 1. **The share sheet with a `File`** — Web Share Level 2. This is the one
 *    that lands a `.pgn` in Files, Drive, or a chat as an attachment, which is
 *    what a player actually wants to do with a game.
 * 2. **The share sheet with text**, for a phone whose sheet refuses files. A
 *    PGN is short enough to survive being a message.
 * 3. **The clipboard**, so it can be pasted.
 * 4. Nothing worked, and the screen's own `<textarea>` and download link are
 *    still there.
 *
 * **No `mailto:` tier.** A whole file crammed into a mail body arrives as a
 * wall of text in somebody's inbox rather than as something a chess program can
 * open, and the tier above it already covers every phone with a mail client.
 *
 * As with {@link shareLink}, **call this straight from the click handler**:
 * every tier's decision is made by looking at `navigator`, and the `File` is
 * constructed synchronously, so `navigator.share` is reached with nothing
 * awaited in front of it. One `await` there and the browser has forgotten the
 * tap, and the call fails with no visible cause.
 */
export function sharePgn(pgn: PgnShare, deps: ShareDeps = {}): Promise<ShareOutcome> {
  const nav = deps.nav ?? navigator;
  const caps = detectShareCapabilities(nav);

  const file = caps.shareSheet ? pgnFile(pgn) : null;
  if (file !== null && nav.canShare?.({ files: [file] }) === true) {
    // No `await` above this line. Deliberately.
    return nav
      .share({ files: [file], title: pgn.title, text: pgn.message })
      .then<ShareOutcome>(() => ({ ok: true, tier: 'share-file' }))
      .catch((error: unknown): Promise<ShareOutcome> | ShareOutcome => {
        if (isAbort(error)) return { ok: false, tier: 'share-file', reason: 'cancelled' };
        return sharePgnAsText(pgn, caps, deps);
      });
  }
  return sharePgnAsText(pgn, caps, deps);
}

function sharePgnAsText(
  pgn: PgnShare,
  caps: ShareCapabilities,
  deps: ShareDeps,
): Promise<ShareOutcome> {
  const nav = deps.nav ?? navigator;
  if (caps.shareSheet) {
    return nav
      .share({ title: pgn.title, text: `${pgn.message}\n\n${pgn.text}` })
      .then<ShareOutcome>(() => ({ ok: true, tier: 'share-sheet' }))
      .catch((error: unknown): Promise<ShareOutcome> | ShareOutcome => {
        if (isAbort(error)) return { ok: false, tier: 'share-sheet', reason: 'cancelled' };
        return copyText(pgn.text, deps);
      });
  }
  return copyText(pgn.text, deps);
}

/**
 * The PGN as a `File`, or null where this browser has no `File` constructor.
 *
 * `application/x-chess-pgn` is what the route serves it as, and matching them
 * is what makes a shared file open in a chess program rather than a text
 * editor.
 */
function pgnFile(pgn: PgnShare): File | null {
  try {
    return new File([pgn.text], pgn.fileName, { type: 'application/x-chess-pgn' });
  } catch {
    return null;
  }
}

/** {@link copyLink}, for something that is not a link. */
export function copyText(text: string, deps: ShareDeps = {}): Promise<ShareOutcome> {
  const nav = deps.nav ?? navigator;
  if (typeof nav.clipboard?.writeText !== 'function') {
    return Promise.resolve<ShareOutcome>({ ok: false, tier: 'manual', reason: 'failed' });
  }
  return nav.clipboard
    .writeText(text)
    .then<ShareOutcome>(() => ({ ok: true, tier: 'clipboard' }))
    .catch<ShareOutcome>(() => ({ ok: false, tier: 'clipboard', reason: 'failed' }));
}
