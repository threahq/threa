---
title: Threads
summary: Reply to a message in a thread, move messages into one, share a thread message back to its channel, and find your threads.
section: conversations
order: 7
---

# Threads

A thread is a side conversation under one message. It keeps a discussion out of the main timeline while everyone with access to the stream can still open it.

## Start or open a thread

Hover a message and select the reply arrow (**Reply in thread**), or choose **Reply in thread** from the message menu. The thread opens beside the stream on desktop and over it on mobile. A thread is created with its first reply. The message that started it is shown at the top.

A thread is named automatically, and its General settings show the name read-only. If the current name wasn't generated automatically, the settings offer **Regenerate title** to replace it with a generated one.

## Who can see a thread

A thread has no access of its own. It follows the stream it sits in: anyone who can read the channel can read its threads. A thread under a private channel is private, and the thread's settings show its visibility as inherited. People can also be added to a thread directly. Adding someone to a thread adds them to the channel as well. See [Adding people and bots to a stream](/guide/stream-members-and-invites).

Notifications default to **Activity** for a thread, which is more than a channel's mentions-only default. See [Notification levels](/guide/notification-levels).

## Move messages into a thread

Choose **Move to thread…** on a message, or **Move messages…** in the **Stream actions** menu. Select the messages you want to move, then drop them on the message that should become the thread's parent. Threa asks you to confirm "Move messages?" before it moves them. See [Moving messages](/guide/moving-messages).

## Share a thread message upward

In a thread, a message's menu has a share entry for the stream the thread sits in, such as **Share to #general**. For a thread in a scratchpad or DM it reads **Share to scratchpad** or **Share to DM**. Choosing it opens that stream with the message attached to the composer. Nothing is posted until you send. In a thread nested under another thread, a second entry, **Share to thread (name)**, does the same for the parent thread. See [Quoting and sharing](/guide/quoting-and-sharing).

## Find your threads

- The **Threads** tab on the [Streams](app:streams) page lists threads. From a sidebar row's menu, **Threads** opens that tab narrowed to one stream's threads.
- A thread shows in the sidebar, nested under its stream, while it has unread activity, an agent is working in it, or you have it open. Other threads are reached from their stream or from the Streams page.

Settings for a thread have the same three tabs as other streams, including a Companion tab where the brief is shared with the stream the thread sits under. See [Stream settings](/guide/stream-settings).

## Coding sessions in a scratchpad thread

In a scratchpad linked to a coding session, `/thread <message>` sends a message that the session answers in a thread, and `/replies [thread|flat]` chooses whether the session replies in a thread on each message or in the scratchpad. Bare `/replies` reports the current mode. These commands exist only where a session is linked. See [Linked coding agents](/guide/linked-coding-agents).

## Threads and asides

Threads are shared with the stream. For a private conversation with Ariadne, use an [aside](/guide/asides).
