---
title: Personal API keys
summary: How to create a personal API key that acts as you, choose its permissions, and revoke it.
section: integrations
order: 4
---

# Personal API keys

A personal API key lets a script or tool call the Threa API as you. It has the same stream access as your account, and messages it sends are attributed to you. Keys are managed under **Personal API keys** on the [API keys & bots](app:settings/developer) settings page, which every member can open.

If you want a program to appear as its own participant instead, use a bot. See [Bots](/guide/bots-overview).

## Create a key

1. In **Personal API keys**, select **New key**. It opens **New API key**.
2. Enter a **Name**, for example "CI pipeline" or "local dev script".
3. Under **Permissions**, tick what the key may do. At least one is required.
4. Select **Create key**.

The key starts with `threa_uk_` and is shown once, under "New key:" and its name, with the note "Copy it now. It won't be shown again." Use **Show key** and **Copy key**, and copy it before you dismiss the notice. Threa cannot show it again. You can have up to 25 active keys.

## Permissions

The picker offers these permissions, each with a short description:

- Search messages, Read streams, Write streams, Read messages, Write messages
- Read users, Read memos, Read attachments, Upload attachments
- Read labels, Manage labels
- Read bot runtime state, Write bot runtime state
- Read bot invocations, Write bot invocations
- Read delegations, Work delegations

Admin and owner permissions, and the permissions for creating or managing bots and for managing members, cannot be given to a key, even if your own role has them. Choose the narrowest set that does the job.

## The key list

Each key shows its name, the first characters of the key (on wider screens), its permissions, when it was created and when it was last used. Its **...** menu has three actions:

- **Duplicate** opens **New API key** filled in with the key's name plus "(copy)", its permissions and its API version. The new key gets its own secret.
- **Edit permissions** opens **Edit permissions**. Change the ticks and select **Save permissions**.
- **Revoke** opens **Revoke API key**. Revoking stops the key working immediately and cannot be undone. Revoked keys move under a disclosure such as "1 revoked key".

Each key also has an **API version:** control, which reads "Latest" followed by the current version by default. Open it to choose **Always latest** or pin the key to a dated version so its behavior stays fixed.

Keys created here have no expiry date, so revoke any you no longer use.

Authentication, scopes and request examples are documented at https://threa.io/developers.
