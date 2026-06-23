---
title: Message Composer
status: shipped
audience: public
since: 2026-04
surfaces: [composer, editor, timeline, mobile-composer]
public_site: true
summary: >
  The rich-text editor you write messages in: formatting, @mentions, #channel
  links, emoji, large-paste snippets, GIFs and voice dictation, with an action
  bar that folds into a "+" menu as it narrows and a desktop fullscreen mode.
related: [concepts/content-canonical-form.md]
---

## What it does

The composer is a ProseMirror rich-text editor. What you type is held as ProseMirror JSON
(`contentJson`), which is the canonical form everywhere in the app; markdown is only the
wire format, serialized at the moment a message is sent or copied (this is the
content-canonical-form rule, INV-58). Send takes a snapshot of the editor JSON and hands it
to the timeline, which clears the editor optimistically and restores it with an inline error
if the send fails.

On top of plain text the editor carries a set of typed inserts, each driven by a trigger
character:

- **Formatting:** bold, italic, strikethrough, inline code, headings, lists, links and
  tables, available from a formatting toolbar and from the usual markdown shortcuts as you
  type.
- **@mentions** of people, personas and bots, and **#channel** links. A mention is an inline
  atom that holds a stable id as its identity and shows a name; the id is what travels, so the
  reference survives a rename. `@here` and `@channel` broadcasts are offered where the stream
  allows them.
- **:emoji:** by shortcode, with a picker.
- **Snippets:** a large paste, or the `/snippet` command, turns a block of text or code into
  an attached file rather than an inline wall of text (see Snippets below).
- **GIFs** from the `/giphy` picker, inserted as an inline embed rendered from the GIF CDN
  (no upload).
- **Voice dictation** from the mic button, which streams a transcript into the editor.

## How a user experiences it

### The action bar and the "+" overflow

The desktop composer has an action bar holding the secondary inserts (emoji, mention, command,
attach, expand) alongside the always-present "Aa" formatting toggle and the send button. The
bar measures its own width, and as it narrows the secondary actions fold into a left-anchored
"+" menu instead of wrapping, so the composer never reflows mid-type. Actions keep their
left-to-right order; only which ones fold changes. A few triggers that need a visible anchor
for their popovers (the dictation mic, stash, schedule) stay inline and drop from the tail
only under extreme squeeze. The mobile composer uses a separate action bar that does not fold.

### Fullscreen document mode (desktop)

A stream's composer can expand to a fullscreen editor over the timeline for longer writing.
It is the same composer component with the same draft and attachment state, not a second
editor, so nothing drifts between the inline and expanded views. Expanded mode pins the
toolbar, forces Cmd/Ctrl+Enter to send, and offers the inserts from a "+" drawer at the
bottom. Escape collapses it; the content is preserved.

### Snippets

When you paste a very large block of text (over 4 MiB), the composer offers to attach it as a
file instead of inlining it. You can also reach for snippets deliberately with the `/snippet`
command or the "Create snippet" command in the quick switcher. Either way you get a snippet
dialog: a plain text area (so it can hold multi-megabyte content), a filename, and a format
dropdown. The format is sniffed structurally from the content (JSON, XML, HTML, CSV, Markdown,
YAML, or plain text), never guessed from programming-language keywords, and you can override it
from the dropdown, which rewrites the filename's extension. A renamed extension wins over the
sniff. The saved snippet is an ordinary text-file attachment, so it rides the normal attachment
path (including encryption on a sealed stream). In the timeline gallery, text and code
attachments get a plain monospace text preview.

### Drafts, scheduling, and send mode

The composer autosaves a draft as you type and can stash drafts for later; both the stashed-draft
and scheduled-message pickers open above the composer rather than over the editor, and on mobile
they keep the keyboard open. Send mode follows your preference (Enter or Cmd/Ctrl+Enter), except
fullscreen and mobile, which force Cmd/Ctrl+Enter.

### Mobile

On mobile the composer collapses to a single-line preview that expands its chrome on focus. The
keyboard choreography is built to move with the iOS keyboard rather than fight it: chrome
expansion is deferred to the first viewport resize after focus and rendered in the same frame, so
the content nudge and the keyboard rise land as one motion instead of a stutter.

## Boundaries

- **Mentions on the wire are the slug as text.** The stable id is held in the canonical JSON;
  the markdown projection renders the readable `@slug` / `#slug`. (There is no project invariant
  number for this id-authoritative behavior in the codebase today, despite what older notes may
  say.)
- **GIFs are embeds, not uploads.** A `/giphy` insert points at the GIF CDN; it is not stored as
  an attachment.
- **Snippet text previews are skipped on encrypted streams.** A snippet attached in an
  end-to-end encrypted scratchpad is created fine, but it shows as a decrypt-on-click download in
  the timeline rather than getting the in-timeline text preview.
- **Large-paste conversion needs an upload-capable composer.** The 4 MiB paste-to-snippet
  offer only fires where the composer can upload files; without that, a large paste inserts inline.
- **Slash commands, drafts, GIFs, and voice dictation have their own surfaces.** The composer
  hosts their triggers; the behavior lives in those features. See Related.

## Related

- [Content canonical form](../concepts/content-canonical-form.md): why the editor holds and
  sends `contentJson`, with markdown only at the wire.
