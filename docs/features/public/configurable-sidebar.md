---
title: Configurable Sidebar
status: shipped
audience: public
since: 2026-05
surfaces: [sidebar, labels-page, stream-topbar]
public_site: true
summary: >
  Arrange your stream sidebar into reorderable sections — smart buckets, stream
  types, or labels — and start from a Smart or All preset.
related: [architecture/subscribe-then-bootstrap.md]
---

## What it does

The sidebar is built from an ordered list of **sections**, configured per user and per
workspace. Each section is an independent filter that draws streams from your workspace,
and you control which sections appear and in what order.

Three kinds of section exist:

- **Smart buckets** — `important`, `recent`, `pinned`, and `other` ("Everything Else").
  Recent shows your most active streams (capped, with unread overflow); important is a
  capped priority bucket; pinned shows everything you've pinned.
- **Stream types** — `scratchpads`, `channels`, and `dms`, each listing streams of that
  type by activity.
- **Labels** — any label you've added to the sidebar becomes its own section, listing
  the streams carrying that label. The section header renders as the label's chip
  (emoji or color dot + tinted name).

Two presets seed the configuration:

- **Smart** = important, recent, pinned, other. New users start here.
- **All** = scratchpads, channels, dms.

You can switch presets at any time, which re-seeds the section list.

Alongside sections, the sidebar carries **quick links** (drafts, saved, files,
scheduled, memory, labels, activity). These are reorderable and individually hideable.

## How a user experiences it

- **Customize dialog** — a "Customize sidebar" editor lets you drag to reorder sections,
  add sections (pick a smart bucket, a stream type, or any label), remove sections, and
  pick a preset. The same dialog reorders and toggles quick links. Every change saves
  immediately and syncs across your devices.
- **Inline label toggle** — the Labels page has a "Show in sidebar" toggle per label, so
  you can surface a label as a section without opening the editor.
- **Stream top bar** — a stream's labels appear as a compact stack: up to three marks
  plus a `+N` count. On desktop, hovering fans the stack out into full label chips; on
  mobile, tapping opens a drawer. The stack stays live as labels are added or removed.

Your configuration lives server-side (per user, per workspace) and arrives with your
workspace bootstrap, so it's consistent everywhere you log in.

## Boundaries

- **Label sections are additive, not deduplicating.** A stream can appear both in a
  label section and in a smart/type section. There is no per-section
  "hide if shown above" toggle today; smart and type buckets don't overlap by
  construction, so dedup isn't needed yet.
- **No standalone "remainder" section kind.** "Everything Else" is the `other` smart
  bucket, not a separate configurable remainder.
- **The top-bar label stack is display-only.** Adding or removing a label still happens
  through the label picker, not the stack.

## Related

- [`architecture/subscribe-then-bootstrap.md`](../architecture/subscribe-then-bootstrap.md)
  — how the sidebar's live stream data and previews stay current.
