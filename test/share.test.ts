import { describe, expect, it, vi } from 'vitest';

import {
  type Invite,
  copyInvite,
  copyLink,
  detectShareCapabilities,
  fieldShareData,
  inviteMailto,
  inviteShareData,
  mailtoFor,
  preferredTier,
  shareInvite,
  shareLink,
} from '../src/client/share.js';

/**
 * Decision 0015's fallback ladder, exercised without a browser.
 *
 * The two behaviours worth the most here are the ones that fail silently on a
 * real device: a cancelled share sheet must not cascade into opening a mail
 * client, and `navigator.share` must be reached with nothing awaited in front of
 * it or the browser discards the user gesture.
 */

const INVITE: Invite = {
  url: 'https://sat.example/j/ABC123',
  code: 'ABC123',
  fieldName: 'The park',
};

/** A `Navigator` with only the bits the module looks at. */
function nav(parts: {
  share?: (data: ShareData) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
}): Navigator {
  return {
    ...(parts.share ? { share: parts.share } : {}),
    ...(parts.writeText ? { clipboard: { writeText: parts.writeText } } : {}),
  } as unknown as Navigator;
}

function abort(): Error {
  const error = new Error('cancelled');
  error.name = 'AbortError';
  return error;
}

describe('the message', () => {
  it('names the field and groups the code the way it is read aloud', () => {
    const data = inviteShareData(INVITE);
    expect(data.text).toContain('The park');
    expect(data.text).toContain('ABC 123');
    expect(data.url).toBe(INVITE.url);
  });

  it('leaves the field out rather than saying "at undefined"', () => {
    expect(inviteShareData({ url: INVITE.url, code: 'ABC123' }).text).not.toContain('at ');
  });

  it('keeps the code recoverable from the link alone', () => {
    // Several share targets keep only one of `text` and `url`. A recipient left
    // with just the link can still read the code off the end of it — which is
    // why the code is in the path rather than a query parameter.
    expect(inviteShareData(INVITE).url.endsWith(INVITE.code)).toBe(true);
  });

  it('puts the link in a mailto body, encoded, with CRLF line breaks', () => {
    const href = inviteMailto(INVITE);
    expect(href.startsWith('mailto:?subject=')).toBe(true);
    expect(href).toContain(encodeURIComponent(INVITE.url));
    // A bare \n is dropped by some clients and the message arrives as one
    // run-on paragraph.
    expect(href).toContain(encodeURIComponent('\r\n'));
  });
});

describe('choosing a tier', () => {
  it('prefers the share sheet where there is one', () => {
    expect(preferredTier({ shareSheet: true, clipboard: true, navigate: true })).toBe(
      'share-sheet',
    );
  });

  it('falls to mailto on a desktop browser without one', () => {
    expect(preferredTier({ shareSheet: false, clipboard: true, navigate: true })).toBe('mailto');
  });

  it('detects the sheet from navigator rather than from a user-agent guess', () => {
    expect(detectShareCapabilities(nav({ share: async () => {} })).shareSheet).toBe(true);
    expect(detectShareCapabilities(nav({})).shareSheet).toBe(false);
  });
});

