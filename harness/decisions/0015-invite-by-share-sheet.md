# 0015 — Invite through the OS share sheet, not server-sent email

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 6.1.4

## Decision

Invites are shared from the player's own device through the Web Share API
(`navigator.share`), which opens the real OS share sheet. Fallback tiers, in
order: `mailto:` link, then copy-to-clipboard. The QR code and the typed
six-character code remain, unchanged, alongside it.

The Worker sends no email in v1.

## Why

A generic share is strictly better than integrating any particular channel. One
code path covers Mail, Messages, WhatsApp, Signal, AirDrop and copy-link, because
the OS already knows which apps the player has and we do not have to care.

`navigator.share` is the same sheet native apps get. It requires a secure context
and a real user gesture — it must be called synchronously from the tap handler,
not after an `await`, which is the mistake that makes it fail silently. Support is
mobile-first: Safari on iOS and macOS, Chrome on Android. Desktop Firefox and
Chrome on Linux lack it, hence the fallback tiers. Since an invite matters most on
a phone standing next to a field, support is best exactly where it is needed.

Not sending mail from the Worker avoids a great deal for very little loss:

- No provider account, API key or secret to manage. MailChannels' free relay for
  Workers is gone, so this would mean adding Resend or similar.
- No SPF, DKIM or DMARC setup, and no deliverability debugging — an invite landing
  in spam is a failure mode with no client-side symptom.
- No abuse vector. A server that emails arbitrary addresses on request is a spam
  cannon; one that does not, cannot be.
- The invite arrives from the player's own address and reads as a personal note.

Secondary benefit, and the reason this interacts with decision 0014: inviting
ahead of time means the opponent signs in at home on wifi rather than in a field
on one bar. Mandatory accounts are considerably more comfortable when the invite
arrives the night before.

## Rejected

**Server-sent email via a transactional provider.** Nicer-looking, works when the
sender's mail client does not, and would let us send "your opponent moved"
notifications later. Deferred rather than dismissed: revisit when there is a
notification worth sending, at which point the provider earns its keep.

**Email-specific invite UI.** The owner's first framing, revised in conversation to
a generic share. Correctly — a bespoke email field would be more code for a subset
of what the share sheet already does.

## Revisit if

- Asynchronous notifications become a feature (rematch offers, move alerts). That
  needs a real sending path, and Web Push is likely the better answer than email.
- Telemetry shows the share sheet failing often enough to matter on the devices
  people actually use.
