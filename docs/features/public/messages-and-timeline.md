---
title: Messages and Timeline
status: shipped
audience: public
since: 2026-04
surfaces: [timeline, message-context-menu, message-action-drawer, unread-divider, day-divider]
public_site: true
summary: >
  The stream timeline and what you can do with a message in it: edit, delete and
  revision history, a context menu and mobile action drawer, system rows, an
  unread divider and read-state controls, and in-stream day dividers with
  jump-to-date.
related: [public/saved-messages.md, concepts/content-canonical-form.md]
---

## What it does

A stream's timeline is an ordered list of events. Most rows are messages; the rest are
system rows (someone joined, the description changed, a thread was created, a stream was
archived). The timeline also draws two kinds of in-list marker: an unread divider where
your reading left off, and a day divider between calendar days.

Each message offers a set of actions, and the same set drives both the desktop context menu
and the mobile action drawer, so there is one source of truth for what you can do and when.
Visibility is per-action: editing and deleting show only on your own messages, "see
revisions" shows only on edited messages, and so on. Actions that navigate render as links;
actions that change something render as buttons.

Read state is its own layer on top of the timeline. A divider marks the boundary between
read and unread, the boundary holds still while you read, and a few controls let you move it
deliberately (mark read up to a point, mark something unread, or clear the lot).

## How a user experiences it

### Acting on a message

- **Desktop:** an ellipsis on the row opens a context menu. Related actions collapse into
  split-buttons (reply or quote-reply, share to root or parent, and so on).
- **Mobile:** a long-press opens an action drawer with a preview of the message, a row of
  quick emoji reactions, and an expandable "highlight a passage to quote" view.

The actions include: edit, see revisions, reply in thread, quote reply, share, save for
later and set a reminder, discuss with Ariadne, move to a thread or conversation, mark read
up to here, mark as unread, copy as markdown or plain text, copy a link, and delete.

### Editing, history, and deleting

An edited message carries a small "(edited)" indicator; clicking it opens the revision
history. Editing reuses the rich editor. If a save cannot reach the server it is queued
offline and you are told it will be saved when you are back online. Deleting asks for
confirmation and then leaves a "This message was deleted" tombstone in place rather than
removing the row.

### System rows

Joins, adds and leaves render as a centered muted line ("joined the conversation"), as do
thread-created and archive/unarchive. A description change renders as its own
"set the description" row. These rows are display-only.

### The unread divider and reading

A stream opens at the bottom, on the newest messages. If you have unread messages above the
fold, a "N new messages" bar appears; clicking it jumps you to the first unread message and
lands the divider near the top. Next to it is an ✕ that marks everything read and drops you
back at the bottom (on mobile, where there is no keyboard, the ✕ is the way to clear unread;
on desktop, Escape does the same).

The divider holds its position for the whole reading session. As you read down and messages
auto-mark as read, the line does not creep forward or vanish under you, so working through
your unread does not reshuffle the timeline. Reading is progressive and contiguous: the read
frontier only advances while your viewport is continuous with it, so jumping straight to the
bottom leaves the messages you skipped still marked unread. Marking a message unread pulls
the divider back up to it.

### Read-state controls

From a message you can "mark read up to here" or "mark as unread". The row only signals the
intent; the stream decides whether that is a partial read (up to that message) or a full read
(up to the last loaded message) and makes the matching call. Auto-read happens as you view: a
debounced mark-as-read fires while the page is visible and focused (relaxed to visible-only on
touch devices), sending a partial read when you are not at the very bottom.

### Day dividers and jump-to-date

The timeline inserts a day divider before the first message of each local calendar day
(labelled Today, Yesterday, or the date). A floating date pill at the top shows the day you
are looking at; clicking it opens quick presets and a calendar to jump to a specific date,
loading that window and scrolling to the right place.

## Boundaries

- **Editing is hidden on encrypted streams.** There is no sealed-edit path, so the edit
  action does not appear in an end-to-end encrypted scratchpad.
- **A moved message shows no destination row.** When a message is moved into a thread or
  conversation, the destination side renders nothing in the timeline; you discover the move
  through the per-message "Show move details" action on the source side.
- **Membership rows are hidden inside threads.** Join, add and leave rows render in the root
  stream, not in thread views.
- **A partial mark-read does not instantly zero the badge.** The optimistic update clears
  the unread rows it can, but the true remaining count lands on the server round-trip, because
  the read position can move forward but not be reconstructed locally.
- **Dividers and system rows are display-only.** The unread divider, day dividers, and
  membership and system rows carry no actions of their own.

## Related

- [Saved messages](saved-messages.md): the save-for-later and reminder actions in the menu.
- [Content canonical form](../concepts/content-canonical-form.md): why message bodies are
  authored and stored as `contentJson` and serialized to markdown only at the wire.
