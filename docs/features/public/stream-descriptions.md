---
title: Stream Descriptions
status: shipped
audience: public
since: 2026-06
surfaces: [stream-settings, timeline, public-api]
public_site: true
summary: >
  A rich-text description on any channel or scratchpad, edited in the same editor
  used for messages, that posts a "set the description" row into the stream's
  timeline whenever it changes.
related: [concepts/content-canonical-form.md]
---

## What it does

Every stream can carry a description. It is stored the same way message bodies are:
the canonical form is ProseMirror JSON (`description_json`), and a markdown projection
(`description`) is derived from it for search and for the public API wire. The JSON is
what the editor reads and writes; the markdown is never trusted from the client, only
re-derived from the JSON, so the two cannot drift (this is the content-canonical-form
rule, INV-58).

Setting or changing a description does two things in one transaction: it writes the new
content, and it appends a `description_set` row to the stream's own timeline attributed
to whoever made the change. The row reads "<actor> set the description" with the new text
below it, or "<actor> cleared the description" when the description is emptied. The row
only appears when the text actually changed, so renaming or archiving a stream in the
same edit does not produce one.

## How a user experiences it

- **Editing.** The editor lives in a stream's settings, on the General tab. It is the
  same rich editor used for messages, so bold, italic, lists, links and the rest work the
  same way. Slash commands and image upload are turned off here. Clearing the field and
  saving removes the description.
- **In the timeline.** A change shows up as a centered single line ("<actor> set the
  description") with the new text rendered below it behind a left border. It is a plain
  row, not a boxed card. Long descriptions collapse past roughly eight lines with a way to
  expand. The actor renders as a mention chip.
- **Through the public API.** `PATCH` on a stream accepts a markdown `description` (scope
  `streams:write`); an empty string clears it. A bot or integration can also set a
  description when it creates a linked scratchpad session, so an agent can ship a handover
  note as the stream's description at creation time, and it renders as a "<bot> set the
  description" row.

The change is delivered live through the outbox, so the timeline row appears for everyone
in the stream without a refetch, carrying the markdown snapshot in its payload.

## Boundaries

- **The public API write is markdown only.** The in-app editor sends the canonical JSON;
  the public API accepts markdown and converts it through the same normalizer, so both
  paths converge, but an API caller cannot send ProseMirror JSON directly.
- **No standalone read-only panel.** The description is shown read-only only through the
  timeline `description_set` row. There is no separate header or info panel that renders
  the current description outside settings.
- **Legacy plaintext rows.** Streams that had a plain-text description before this landed
  have no JSON yet; the editor seeds itself by parsing the old markdown, and the JSON is
  filled in on the first rich edit.
- **Descriptions are plaintext metadata.** They are not sealed, even on an end-to-end
  encrypted scratchpad.

## Related

- [Content canonical form](../concepts/content-canonical-form.md) is the rule that makes
  `description_json` the source of truth and markdown a derived projection.
