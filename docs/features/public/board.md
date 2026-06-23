---
title: Board
status: building
audience: public
since: 2026-06
surfaces: [board-page, sidebar, quick-switcher]
public_site: false
summary: >
  A cross-stream feed of your conversations ordered by recent activity, read-only
  and behind a feature flag: every active topic across the streams you can read,
  gathered into one re-organized timeline.
---

## What it does

The board is one page that gathers conversations from every stream you can read into a
single feed, newest activity first. A conversation is Threa's topic primitive (a grouped run
of messages), so the board is a re-organized timeline: instead of one stream at a time, it is
every active topic in one place. It is read-only today: it shows conversations and links into
them, it does not let you act on them in place.

The list comes from a workspace-wide conversations endpoint that is access-filtered in SQL
using the same stream-access rule as the rest of the app (public roots without a membership
row, threads through their root, private streams only where you are a member), so the board
never surfaces a conversation you could not otherwise open. It is keyset paginated by last
activity, fetched fifty at a time, with a "Load more" button.

The whole feature is gated behind the `board-view` feature flag, which is off by default and
flipped on per user from the backoffice. The gate has three layers: the page redirects to the
workspace home when the flag is off, the sidebar and quick-switcher entries are hidden, and
the backend endpoint returns 404 without the flag.

## How a user experiences it

- **Reaching it.** When the flag is on, the board shows up as a "Board" quick link in the
  sidebar and a "View Board" command in the quick switcher, both pointing at
  `/w/<workspace>/board`.
- **A card.** Each card summarizes one conversation: the stream it lives in (a channel name,
  a DM peer, or "Scratchpad"), the conversation's title (a scratchpad uses its own name, a
  channel or DM uses the conversation's topic, never the DM peer's name), and a relative
  timestamp. Stale conversations dim, matching the in-stream list.
- **Opening one.** A card is a link. Clicking it navigates into the conversation's own stream
  with the conversation opened in an overlay (`?convView=open&conv=`). All the acting happens
  there, in the stream timeline, not on the board.
- **States.** The page has its own loading skeletons, an error state with a retry button, and
  an empty state.

## Status

This is slice one: a read-only feed, and deliberately not much more yet.

- **Read-only.** You cannot post from the board; cards link out and nothing on the board
  mutates a conversation. Composing into the board to seed a conversation is a planned
  follow-up, not built.
- **The card chrome is being reworked.** Today each card is a compact conversation summary
  borrowed from the in-stream conversation list. The intended direction (in flight, not yet on
  the main branch) is a feed of message-led posts: the conversation's opening message rendered
  as a post with author, body and reactions, grouped into recency sections, with the topic
  demoted to a subject line. Treat the current compact card as the slice-one placeholder, not
  the settled design.
- **No live cross-stream updates.** Conversation events are delivered only to per-stream rooms,
  so the board refetches when you open it rather than updating live. It does not yet ride the
  sync engine the message timeline uses, so activity from elsewhere appears on refresh, not
  instantly. This is a known limitation with a design to move the board onto the sync engine.
- **No columns, no kanban, no drag and drop.** It is a flat single column, not a board of
  movable cards despite the name.
- **No filtering or lenses yet.** There is a single "All" tab. A scope filter and lenses are
  planned as additional tabs but are not built.
- **No saved layout.** Ordering is fixed to recent activity, decided by the server. There is no
  per-user board arrangement to store, and no board-specific table backs it: it reads existing
  conversation data.
