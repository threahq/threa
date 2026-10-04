---
title: Encrypted scratchpads
summary: How to set up end-to-end encryption, create an encrypted scratchpad, unlock it on a device, and invite Ariadne or another agent into it.
section: privacy
order: 1
---

# Encrypted scratchpads

An encrypted scratchpad holds messages that are encrypted on your device before they are sent. Threa's servers store the ciphertext and cannot read it. Encryption applies to scratchpads and the threads under them, not to channels or direct messages.

## Set it up once

Open **Settings** and the [AI](app:settings/ai) tab. At the bottom, the **Encrypted scratchpads** section shows a status (Not set up, Locked or Unlocked). Choose **Set up encryption**.

The **Set up encrypted scratchpads** dialog asks for:

- A **Passphrase** of at least 10 characters, entered twice, with a strength hint.
- A confirmation that you have saved the passphrase and understand it cannot be recovered.
- Optionally, **Keep me unlocked on this device**, which also offers a quick-unlock PIN or biometrics.

Choose **Enable encryption**. You can skip the Settings page: creating your first encrypted scratchpad opens this dialog and finishes the creation afterwards. Read [Encryption limits and key recovery](/guide/encryption-limits-and-recovery) before you rely on it, because a lost passphrase cannot be reset.

## Create an encrypted scratchpad

Use the add menu in the Scratchpads section of the sidebar, or the command palette ([Quick switcher and command palette](/guide/quick-switcher-and-command-palette)):

- Choose **New Encrypted Scratchpad** for a scratchpad with Ariadne invited, so she can reply.
- Choose **New Encrypted Quick Note** for one without Ariadne.

You can invite Ariadne into a quick note later, or remove her, from the scratchpad's header (see below).

## Unlock on each device

While locked, an encrypted scratchpad shows an **Unlock** button instead of its messages. Unlocking once opens every encrypted scratchpad in that workspace. The key is kept in memory and is dropped when you sign out or choose **Lock now** in Settings, which also removes this device's PIN and biometric unlock.

You can unlock with:

- Your passphrase, in the **Unlock encrypted scratchpads** dialog.
- A 6-digit PIN, set at setup or later with **Set a PIN** in the section (it shows while **Keep me unlocked on this device** is on). Five wrong PINs remove the PIN from the device and you need the passphrase again.
- The device's fingerprint or face unlock, after you choose **Use biometrics** (offered only when the device supports it).

The **Keep me unlocked on this device** switch stores an encrypted copy of the key on the device, so the passphrase is not asked each time. Do not enable it on a shared or public computer. If you have set a PIN or biometrics, **Unlock automatically** goes back to unlocking without any prompt.

## Agents in an encrypted scratchpad

An agent can read an encrypted scratchpad only after you invite it, because the scratchpad's key is then shared with that agent.

- The **Invite Ariadne** button in the scratchpad header adds her. Her replies are produced by a separate service that decrypts the conversation in memory while she works (see [Who can see what](/guide/who-can-see-what)). Remove her from the same place.
- The **Invite agent** menu adds a bot, such as a linked coding agent (see [Linking Claude Code, Pi or Hermes](/guide/linked-coding-agents)). Invited bots show in the header, and an agent invited while the scratchpad is locked gets access once you unlock. You can also add a bot from the scratchpad's settings, under members, which warns that it will be able to read every message. Remove a bot from there too; removing it asks you to confirm.

Removing an agent deletes the copies of the key it was given. It keeps what it already read and gets nothing sent afterwards.

Developers can read and write encrypted scratchpads from the terminal. See [threa.io/developers](https://threa.io/developers).
