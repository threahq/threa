---
title: Board
status: building
audience: public
since: 2026-06
surfaces: [board-page, sidebar, quick-switcher]
public_site: false
summary: >
  A cross-stream wall of your conversations ordered by recent activity, read-only
  and behind a feature flag, where each card links to its conversation opened in
  its own stream.
---

## What it does

The board is one page that lists conversations from every stream you can read, newest
activity first, as a single vertical column of cards. A conversation is Threa's topic
primitive (a grouped run of messages), so the board is a cross-stream view of topics
rather than of streams or messages. It is read-only: it shows conversations and links
into them, it does not let you act on them in place.

The list comes from a workspace-wide conversations endpoint that is access-filtered in
SQL using the same stream-access rule as the rest of the app (public roots without a
membership row, threads through their root, private streams only where you are a member),
so the board never surfaces a conversation you could not otherwise open. It is keyset
paginated by last activity, fetched fifty at a time, with a "Load more" button.

The whole feature is gated behind the `board-view` feature flag, which is off by default
and flipped on per user from the backoffice. The gate has three layers: the page redirects
to the workspace home when the flag is off, the sidebar and quick-switcher entries are
hidden, and the backend endpoint returns 404 without the flag.

## How a user experiences it

- **Reaching it.** When the flag is on, the board shows up as a "Board" quick link in the
  sidebar and a "View Board" command in the quick switcher, both pointing at
  `/w/<workspace>/board`.
- **A card.** Each card shows a small context line (the channel or DM the conversation
  lives in, or "Scratchpad"), the conversation's title (a scratchpad uses its own name, a
  channel or DM uses the conversation's topic, never the DM peer's name), a message count,
  a status badge, a completeness indicator, and a relative timestamp. Stale conversations
  dim, matching the in-stream list.
- **Opening one.** A card is a link. Clicking it navigates into the conversation's own
  stream with the conversation opened in an overlay (`?convView=open&conv=`). All the
  acting happens there, in the stream timeline, not on the board.
- **States.** The page has its own loading skeletons, an error state with a retry button,
  and an empty state.

## Boundaries

This is slice one. It is deliberately a read-only feed and not much more.

- **No columns, no kanban, no drag and drop.** It is a flat single column, not a board of
  movable cards despite the name.
- **No filtering or lenses yet.** There is a single "All" tab. A scope filter and lenses
  are planned as additional tabs but are not built.
- **No saved layout.** Ordering is fixed to recent activity, decided by the server. There
  is no per-user board arrangement to store, and no board-specific table backs it: it
  reads existing conversation data.
- **No live updates.** The board has no socket subscription, so new conversation activity
  does not stream in. It refetches on mount and on reconnect.
- **No in-place editing.** Cards link out; nothing on the board mutates a conversation.
