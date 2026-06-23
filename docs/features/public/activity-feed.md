---
title: Activity Feed
status: shipped
audience: public
since: 2026-05
surfaces: [activity-page, sidebar]
public_site: true
summary: >
  A per-user feed of the things that involve you (mentions, replies in streams you
  follow, reactions to your messages, reminders, being added to a stream), with
  All, Unread, and Me views and unread counts derived straight from the feed's own
  rows.
related: [public/saved-messages.md, concepts/content-canonical-form.md]
---

## What it does

The activity feed is your personal notification list. Each item is one row tied to you and a
single event, produced on the backend as those events happen and delivered live. There are a
few kinds:

- **Mention:** someone @-mentioned you, or an @channel/@here that resolves to you.
- **Message:** a new message in a stream you follow at a notifying level.
- **Reaction:** someone reacted to one of your messages (the author is notified).
- **Saved reminder:** a reminder you set on a saved item came due.
- **Member added:** you were added to a stream.

Each row carries a small snapshot of context (a content preview, the author, the stream) so
the feed renders without fetching the underlying messages. Your own actions are recorded too,
inserted already-read, so they show up in the Me view without inflating your unread count.

The unread counts you see (the sidebar badge, the per-stream mention counts) are not a number
maintained on the side; they are derived on the fly from the actual unread rows the feed
holds. Because the count is a projection of the rows the feed can show, a phantom badge with
nothing behind it is structurally impossible.

## How a user experiences it

### Views

Three views, each its own URL so a refresh or a shared link lands you on the same one:

- **All** (`/activity`): everything except your own actions.
- **Unread** (`/activity/unread`): just the unread.
- **Me** (`/activity/me`): your own actions.

The tabs are links, so cmd-click and middle-click open them the way you would expect.

### Reading

Clicking a row marks it read. A "Mark all read" button in the header appears when you have
unread activity. Opening a stream and reading it also clears that stream's activity, so you
are not marking the same thing read twice.

### Layout

The feed leans on the triggering message: the content preview carries the visual weight on
its own line, and the actor, verb and stream collapse into a single muted caption ("Alex
mentioned you in #design") that truncates rather than wraps. The timestamp sits at the right
edge with the unread marker beside it; a read row reserves that space so toggling read and
unread shifts nothing. Avatars are sized per type (a persona, a bot, a system reminder each
read differently). It is a flat list ordered newest first, not grouped by day.

### How items get there

Activity is produced on the backend from the outbox: as messages, reactions, reminders and
member-adds commit, a handler writes the matching rows and republishes them so connected
clients update live. The feed query is seeded from your workspace bootstrap and then kept
current by those live events, deduplicated by id so a replay updates a row in place instead
of doubling it.

## Boundaries

- **Encrypted streams are not in the feed.** Mentions, reactions, reminders and member-adds
  in an end-to-end encrypted stream are deliberately skipped, so the activity feed is not the
  unread surface for encrypted DMs.
- **A removed reaction has no live correction.** Removing a reaction does not push a
  compensating event; a stale row is reconciled on the next fetch (the local held set drops it
  immediately).
- **Marking a stream unread does not restore its feed rows.** Re-surfacing an unread divider
  in a stream does not bring its activity rows back into the feed; that is a known follow-up.
- **No infinite scroll.** The page fetches a fixed recent window; the backend supports paging,
  but the page does not load older activity past that window yet.

## Related

- [Saved messages](saved-messages.md): saved-reminder activity comes from a reminder firing.
- [Content canonical form](../concepts/content-canonical-form.md): the content preview strips
  markdown before rendering, so syntax never reaches you as characters.
