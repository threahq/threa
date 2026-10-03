---
title: Encryption limits and key recovery
summary: What encrypted scratchpads give up, why a lost passphrase cannot be recovered, and what Lock now and Revoke key do.
section: privacy
order: 2
---

# Encryption limits and key recovery

Threa's servers cannot read an encrypted scratchpad, so features that work by reading messages on the server do not apply to it. There is also no way to reset a lost passphrase.

## What does not work in an encrypted scratchpad

- Workspace search skips encrypted scratchpads. Searching inside an open one runs on your device, over the messages it has decrypted.
- Nothing in one becomes a memo, and memory does not capture it. See [How memory works](/guide/how-memory-works).
- Messages cannot be edited, because the message menu does not offer Edit message.
- Scheduled messages and stream briefs are refused.
- Sharing a message out of an encrypted scratchpad is refused.
- Replying to a note from the board is not supported yet. The board tells you to open the note and reply there.
- Attachments are encrypted on your device. Because the server cannot read them, they are not scanned for malware.
- Ariadne has web search, URL reading, research and attachment reading there, unless the stream's tool privacy settings turn the web tools off (see [Agent tool privacy](/guide/agent-tool-privacy)). She has no workspace, GitHub or Linear tools, and she does not start subagents.

## If you lose the passphrase

The content in your encrypted scratchpads becomes permanently unreadable. The setup dialog warns that no one can reset the passphrase for you, and you have to tick a box confirming you understand it can't be recovered. Store it in a password manager or write it down somewhere safe.

A PIN or biometric unlock is a shortcut you set up on a device that is already unlocked. It does not replace the passphrase.

## Lock now

In **Settings**, [AI](app:settings/ai), the **Encrypted scratchpads** section shows **Lock now** while you are unlocked. It drops the key from memory and deletes the key saved on this device, together with any PIN or biometric unlock set up for it. The next unlock asks for your passphrase, and **Keep me unlocked on this device** is off until you turn it on again. While locked, an encrypted scratchpad shows Unlock instead of its messages.

Only your unlocked device can give an invited agent access to a scratchpad's key. If an agent cannot reply until your device does that, Threa can send a push notification titled "Your assistant is waiting": "Unlock Threa to let your assistant reply in your encrypted scratchpad." See [Encrypted scratchpads](/guide/encrypted-scratchpads) for inviting agents.

## Revoke key

**Revoke key** is in the same section, and it is available while locked as well as unlocked. It opens **Revoke encryption key?**, which says:

- Any content already encrypted to this key becomes permanently unreadable on every device.
- You will need to set up a new passphrase afterwards.

Choose **Keep key** to cancel or **Revoke** to go ahead. Revoking recovers nothing. It lets you start again with a new passphrase.

For who can read what outside encrypted scratchpads, see [Who can see what](/guide/who-can-see-what).
