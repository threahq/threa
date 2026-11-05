---
title: Push notifications
summary: How to turn on push notifications for a device, send a test, and choose the buttons that appear on a notification.
section: notifications
order: 2
---

# Push notifications

Push notifications reach you on a device even when Threa isn't open. You turn them on separately for each device and browser.

## Turn them on

On the [Notifications](app:settings/notifications) settings page, turn on **Push on this device**. Threa asks the browser for permission and subscribes this device. Turn the switch off to stop push here.

- When the device is subscribed, **Send test** sends a test notification to every device with push on and reports the result for each.
- If subscribing fails, use **Retry**, or **Stop trying on this device**.
- If your browser blocks notifications from Threa, the switch says so. Allow them in the browser's site settings and reload the page.
- If the browser can't receive push notifications, the switch is unavailable and says so.
- If the Threa server isn't set up to send push notifications, the switch says that instead. **Check again** retries.

For installing Threa as an app first, see [Install the app](/guide/install-the-app).

## What gets sent

Your [notification level](/guide/notification-levels) and any [pause](/guide/pause-and-status) decide whether a push is sent. A push for a conversation is not shown when you are already viewing that conversation. A newer push for the same stream replaces the earlier one, except that mention notifications stay separate from message notifications. Each account keeps up to 10 push subscriptions per workspace; past that, the oldest one is dropped.

## Notification buttons

On devices that can show buttons on a notification, the **Notification buttons** setting lets you choose up to two. It is shown once **Push on this device** is on and **Push notifications** isn't **No push**. Buttons show in desktop Chrome. On other devices, including phones, the setting says "Only shown in desktop Chrome."

- **First button** and **Second button** can each be **None**, **Mark read**, **Remind me** or **React**. Choosing the same action for both clears the other slot. The defaults are **Mark read** and **Remind me**.
- **Remind me after** appears when one button is **Remind me**. It sets how long the reminder waits: 5 minutes (the default), 15 minutes, 30 minutes, 1 hour, 3 hours or 1 day.
- **Quick reaction** appears when one button is **React**. It sets the emoji used by that button. The default is 👍.

A preview shows how the notification will look.
