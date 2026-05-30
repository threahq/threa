---
title: Configurable Sidebar
status: building
audience: public
surfaces: [sidebar, labels-page, stream-topbar]
public_site: false
summary: >
  Arrange your stream sidebar into reorderable sections (smart buckets, stream types, or
  labels) and start from a Smart or All preset.
related: [concepts/subscribe-then-bootstrap.md]
---

## What it does

Your sidebar is an ordered list of sections, saved per workspace. Each section is its own
filter over your streams, and you pick which sections show and in what order.

There are three kinds of section:

- **Smart buckets.** Important, Recent, and Everything Else. Recent shows your active
  streams, with anything unread always surfaced. Important collects mentions and unread AI
  activity. (A Pinned bucket is part of the layout but isn't wired up yet; see Status.)
- **Stream types.** Scratchpads, Channels, and DMs, each listing that type by recent
  activity.
- **Labels.** Add a label to the sidebar and it becomes its own section listing the
  streams that carry it. The section header shows the label's chip: its emoji or color dot
  and name.

Two presets give you a starting point:

- **Smart:** Important, Recent, Pinned, Everything Else. New users start here.
- **All:** Scratchpads, Channels, DMs.

Switching presets reseeds the section list.

The sidebar also has quick links (drafts, saved, files, scheduled, memory, labels,
activity). You can reorder them and hide the ones you don't use.

## How you use it

- **Customize dialog.** Drag to reorder sections, add a section (a smart bucket, a stream
  type, or a label), remove sections, or switch preset. The same dialog reorders and hides
  quick links. Changes save right away and sync across your devices.
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
  option; smart and type buckets don't overlap, so it hasn't been needed.
- **"Everything Else" is a smart bucket**, not a separate configurable section.
- **The top-bar label stack is display-only.** You add and remove labels from the label
  picker, not from the stack.

## Related

- [Subscribe-then-bootstrap](../concepts/subscribe-then-bootstrap.md) covers how the
  sidebar's live stream data stays current.
