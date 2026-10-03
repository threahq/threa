---
title: Channels
summary: Create a channel, choose public or private, join one, and notify everyone with @here or @channel.
section: conversations
order: 2
---

# Channels

A channel is a shared conversation around a topic. Unlike a scratchpad, it has members, and a public channel can be found and joined by anyone in the workspace.

## Create a channel

Use the add button on the **Channels** section of the sidebar, choose **New Channel** from the sidebar's create menu, or run **New Channel** from the command palette. The **Create a channel** dialog has these fields:

- **Name**: becomes the channel's slug, shown with a `#` prefix. It is lowercased, and only letters, numbers, hyphens and underscores are kept. It must start with a letter, end with a letter or number, and be at most 50 characters. Threa checks that the slug is free as you type.
- **Visibility**: **Public** (anyone in the workspace can find and join) or **Private** (only invited members can access). Public is the default.
- **Description**: what the channel is about, up to 500 characters.
- **Users**: people to add now. You are added automatically as the creator.

Select **Create Channel** and Threa opens it.

## Public and private

A public channel appears in [Streams](app:streams) for everyone in the workspace. A private channel is hidden from non-members, who can't find or join it.

You can change this later in the channel's settings. Either switch asks you to confirm. Switching to private hides the channel from non-members, who can't find or join it. Switching to public makes it visible to every workspace user, and anyone can join. See [Stream settings](/guide/stream-settings).

## Joining

Open a public channel you are not in and a bar at the bottom reads "You're viewing #name" with a **Join Channel** button. On the Streams page, public channels you haven't joined have a **Join** button on their row. See [Browsing all streams](/guide/browse-streams).

To add other people to a channel, see [Adding people and bots to a stream](/guide/stream-members-and-invites).

## @here and @channel

Both notify people in the channel and skip the author. Type `@` in the composer and pick **Channel** or **Here** from the suggestions.

- `@channel` notifies every member of the channel. It is available in channels and in threads under a channel.
- `@here` notifies the members of the stream you are writing in. It is available in channels, direct messages and threads.

In a channel itself the two reach the same people. They differ in a thread, where `@here` reaches the thread's own members and `@channel` reaches the whole channel.

## Notifications

Channels default to notifying you on mentions only. Change that per channel in the channel's settings, or see [Notification levels](/guide/notification-levels).
