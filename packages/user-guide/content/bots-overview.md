---
title: Bots
summary: What bots are in Threa, the two kinds, and how to create and manage them in settings.
section: integrations
order: 1
---

# Bots

A bot is an account for a program: a script, a service or an agent running on your own machine. It has its own name and avatar, posts messages as itself, and reads and writes through API keys. Personal bots are managed on the [API keys & bots](app:settings/developer) settings page, and shared bots on the [Shared bots](app:settings/bots) page.

## Two kinds of bot

- **Personal bots**, under **Your bots** on API keys & bots, are bots you own and manage on your own. Members can create them by default. If the workspace doesn't allow it, the row says "This workspace doesn't let you create bots."
- **Bots**, under **Workspace bots** on Shared bots, are shared integration identities. The list appears for people who can create or manage shared bots, which in the default roles means admins. Others see "Only workspace admins can see and manage these."

Only the owner can manage a personal bot. A shared bot can be managed by anyone with the "Manage bots" permission, which admins have.

## Creating a bot

Select **New bot** in the list you want. Enter a **Name** and a **Slug** (the unique identifier: lowercase letters, numbers and hyphens). The slug is filled in from the name until you edit it. A **Description** is optional. Then select **Create bot**.

Under **Capabilities** you can turn on how Threa routes work to the bot:

- **Mentionable**: the bot can be invoked by @mention where it has access.
- **Active scratchpad**: the bot receives messages from scratchpads where it is the active actor.

You can change the name, slug, description and capabilities later with **Edit** in the bot's **Profile** row, which opens **Edit profile**. Under **Picture**, **Upload image** sets a JPEG, PNG or WebP image as its avatar (up to 50MB).

## What a bot's page contains

Select a bot to open its page. Below the profile it has these rows:

- **API keys**: keys the bot uses to call the API. See [Bot API keys and webhooks](/guide/bot-api-keys-and-webhooks).
- **Channel access**: a bot can read all public channels, but it can only post in channels it has been added to. **Grant channel access** adds it to a channel, public or private. A private channel is invisible to the bot until you add it.
- **Webhooks**: secret URLs that post into a stream as the bot.
- **Read everything you can read**: personal bots only, covered below.

## Reading access

On a personal bot, the **Read everything you can read** switch lets the bot read whatever you can read, except end-to-end encrypted streams. The bot can still only post where it has been added, and other members see which streams it was added to, not that it reads through you. If you lose access to a stream, the bot loses it at the same moment.

## Archiving

**Archive bot**, at the bottom of the bot's page, archives the bot and revokes all its API keys and channel grants. Its existing messages stay visible. **Restore bot** brings the bot back. Its revoked keys and channel grants are not reinstated, so create new keys and grant access again. A restore fails if another bot has since taken the same slug.

To run a coding agent as a bot, see [Linking Claude Code, Pi or Hermes](/guide/linked-coding-agents). For the API itself, see https://threa.io/developers.
