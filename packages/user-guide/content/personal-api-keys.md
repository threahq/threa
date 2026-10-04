---
title: Personal API keys
summary: How to create a personal API key that acts as you, choose its permissions, and revoke it.
section: integrations
order: 4
---

# Personal API keys

A personal API key lets a script or tool call the Threa API as you. It has the same stream access as your account, and messages it sends are attributed to you. Keys are managed in the [API Keys](app:workspace-settings/api-keys) tab of Workspace Settings, which every member can open.

If you want a program to appear as its own participant instead, use a bot. See [Bots](/guide/bots-overview).

## Create a key

1. In **Personal keys**, select **New key**.
2. Enter a **Name**, for example "CI pipeline" or "local dev script".
3. Under **Permissions**, tick what the key may do. At least one is required.
4. Select **Create key**.

The key starts with `threa_uk_` and is shown once, under **Your new API key**. Use the reveal and copy buttons, and copy it before you dismiss the panel. Threa cannot show it again. You can have up to 25 active keys.

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

Each key shows its name, the first characters of the key (on wider screens), its permissions, when it was created and when it was last used. Each key has two icon buttons, which a mouse reveals on hover and a touch screen always shows.

- **Edit scopes** opens **Edit API key scopes**. Change the ticks and select **Save scopes**.
- **Revoke key** opens **Revoke API key**. Revoking stops the key working immediately and cannot be undone. Revoked keys move under a disclosure such as "1 revoked key".

Each key also has an **API version** control, which reads "Latest" followed by the current version by default. Open it to choose **Always latest** or pin the key to a dated version so its behavior stays fixed.

Keys created here have no expiry date, so revoke any you no longer use.

Authentication, scopes and request examples are documented at https://threa.io/developers.