describe('shareInvite', () => {
  it('reaches navigator.share with nothing awaited in front of it', async () => {
    // The whole reason this is not an `async` function: `navigator.share` needs
    // the tap to still be live, and one await loses it with no visible cause.
    const share = vi.fn(async () => {});
    const promise = shareInvite(INVITE, { nav: nav({ share }) });
    expect(share).toHaveBeenCalledTimes(1);
    await expect(promise).resolves.toEqual({ ok: true, tier: 'share-sheet' });
  });

  it('hands the sheet the title, text and url', async () => {
    const share = vi.fn(async () => {});
    await shareInvite(INVITE, { nav: nav({ share }) });
    expect(share).toHaveBeenCalledWith(inviteShareData(INVITE));
  });

  it('treats a dismissed sheet as a decision, not a failure', async () => {
    // Falling through to a mail client here would pop one open at someone who
    // has just decided not to share.
    const navigate = vi.fn();
    const outcome = await shareInvite(INVITE, {
      nav: nav({ share: () => Promise.reject(abort()) }),
      navigate,
    });
    expect(outcome).toEqual({ ok: false, tier: 'share-sheet', reason: 'cancelled' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('falls through to mailto when the sheet genuinely fails', async () => {
    // A webview that exposes `share` and then rejects everything is real.
    const navigate = vi.fn();
    const outcome = await shareInvite(INVITE, {
      nav: nav({ share: () => Promise.reject(new Error('no targets')) }),
      navigate,
    });
    expect(outcome).toEqual({ ok: true, tier: 'mailto' });
    expect(navigate).toHaveBeenCalledWith(inviteMailto(INVITE));
  });

  it('uses mailto directly where there is no share sheet', async () => {
    const navigate = vi.fn();
    const outcome = await shareInvite(INVITE, { nav: nav({}), navigate });
    expect(outcome).toEqual({ ok: true, tier: 'mailto' });
    expect(navigate).toHaveBeenCalledOnce();
  });
});

describe('sharing a field (stage 6.4)', () => {
  const URL_ = 'https://sat.example/f/AQaFdQ__8Yr';

  it('names the place, because the link cannot be read', () => {
    // A join link ends in six characters a recipient can read and type. A field
    // link ends in a hundred characters of base64, so the sentence is the only
    // thing saying what is being offered.
    const data = fieldShareData('Hackney Marshes', URL_);
    expect(data.title).toContain('Hackney Marshes');
    expect(data.text).toContain('Hackney Marshes');
    expect(data.url).toBe(URL_);
  });

  it('goes down the same ladder as an invite', () => {
    const share = vi.fn(async () => {});
    const payload = fieldShareData('The common', URL_);
    const promise = shareLink(payload, { nav: nav({ share }) });
    // Synchronously, as ever: one await and the gesture is gone.
    expect(share).toHaveBeenCalledWith(payload);
    return expect(promise).resolves.toEqual({ ok: true, tier: 'share-sheet' });
  });

  it('falls to a mailto carrying the field\'s own subject line', async () => {
    const navigate = vi.fn();
    const payload = fieldShareData('The common', URL_);
    const outcome = await shareLink(payload, { nav: nav({}), navigate });
    expect(outcome).toEqual({ ok: true, tier: 'mailto' });
    expect(navigate).toHaveBeenCalledWith(mailtoFor(payload));
    expect(mailtoFor(payload)).toContain(encodeURIComponent('The common'));
  });

  it('copies the bare link, which is the whole field', async () => {
    const writeText = vi.fn(async () => {});
    expect(await copyLink(URL_, { nav: nav({ writeText }) })).toEqual({
      ok: true,
      tier: 'clipboard',
    });
    expect(writeText).toHaveBeenCalledWith(URL_);
  });
});

describe('copyInvite', () => {
  it('copies the link, not the message', async () => {
    // What gets pasted into a chat should be openable, and a sentence wrapped
    // around a URL is not reliably auto-linked.
    const writeText = vi.fn(async () => {});
    const outcome = await copyInvite(INVITE, { nav: nav({ writeText }) });
    expect(outcome).toEqual({ ok: true, tier: 'clipboard' });
    expect(writeText).toHaveBeenCalledWith(INVITE.url);
  });

  it('reports failure rather than throwing, so the screen survives it', async () => {
    // Clipboard writes are denied outright in a few embeddings, and the code
    // and QR on screen are still a working invite.
    expect(await copyInvite(INVITE, { nav: nav({}) })).toEqual({
      ok: false,
      tier: 'manual',
      reason: 'failed',
    });
    expect(
      await copyInvite(INVITE, { nav: nav({ writeText: () => Promise.reject(new Error('no')) }) }),
    ).toEqual({ ok: false, tier: 'clipboard', reason: 'failed' });
  });
});
