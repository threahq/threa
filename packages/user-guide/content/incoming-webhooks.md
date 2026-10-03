---
title: Slack-compatible incoming webhooks
summary: What an incoming webhook does, how to create one, and what to know before pasting its URL into another tool.
section: integrations
order: 3
---

# Slack-compatible incoming webhooks

An incoming webhook is a secret URL that posts into one channel or scratchpad as one of your bots. Nothing else is needed to call it: the URL is the credential. Each webhook has a second URL ending in `/slack`, so tools that can already send to a Slack incoming webhook can send to Threa unchanged.

## Create one

1. Open [Bots](app:workspace-settings/bots) in Workspace Settings and select the bot that should post.
2. In **Webhooks**, select **New webhook**.
3. Enter a **Webhook name** and choose the stream it **Posts to**.
4. Select **Create webhook** and copy the URLs.

Both URLs are shown once, labeled **Native** and **Slack**. Threa cannot show them again. A webhook belongs to its bot, and every message it delivers is posted by that bot. The target must be a channel or a scratchpad. Threads and end-to-end encrypted streams are not accepted, because a webhook holds no key and cannot encrypt what it posts.

You can rename a webhook or move it to another stream without changing its URL. You can also revoke it from the same panel. A revoked webhook cannot be restored. Details of the panel are in [Bot API keys and webhooks](/guide/bot-api-keys-and-webhooks).

## What each URL accepts

- The **Native** URL takes a JSON object with a `content` string written in Markdown.
- The **Slack** URL takes a Slack incoming-webhook payload and translates it to Markdown. Slack's `text`, `blocks` and `attachments` are rendered; when `blocks` render, `text` is left out, as Slack treats it as the fallback. Fields such as `username`, `icon_emoji`, `icon_url` and `channel` are ignored, because the message always posts as the webhook's bot in the webhook's stream.

For example, a Slack-style sender needs only the Slack URL:

```bash
curl -X POST "$THREA_SLACK_HOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{"text": "Deploy *v2.4.1* finished. <https://ci.example.com/42|Run log>"}'
```

## Limits

- A bot can have up to 25 active webhooks.
- A request body can be up to 256 KB, and a message up to 50,000 characters.
- Each webhook accepts 60 requests per minute.

## Security

Anyone with the URL can post to that stream as that bot. Keep it in a secret store and out of repositories and shared documents. There is no request signature to verify. A webhook message can mention people and use `@here` and `@channel`, and those notify like any other message. It cannot attach files.

To rotate a URL, create a second webhook on the same bot and stream, move the sender across, then revoke the first.

Payload details, error responses and setup notes for senders such as Grafana and PostHog are at https://threa.io/developers/incoming-webhooks.
