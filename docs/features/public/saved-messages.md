---
title: Saved Messages
status: shipped
audience: public
since: 2026-04
surfaces: [timeline, message-context-menu, saved-page, sidebar, activity-feed]
public_site: true
summary: >
  Save any message — or jot a standalone to-do — into a per-user list with a
  saved/done/archived lifecycle, an optional context note, and optional
  reminders that resurface the item in your activity feed.
---

## What it does

A saved item is a per-user, per-workspace to-do. Most start life as a pointer to a
message: which message, what state it is in (saved, done, or archived), and an
optional reminder time. Each user can save a given message once. Saving never copies
the message; the saved list resolves each pointer against the live message when you
look at it, so an edited message shows its current content and a deleted one shows
"Original message was deleted" instead of a stale snapshot.

An item can also be standalone — typed directly into the Saved page with its own
title and no source message. Both kinds carry an optional free-text **note** for the
context the message alone doesn't capture ("why I saved this"), editable from the
row at any time.

The three states form a small lifecycle. A new save lands in **Saved**. From there
you can mark it **Done** or **Archive** it, and either of those can be restored back
to Saved. Re-saving a message that you'd already marked done or archived also moves
it back to Saved, with a fresh save time.

A reminder is a time attached to a saved row. When it comes due, a background job
fires it exactly once: the row is marked as reminded, and an entry appears in your
activity feed linking back to the saved message. The Saved quick link in the sidebar
shows a count of reminders that have fired and are still sitting in Saved, so a
fired reminder stays visible until you act on the item. Marking an item done or
archived cancels any pending reminder.

## How a user experiences it

- **Saving.** A bookmark button appears when hovering a message. Clicking the button
  saves or unsaves it; hovering over the button itself opens a popover with reminder
  options and status actions. The message context menu has the same actions: save,
  unsave, and set reminder.
- **The saved page.** Three tabs: Saved, Done, and Archived, each its own URL
  (`/saved`, `/saved/done`, `/saved/archived`), so refresh, back/forward, and shared
  links land on the same tab. Saved is ordered by when you saved; Done and Archived
  by when the item moved there. Each row carries actions to edit its note (and
  title, for standalone items), set a reminder, mark done, archive, restore, or
  delete.
- **Quick add.** An input at the top of the Saved tab creates a standalone to-do
  from a single line of text. Notes and reminders are added afterwards from the
  row. Standalone rows show their own title where message rows show the source
  stream and a live preview; a fired reminder for one links to the Saved page
  rather than to a message.
- **Reminders.** Presets for in 15 minutes, 1 hour, and 3 hours; "Tomorrow morning"
  and "Next week" computed from your work schedule; and a custom date/time picker in
  your device's timezone. A time in the past fires immediately. A fired reminder
  shows a "reminded" badge on the saved row.
- **Sync.** Saves, status changes, and fired reminders propagate live to your other
  devices, and the saved list works offline from the local cache.
- **When the message goes away.** A saved message from a private stream or thread
  you can no longer access shows "You no longer have access to this message"; one
  from an end-to-end encrypted scratchpad shows an encrypted-message placeholder.
  The saved entry itself stays yours to restore, re-file, or delete.

## Boundaries

- A fired reminder produces an activity entry and the sidebar count, not a push
  notification to your device.
- There is no snooze. After a reminder fires, set a new one if you want another
  nudge.
- A save carries no label, the saved tabs have no search or filter, and there are
  no bulk actions; every state change is per item. Notes are plain text — no
  mentions, formatting, or attachments.
- Each tab loads one page of fifty items; there is no infinite scroll yet, so very
  long lists only show the most recent page.
- Deleting a saved entry is permanent for the entry (the underlying message is
  untouched), and saves are scoped to one workspace.
