---
title: Notification levels per stream
summary: How your overall notification level and each stream's own level decide what notifies you.
section: notifications
order: 1
---

# Notification levels per stream

Two settings decide what notifies you. One is your overall level for the whole workspace. The other is a level for each stream.

## Your overall level

On the [Notifications](app:settings/notifications) settings page, **Push notifications** sets which notifications from your streams also reach your devices as a push:

- **Push all**: whatever each stream is set to notify you about. This is the default.
- **Push mentions**: only @mentions, DMs and scratchpads.
- **No push**: nothing. Everything still shows in Threa.

Push notifications are held back entirely with **No push**. With **Push mentions**, a push is sent for a mention, for a message or reaction in a DM or scratchpad, or for a missed call. See [Push notifications](/guide/push-notifications).

Incoming-call ringing follows this overall level too, not a stream's own level. Both the ring sound and the ring push stay off with **No push** or while notifications are paused. See [Starting and joining calls](/guide/calls-basics).

## A stream's level

Each stream has its own level. Open the stream's settings (see [Stream settings](/guide/stream-settings)) and use **Notify me about** on the **General** page:

- The default option, such as **Channel default** or **Thread default**: follow the default, which the option describes, such as "Follows the default for channels, now mentions only."
- **Everything**: all messages and activity.
- **Activity**: mentions, reactions and thread replies.
- **Mentions only**: only when you are @mentioned.
- **Muted**: no notifications from this stream.

Which levels a stream offers depends on its type:

| Stream         | Levels offered                             | Default       |
| -------------- | ------------------------------------------ | ------------- |
| Channel        | Everything, Activity, Mentions only, Muted | Mentions only |
| Thread         | Everything, Activity, Mentions only, Muted | Activity      |
| Scratchpad     | Everything, Muted                          | Everything    |
| Direct message | Everything, Muted                          | Everything    |
| Aside          | Muted                                      | Muted         |

## How the two levels combine

The stream's level decides which messages are recorded in your activity and can notify you. Your overall level can only hold back push notifications on top of that. It never adds any. A channel left on its default, Mentions only, notifies you only when you are mentioned, even when your overall level is **Push all**.

A thread with no level of its own takes one from the stream it sits under:

- **Muted** carries through, so the thread is muted too.
- **Everything** gives the thread **Activity**.
- **Activity** and **Mentions only** don't carry through. The thread uses its own default.

Setting a level on the thread itself overrides all of this.

## Related

- Silence everything for a while: [Pausing notifications and setting a status](/guide/pause-and-status).
- See what you missed: [Activity and unread](/guide/activity-and-unread).
