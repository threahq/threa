---
title: Push notifications
summary: How to turn on push notifications for a device, send a test, and choose the buttons that appear on a notification.
section: notifications
order: 2
---

# Push notifications

Push notifications reach you on a device even when Threa isn't open. You turn them on separately for each device and browser.

## Turn them on

Open your [notification settings](app:settings/notifications) and find **Push notifications**. A badge shows the state of this device: Enabled, Off, Blocked, Unsupported, Unavailable, Error or Subscribing….

- **Enable push notifications** shows while the badge says Off and the browser hasn't been asked yet. It asks the browser for permission and subscribes this device.
- When the device is subscribed, **Send test** sends a test notification and reports the result for each of your devices. **Disable for this device** turns push off here.
- If you turned push off, **Re-enable** turns it on again.
- If subscribing fails, use **Retry**, or **Stop trying for this device**.
- If the badge says Blocked, allow notifications for Threa in your browser's site settings and reload the page.
- If it says Unsupported, the browser doesn't support push notifications.
- If it says Unavailable, the Threa server isn't set up to send push notifications. **Check again** retries.

For installing Threa as an app first, see [Install the app](/guide/install-the-app).

## What gets sent

Your [notification level](/guide/notification-levels) and any [pause](/guide/pause-and-status) decide whether a push is sent. A push for a conversation is not shown when you are already viewing that conversation. A newer push for the same stream replaces the earlier one, except that mention notifications stay separate from message notifications. Each account keeps up to 10 push subscriptions per workspace; past that, the oldest one is dropped.

## Notification buttons

On devices that can show buttons on a notification, the **Notification buttons** section lets you choose up to two. Buttons show in desktop Chrome. On other devices, including phones, the section says the device can't show buttons and to set them up from desktop Chrome.

- **First button** and **Second button** can each be **None**, **Mark read**, **Remind me** or **React**. Choosing the same action for both clears the other slot. The defaults are **Mark read** and **Remind me**.
- **Remind me after** appears when one button is **Remind me**. It sets how long the reminder waits: 5 minutes (the default), 15 minutes, 30 minutes, 1 hour, 3 hours or 1 day.
- **Quick reaction** appears when one button is **React**. It sets the emoji used by that button. The default is 👍.

A preview shows how the notification will look.
