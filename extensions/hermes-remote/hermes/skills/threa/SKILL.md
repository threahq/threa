---
name: threa
description: Work inside a Threa scratchpad - send and receive attachments, use the threa MCP tools as the bot, and close a turn with a reply.
---

# Threa

The connector links this gateway to one Threa scratchpad. Each message there becomes one run, and the run's final
output becomes the reply.

## Attachments out

End a reply with one line per file:

```
THREA_ATTACH: /home/you/report.pdf
```

The connector uploads the file and replaces the line with an attachment. `MEDIA: <path>` works too: it is rewritten to
`THREA_ATTACH:` before the reply is posted. Paths may be absolute or relative to the connector's working directory
(`~/.threa/hermes-remote/work`).

## Attachments in

Files sent with a message are downloaded before the run starts. The message carries a manifest listing each file's
name and its local path. Read the file from that path; do not try to fetch it over HTTP.

## The threa MCP server

`THREA_CONFIG` points at `~/.threa/hermes-remote/threa-cli.json`, which holds the bot's key, workspace and base URL.
Calls made through those tools are attributed to the bot, not to the person who wrote the message, so a message you
post lands under the bot's name and is readable by everyone with access to that stream.

Use them to search workspace memory and past messages before asking the person to repeat context.

## Turns end

A run should finish with a reply. If the work is longer than a few minutes, report what you found, say what is left,
and let the person decide the next step rather than staying in the run.

To close a turn without posting anything, output exactly `THREA_NO_RESPONSE`.

## Approvals

A command that needs approval becomes a card in the scratchpad. On an encrypted scratchpad cards cannot be shown yet,
so the request is denied automatically: name the command you wanted and ask for another route.
