---
title: Starting and joining calls
summary: Start a voice or video call from a channel or DM, answer an incoming call, rejoin after a reload, and move a call between devices.
section: conversations
order: 14
---

# Starting and joining calls

Channels and direct messages can host a voice or video call. Anyone who can open the stream can join its call, up to 50 participants. Calls are on by default for a workspace.

## Start a call

Open a channel or DM and use **Start a call** in the stream header. Choose **Start voice call** or **Start video call**. The button is disabled while you are already in a call.

You can also start a video call from a person's profile with **Call**. It needs an existing DM, so until you have sent them a message it is disabled with the hint "Send a message first to start a call".

Before you connect, Threa asks the browser for your microphone and, for video, your camera. If something is wrong, a message says what: calls blocked on this site, microphone access denied, no microphone found, the microphone busy in another app, or access blocked by your system. Each has **Try again** and **Cancel**.

## Who gets notified

- In a DM, the other person's devices ring for 45 seconds.
- In a channel, nobody rings. In both, the call appears in the timeline as a call card.

## Answer an incoming call

A card at the bottom right reads "<name> is calling…", with **Video call** or **Voice call** below. It has three buttons: **Silence ring**, **Decline call** and **Accept call**. It does not take keyboard focus from what you are typing.

The ring sound stays off when your overall **Notification level** is **None** or you have paused notifications, but the card still shows. A stream's own level does not change this. See [Notification levels per stream](/guide/notification-levels) and [Pausing notifications and setting a status](/guide/pause-and-status). If the page cannot play sound, Threa sends a system notification with the same text, and selecting it accepts the call.

## The call card

A call in a channel or DM leaves a card in the timeline. While the call is live it shows **Call in progress**, a running timer and the participants' avatars, plus a **Join** button. If you are already in the call it reads **In this call**. When the call is over it reads "Call ended" with the duration.

The card menu has **Join call** (only while the call is live and you are not in it), **Start call chat** or **Open call chat**, and **Copy link to call**. If the call is already open on another of your devices, **Join call** reads **Take over call on this device** and the card button reads **Take over**. Both are disabled with "You're already in another call" while you are in a call.

## Rejoin and take over

If you reload the page or close the tab while in a call, the call keeps running and a bar under the stream header reads "You're still in this call". Choose **Take over** to move the call to this device, or **Leave**.

Joining a call you are already in on another device asks you to confirm: "Joining here will move the call to this device." Choose **Join on this device**. The stream header and the call card show **Take over** instead of **Join** in that case.

The device you moved away from shows "Call moved to another device". Two other notices come with **Rejoin here** too: "Call ended while your phone was locked" and "Call ended — this device lost its connection". On iPhone and iPad, locking the screen ends the call, and Threa warns you with "Locking your phone ends this call."

For the call surface, layouts and devices, see [Call layouts and devices](/guide/call-layouts-and-devices). Call preferences are under [Settings](app:settings/calls).
