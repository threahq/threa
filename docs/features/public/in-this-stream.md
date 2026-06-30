---
title: In This Stream
status: shipped
audience: public
since: 2026-06
surfaces: [stream-header, stream-context-panel]
public_site: false
summary: >
  A panel that collects the links, files, images, captured memories, and threads
  from a conversation into one recency-ordered timeline, each item linking back to
  where it came from.
related: [public/link-previews.md]
---

## What it does

"In this stream" is an overview of the things _around_ a conversation, as opposed to
the messages themselves. It reads the messages already loaded in the open stream and
pulls out five kinds of context:

- **Links.** External URLs, gathered from the message link-preview cards plus any other
  URLs in the text. Those are read from the message's rich-text nodes (the `link` mark's
  target and plain-text URLs), not by parsing serialized markdown, so a bold or
  italicized link keeps a clean URL. The same URL across several messages collapses to one
  row with a `2×` count. A GitHub or Linear link carries a small `PR` / `Issue` badge
  when the integration produced a rich preview for it.
- **Media.** Images, GIFs, and videos. This covers uploaded image/video attachments and
  inline Giphy GIFs — the GIFs are read from the message's `giphyEmbed` nodes, the same
  structured-document source as links — each shown as a thumbnail (a play overlay for
  video, a `GIF` tag for animated ones).
- **Files.** Every other attachment, bucketed by kind (pdf, doc, sheet, slide, code,
  archive, audio, other) with a category icon.
- **Memories.** Memos that the memory system captured from this stream's conversations,
  with their knowledge-type icon.
- **Threads.** Threads that branched off the stream, ordered by their most recent reply.

Nothing here is stored separately. The whole panel is derived live from the stream's
loaded timeline events, so it has no backend of its own and updates as new messages
arrive. The derivation is a pure function (`deriveStreamContext`) covered by unit tests.

## How a user experiences it

A panel icon in the stream header (next to Search) opens it. The same content renders two
ways: a slide-out panel from the right on desktop, and a bottom drawer on mobile.

Inside, items run top to bottom as a **timeline**, newest first. A thin spine runs down
the left with each item hanging off it as a node (its thumbnail or icon), and the rows are
grouped under date markers (Today, Yesterday, then the weekday or date) computed in your
local time. A row of filter chips at the top scopes the list to one category; only
categories that actually have something show up, with a count on each.

Every row links back to where it came from:

- A **link** opens the URL in a new tab. A small jump control on the row goes to the
  message the link was posted in instead.
- A **media** or **file** row jumps to its source message.
- A **memory** opens in the memory explorer.
- A **thread** opens in the thread panel.

Jumping to a message scrolls the timeline to it and closes the panel so the message is
visible. The panel's open state and the selected filter both live in the URL
(`?context=<filter>`), so a refresh or a shared link reopens it on the same view.

## Boundaries

- **It covers the loaded window, not the full history.** The panel only sees the timeline
  events currently loaded for the stream, which is a recent slice rather than everything
  ever posted. A server-backed "all attachments / links in this stream" view would be a
  separate feature; the per-stream files explorer already does this for attachments.
- **It is read-only and frontend-only.** There is no way to add or pin an item here, and
  nothing new is written or synced. It is a view over data the stream already holds.
- **Rich GitHub / Linear treatment depends on the integration.** Without a connected
  GitHub or Linear integration, those links still appear, but as plain link rows (favicon
  or globe, the page title) with no `PR` / `Issue` badge. The badge only shows when the
  link-preview pipeline returned a rich `github_*` / `linear_*` preview.
- **Encrypted scratchpads show little.** In an end-to-end-encrypted stream the message
  content stays sealed on the client side of this derivation, so the panel is sparse
  rather than populated.
- **The toggle is hidden on drafts and inside a thread.** A draft scratchpad has no
  persisted timeline to read yet, and a thread is itself a panel surface.
