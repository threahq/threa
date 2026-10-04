---
title: Updates, offline use and App status
summary: How Threa updates itself, what works without a connection, what the App status page shows, and the touch gestures on phones and tablets.
section: apps
order: 3
---

# Updates, offline use and App status

Threa downloads new versions in the background and asks before switching to one. It keeps a copy of your data on the device, so it opens and shows what it has even when the network is down. The [App status](app:app-status) page shows what version you are running and lets you check for updates.

## Updates

Threa checks for a new version every 5 minutes, when it returns to the foreground, and after it reconnects. When a new version has finished downloading, a toast appears: "A new version of Threa is ready", with a **Reload** button. Dismissing the toast leaves the update waiting. A downloaded update stays ready until you reload, online or offline.

While it switches over, the toast reads "Updating Threa…". If the switch fails, it reads "Threa couldn't finish updating" with the note "The build you have keeps running." and a **Try again** button.

## Offline use

Threa stores streams, messages and drafts for your account in the browser's local database (IndexedDB) on this device. It shows that stored copy before the network answers and when there is no network.

- When the connection is unstable for a few seconds, a small pill at the top of the page reads **Offline**, **Reconnecting** or **Disconnected**.
- While offline, the message box placeholder reads "Type a message (sent when back online)". Messages you send wait in a queue on the device and go out when Threa reconnects.
- Editing or deleting a message while offline shows a notice, "Edit queued — will be saved when back online" or "Delete queued — will complete when back online".

## App status

Open **App status** from the menu at the bottom of the sidebar, where Settings and Log out also are. The top card says whether you are up to date, and it holds the button to act on it: **Check for updates**, or **Reload and update** when a version is ready. It also shows when Threa last checked.

**Build details** shows the current version, when it was updated on this device, when the build was created and the app host.

**Device readiness** shows:

- Connection: Online or Offline.
- Offline support: Ready, Starting or Not supported. Starting means the background service that enables offline use has not taken control of the page yet.
- Running as: Installed app or Web browser. See [Installing Threa as an app](/guide/install-the-app).

## Gestures and sheets on touch devices

- On a phone-width screen, swipe right to open the sidebar and left to close it. Swipes that start at the very edge of the screen are ignored so they do not clash with your phone's back gesture.
- Pull down at the top of a view to refresh. Pull a short way and the indicator reads "Release to refresh", which re-fetches your workspace and the streams on screen. Pull further and it reads "Release to reload", which reloads the whole app.
- Long-press a message to open its actions in a bottom sheet. Editing a message also opens in a bottom sheet.
- Swipe a message left to quote it. Drag down after swiping left to open an aside on that message, in streams where asides are available. See [Asides](/guide/asides).
- Long-press a stream in the sidebar to open its actions. On a row in your inbox, swipe right to **Settle** it.
