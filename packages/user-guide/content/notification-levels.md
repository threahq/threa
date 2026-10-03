---
title: Notification levels per stream
summary: How your overall notification level and each stream's own level decide what notifies you.
section: notifications
order: 1
---

# Notification levels per stream

Two settings decide what notifies you. One is your overall level for the whole workspace. The other is a level for each stream.

## Your overall level

In your [notification settings](app:settings/notifications), the **Notification level** section sets when you want to be notified:

- **All messages**: get notified for all new messages. This is the default.
- **Mentions only**: get notified for @mentions, DMs and scratchpad messages.
- **None**: don't send any notifications.

Push notifications are held back entirely while the level is **None**. With **Mentions only**, a push is sent for a mention, for a message or reaction in a DM or scratchpad, or for a missed call. See [Push notifications](/guide/push-notifications).

Incoming-call ringing follows this overall level too, not a stream's own level. Both the ring sound and the ring push stay off while the level is **None** or notifications are paused. See [Starting and joining calls](/guide/calls-basics).

## A stream's level

Each stream has its own level. Open the stream's settings (see [Stream settings](/guide/stream-settings)) and use the **Notifications** select on the **General** tab:

- **Default**: use the stream's default level, which the option shows in parentheses.
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

## Related

- Silence everything for a while: [Pausing notifications and setting a status](/guide/pause-and-status).
- See what you missed: [Activity and unread](/guide/activity-and-unread).
