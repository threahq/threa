---
title: Scratchpads
status: shipped
audience: public
since: 2026-05
surfaces: [sidebar, quick-switcher, stream-header, timeline]
public_site: true
summary: >
  A scratchpad is a private stream you own by yourself, created from the New menu
  and named automatically from its first messages. It is the solo-first way into
  Threa.
related: [public/ai-companions.md, public/e2e-encrypted-scratchpads.md]
---

## What it does

A scratchpad is a stream with `type: "scratchpad"`. It is always private, owned by
the person who created it, and starts with that person as its only member. Streams
come in a fixed set of types (scratchpad, channel, dm, thread, system); a
scratchpad is the personal one. Where a channel is a shared space addressed by a
slug, a scratchpad is yours, addressed by a name, and nobody else is in it.

This is the solo-first entry point. You don't need a team or a channel to start;
you make a scratchpad, write into it, and it becomes a place your notes and (if you
want it) the AI companion live.

A "quick note" is the same thing with the companion turned off. Both "New
Scratchpad" and "New Quick Note" create a `scratchpad` stream; the only difference
is the companion mode they start with: New Scratchpad starts with the companion on,
New Quick Note starts with it off. The companion toggle itself is described in
[ai-companions](ai-companions.md); here it's just the dial each creation path sets.

## How you use it

- **Creating one.** The sidebar's New menu and the quick switcher both offer "New
  Scratchpad" (companion on) and "New Quick Note" (companion off), plus the
  encrypted variants. A new scratchpad opens immediately as a local draft: it lives
  only in your browser until you send the first message, and only then is it saved
  on the server as a real stream carrying the companion mode you chose. An empty
  draft you never write into never reaches the server, and you can discard it.
- **Auto-naming.** A scratchpad you didn't name shows as "New scratchpad" at first.
  Once messages arrive, Threa generates a short two-to-five word title from the
  conversation and the name updates live in the sidebar. A message from you asks for
  a name but the model may decide there isn't enough to go on yet and wait for more;
  a reply from the companion forces a name, so a scratchpad that's had a real
  exchange doesn't sit there nameless. Naming only ever fills in a blank: if you
  named the scratchpad yourself, auto-naming leaves it alone.
- **Renaming.** You can set a name when you create it or rename it any time after.
  A manual name stops auto-naming from touching it.
- **Archiving.** Archive a scratchpad to take it out of the sidebar; it's a soft
  hide, not a delete, and you can bring it back. Unsent drafts are discarded
  locally rather than archived.
- **Threads.** A thread you open under a scratchpad inherits the scratchpad's
  companion mode and stays private the same way the scratchpad is.

## Boundaries

- **Scratchpads are solo.** There is no sharing. The add-member API rejects
  scratchpads, and their visibility is fixed to private and can't be changed, so a
  scratchpad stays a space of one. Sharing a scratchpad with someone else is not
  built.
- **No conversion between types.** A scratchpad doesn't turn into a channel (or the
  reverse). Each stream is its type for life.
- **Nothing is created for you.** Signing up does not seed a starter scratchpad;
  you make your first one from the New menu.
- **Encrypted scratchpads aren't auto-named yet.** Server-side auto-naming reads
  message content, which is ciphertext on an end-to-end encrypted scratchpad, so
  naming is skipped there. The intent is for the client to name them locally from
  the decrypted text, but that isn't built, so an encrypted scratchpad keeps "New
  scratchpad" until you rename it. The rest of the encrypted behavior lives in
  [e2e-encrypted-scratchpads](e2e-encrypted-scratchpads.md).

## Related

- [AI Companions](ai-companions.md) covers the companion mode a scratchpad turns on
  or off, and what Ariadne does when it's on.
- [End-to-End Encrypted Scratchpads](e2e-encrypted-scratchpads.md) covers the
  encrypted variant: passphrase unlock, the sealed companion, and what changes.
