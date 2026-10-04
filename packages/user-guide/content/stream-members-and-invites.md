---
title: Adding people and bots to a stream
summary: Add people from the Members tab or with /invite, and add bots if you can manage them.
section: conversations
order: 5
---

# Adding people and bots to a stream

Channels and threads can have people added to them. Scratchpads, DMs and asides can't. Bots can also be added to scratchpads and DMs (see Bots below).

## The Members tab

Open **Settings** on a stream and go to **Members**. The tab lists everyone in the stream with their @handle and role (member, admin or owner), and a filter box.

Two actions in this tab need the member-management permission, which workspace admins and owners have:

- **Add member**: a searchable list of workspace users who aren't in the channel yet. It appears on channels.
- Removing someone: the X on their row, then confirm "Remove member?". Your own row has no X.

Without that permission, the people list is read-only.

## /invite

In a channel, or a thread whose root is a channel, type:

```
/invite @user1 @user2
```

You can name people and bots. The command appears in the timeline as a chip that shows the command, then "completed" or "failed:" with the reason. It fails when none of the names match a user or bot, or when nobody could be added. If only some names match, those are added and the command completes. If it fails, the chip offers **Put back in composer** and **Remove failed command**. Adding someone to a thread also adds them to the channel it belongs to.

`/invite` only works in channels and threads under channels. Elsewhere it reports "/invite is only available in channels and threads whose root is a channel". Inviting people with `/invite` doesn't check the member-management permission. Inviting bots needs the permission to manage bots, which admins and owners have. Without it you get "Insufficient permissions to invite bots".

## Bots

The **Bots** section of the Members tab shows to people who can manage members. It lists the bots with access, an **Add bot...** picker and an X to remove one. Threads show it read-only, because they inherit bot access from their root. If the workspace has no bots, create one in workspace settings. See [Bots overview](/guide/bots-overview).

Adding a bot gives it access to that stream. On an encrypted scratchpad, adding a bot asks you to confirm, because the bot can then read every message in it. Removing one also asks. While the scratchpad is locked, adding a bot is disabled until you unlock it.

## Joining on your own

You don't need an invitation to join a public channel. See [Channels](/guide/channels).
