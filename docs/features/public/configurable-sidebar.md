---
title: Configurable Sidebar
status: building
audience: public
surfaces: [sidebar, labels-page, stream-topbar]
public_site: false
summary: >
  Arrange your stream sidebar into reorderable sections (smart buckets, stream types,
  labels, or an Unread tray) and start from a Smart or All preset.
related: [concepts/subscribe-then-bootstrap.md]
---

## What it does

Your sidebar is an ordered list of sections, saved per workspace. Each section is its own
filter over your streams, and you pick which sections show and in what order.

There are four kinds of section:

- **Smart buckets.** Important, Recent, and Everything Else. Recent shows your active
  streams, with anything unread always surfaced. Important collects mentions and unread AI
  activity. (A Pinned bucket is part of the layout but isn't wired up yet; see Status.)
- **Stream types.** Scratchpads, Channels, and DMs, each listing that type by recent
  activity.
- **Labels.** Add a label to the sidebar and it becomes its own section listing the
  streams that carry it. The section header shows the label's chip: its emoji or color dot
  and name.
- **Unread.** An optional tray that gathers everything unread into one place. Opt-in — add
  it from the customize dialog. See "The Unread tray" below.

Two presets give you a starting point:

- **Smart:** Important, Recent, Pinned, Everything Else. New users start here.
- **All:** Scratchpads, Channels, DMs.

Switching presets reseeds the section list.

The sidebar also has quick links (drafts, saved, files, scheduled, memory, labels,
activity). You can reorder them and hide the ones you don't use.

## The Unread tray

Add the Unread section and it collects every stream with unread messages into one place,
so you're not hunting for them across buckets. Muted streams stay out.

While a stream is in the tray it shows there **only** — it's pulled out of its smart bucket
and out of any label or section it normally lives under, with a small "· home" note on the
row so you can still see where it lives, rather than appearing twice.

The tray is sticky for the session. Once a stream lands in it, it stays — de-emphasized —
even after you've read it, so working through your unreads doesn't reshuffle the sidebar
underneath you. It resets when you leave the workspace, or you can hit **Clear read** to
send the ones you've already read back to their home sections. The section stays put even
when there's nothing in it, showing a quiet _All caught up_ instead of disappearing.

## How you use it

- **Customize dialog.** Drag to reorder sections, add a section (a smart bucket, a stream
  type, a label, or the Unread tray), remove sections, or switch preset. The same dialog
  reorders and hides quick links. Changes save right away and sync across your devices.
- **Labels page.** Each label has a "Show in sidebar" toggle, so you can add one as a
  section without opening the editor.
- **Stream top bar.** A stream's labels show as a small stack: up to three marks plus a
  "+N" count. Hover on desktop to fan them out into full chips; tap on mobile to open a
  drawer. It stays live as labels are added or removed.

Your layout is stored per user, per workspace, and arrives with your workspace bootstrap,
so it's the same wherever you log in.

## Status

Still in progress, which is why it isn't on the marketing site yet.

- **Pinning isn't implemented.** The Pinned bucket renders but stays empty: nothing sets a
  stream's pinned state, because the backend doesn't store one yet. The Smart preset still
  lists Pinned so it slots into place once pinning lands.
- **Label sections are additive.** A labeled stream shows in its label section and still
  appears in its smart or type bucket. There's no per-section "hide if already shown above"
  option; smart and type buckets don't overlap, so it hasn't been needed. The Unread tray
  is the one exception — it relocates its streams rather than duplicating them.
- **"Everything Else" is a smart bucket**, not a separate configurable section.
- **The Unread tray is opt-in and session-scoped.** It's in neither preset — you add it
  from the customize dialog. Its membership lives for the session and resets on reload or
  workspace switch; it isn't saved.
- **The top-bar label stack is display-only.** You add and remove labels from the label
  picker, not from the stack.

## Related

- [Subscribe-then-bootstrap](../concepts/subscribe-then-bootstrap.md) covers how the
  sidebar's live stream data stays current.
