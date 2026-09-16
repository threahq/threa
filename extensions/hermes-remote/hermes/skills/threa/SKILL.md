---
name: threa
description: Work inside a Threa scratchpad - write Threa markdown (mentions, channel links, attachments), send and receive attachments, use the threa MCP tools as the bot, and close a turn with a reply.
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

## Markdown

Source: https://threa.io/developers/markdown

A reply is markdown. GitHub-flavored formatting renders as expected:

| Element                     | Syntax                                      |
| --------------------------- | ------------------------------------------- |
| Bold, italic, strikethrough | `**bold**`, `*italic*`, `~~struck~~`        |
| Inline code, code blocks    | `` `code` ``, fenced blocks with a language |
| Headings                    | `# H1` through `###### H6`                  |
| Lists                       | `- item`, `1. item`                         |
| Tables                      | GFM pipe tables                             |
| Blockquotes, rules          | `> quote`, `---`                            |
| Links                       | `[text](https://…)`                         |

A link whose target starts with one of the schemes below is a typed reference, rendered as a chip or card, not a
plain link. Use `https://`, `mailto:` or a relative path for ordinary links.

### Mentions and channels

Write a mention as a bare `@slug` and a channel as `#slug`; Threa resolves each against the workspace and stores the
id. A bare slug that resolves to nothing stays as typed. When you know the id, write the resolved form directly:

```
Ping [@pierre](user:usr_8x2…) and [@ariadne](persona:persona_a1…) about [#releases](channel:stream_4f…).
```

Messages you read carry the resolved form. The label is display text; the link target is the stable id. `@here` and
`@channel` are broadcasts.

### Emoji

Write `:shortcode:` (for example `:tada:`). Unknown shortcodes stay as text.

### Link schemes

| Scheme            | Reference                      | Example                                    |
| ----------------- | ------------------------------ | ------------------------------------------ |
| `user:`           | workspace member mention       | `[@pierre](user:usr_…)`                    |
| `persona:`        | agent mention                  | `[@ariadne](persona:persona_…)`            |
| `bot:`            | bot mention                    | `[@deploybot](bot:bot_…)`                  |
| `broadcast:`      | `@here` / `@channel`           | `[@here](broadcast:here)`                  |
| `channel:`        | channel link                   | `[#releases](channel:stream_…)`            |
| `attachment:`     | uploaded file                  | `[report.pdf](attachment:attach_…)`        |
| `memo:`           | memory card                    | `[Auth rewrite](memo:memo_…)`              |
| `quote:`          | quoted reply (read only)       | `[Alice](quote:stream_…/msg_…/usr_…/user)` |
| `shared-message:` | cross-stream share (read only) | `[Alice](shared-message:stream_…/msg_…)`   |

`attachment:` needs an id that already exists (for example one from a message you read). To attach a local file to
your reply, use `THREA_ATTACH:` from "Attachments out" instead.
