---
title: Moving messages between streams
summary: How to move one or more messages into a thread under an earlier message, and how moved messages are marked.
section: messages
order: 10
---

# Moving messages between streams

When a side discussion starts in the middle of a stream, you can move those messages into a thread under an earlier message. The moved messages leave the stream and appear in the thread, and a note in the stream shows where they went.

## Move messages to a thread

There are two ways to start:

- Open a message's menu and choose **Move to thread…**. That message is selected for you.
- Open the stream's menu and choose **Move messages…** to start with nothing selected.

A bar appears at the top of the stream with a count of selected messages. Select the messages you want to move, then drag the selection onto the message that should become the thread's starting point. The hint in the bar reads "Tap messages to select" and then "Drag onto a message above to move". **Cancel selection** leaves the mode without moving anything.

Threa shows **Verifying…** while it checks the move, then asks "Move N selected messages into this thread?" under the title **Move messages?**. Click **Move** to go ahead. This cannot be undone.

Some limits:

- The target must come before every message you selected.
- You must be a member of the stream.
- You can't move messages out of an archived stream or into an archived thread.
- **Move to thread…** is not offered on the parent message at the top of a thread, and archived and system streams don't offer **Move messages…**.

If the target message already has a thread, the messages go into it. Otherwise Threa creates the thread. See [Threads](/guide/threads).

## What moved messages look like

In the stream they came from, a line reads "<name> moved N messages". Click it to open a drawer listing the moved messages, with links to the source and the destination.

In the thread, each moved message shows a small arrow icon. Hover it to see who moved the message, from which stream and when. Click the icon, or choose **Show move details** from the message's menu, to open the same drawer.

## Move messages between conversations

In streams that show conversations, **Move to conversation…** on a message reassigns it to another conversation. **Move messages to conversation…** lets you select several messages first. Pick **Move to…** in the bar, then **New conversation** or an existing one from the list. There is no confirmation step, because the messages stay in the same stream. See [Conversations and topics](/guide/conversations-and-topics).
