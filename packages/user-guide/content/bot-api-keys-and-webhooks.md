---
title: Bot API keys and webhooks
summary: How to create, scope and revoke a bot's API keys, and how to give it webhook URLs that post into a stream.
section: integrations
order: 2
---

# Bot API keys and webhooks

A bot reaches Threa in one of two ways. It calls the API with a bot API key, or something posts to a webhook URL that belongs to the bot. Both are managed on the bot's page in [Bots](app:workspace-settings/bots). Whoever can manage the bot can manage its keys and webhooks. See [Bots](/guide/bots-overview) for who that is.

## API keys

Open the bot and find **API Keys**. Select **New key**, enter a **Key name** (for example "production" or "staging"), tick the **Permissions** the key needs, and select **Create key**. At least one permission is required.

- The key starts with `threa_bk_`.
- It is shown once, in **Your new bot key**. Copy it before you dismiss the panel, because Threa cannot show it again.
- A bot can have up to 25 active keys.

The permissions you can choose are:

- Search messages, Read streams, Write streams, Read messages, Write messages
- Read users, Read memos, Read attachments, Upload attachments
- Read labels, Manage labels
- Read bot runtime state, Write bot runtime state
- Read bot invocations, Write bot invocations
- Read delegations, Work delegations

Admin-level permissions are not available on a key. Give a key only what its job needs. Each description is shown next to the checkbox.

Each key in the list shows its scopes, when it was created and when it was last used. Hover a key to reveal two actions.

- **Edit scopes** opens **Edit API key scopes**, where you change the permissions and select **Save scopes**.
- **Revoke key** stops the key working immediately. This cannot be undone. Revoked keys are listed under a disclosure such as "1 revoked key".

Each key also has an **API version** control. It tracks the latest version by default (**Always latest**), or you can pin it to a dated version so the API's behavior does not change under a running integration.

## Webhooks

Open **Webhooks** on the bot and select **New webhook**. Enter a **Webhook name** (for example "alertmanager") and choose the stream it **Posts to**. The list offers channels and scratchpads that are not end-to-end encrypted. Select **Create webhook**. Creating the webhook also gives the bot access to that stream.

You get two URLs, shown once under **Your new webhook URL**: a **Native** one and a **Slack** one. Tools that expect a Slack incoming webhook take the Slack URL. The secret is part of the URL, so anyone holding it can post to that stream as the bot. See [Slack-compatible incoming webhooks](/guide/incoming-webhooks) for what each URL accepts.

- You can rename a webhook or point it at another stream with **Edit webhook**. The URL does not change.
- **Revoke webhook** stops deliveries immediately and cannot be undone. There is no way to rotate a secret in place, so create a second webhook, move the sender across, then revoke the first.
- A bot can have up to 25 active webhooks.

## Archived bots

Archiving a bot revokes all its keys, and an archived bot has no **New key** or **New webhook** button. Restoring the bot does not bring revoked keys back.

Request formats, scopes and versioning are documented at https://threa.io/developers.
