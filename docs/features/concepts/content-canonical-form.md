---
title: Content as Canonical Form
status: shipped
audience: internal
kind: concept
invariants: [INV-58, INV-60]
public_site: false
summary: >
  ProseMirror contentJson is the internal canon for message content; markdown is only the
  wire format at the system boundary, and any surface that shows a snippet strips it first.
---

## The principle

Message content has one canonical internal shape: ProseMirror `contentJson` (a `JSONContent`
document, typed `ThreaDocument`). Markdown is not a second source of truth. It is a
serialization format used at the system boundary (the API wire) and for external or AI callers
who can't speak ProseMirror.

Two rules fall out of that, and they are the two invariants this concept is:

- **INV-58, keep contentJson internal.** Components, stores, optimistic events, and IndexedDB
  all pass and store `contentJson`. Markdown is produced only when content crosses the boundary
  (sending to the API), and the backend converts back to `contentJson` on the way in. Nothing
  internal reads markdown to decide what to render.
- **INV-60, strip markdown before previewing.** Any UI that shows a flattened snippet of
  user-authored content (sidebar stream previews, thread cards, the activity feed, saved and
  scheduled lists, notification text, quoted snippets) routes the markdown through
  `stripMarkdownToInline()` first. Raw markdown never lands in a plain `<span>` or `<p>`.

## The problem it prevents

There are two distinct failure modes, one per invariant.

**Treating markdown as the canon (the INV-58 trap).** Markdown can't represent everything a
message holds: mentions, emoji atoms, attachment references, memo embeds, and quote replies are
structured nodes, not text. If internal code stored or passed markdown and re-parsed it on each
read, every round trip would risk dropping or mangling those nodes, and editing would be lossy.
Keeping `contentJson` as the canon means the structure that the editor produced is the structure
everything downstream sees; markdown is a projection of it, never the other way around.

**Shipping raw markdown to a preview (the INV-60 trap).** The backend sends raw markdown on the
wire. If a preview surface drops that string straight into a `<span>`, the user reads the syntax
instead of the text: `**bold**` keeps its asterisks, fenced code shows backticks, `[label](url)`
shows the brackets and the URL, and `:tada:` shows the literal shortcode. The window is easy to
miss because in a quick local test the sample text often has no markdown in it; it only looks
broken once a real message with formatting flows through.

```tsx
// WRONG: raw markdown into a plain element; literal **, `, [](), :emoji: leak to the user.
<p>{message.contentMarkdown.slice(0, 200)}</p>

// CORRECT: flatten and strip first (truncateContent does both, and resolves :shortcodes:).
<p>{truncateContent(message.contentMarkdown, 200, toEmoji)}</p>
```

## What an implementation must do

1. **Hold contentJson internally.** New stores, optimistic events, IDB rows, and components keep
   `contentJson`, not a markdown string. Serialize to markdown only at the moment you hand content
   to the API.
2. **Convert through the one shared converter.** `serializeToMarkdown` (JSON to markdown) and
   `parseMarkdown` (markdown to JSON) are the single source of truth, shared by the frontend editor
   and the backend. Don't hand-roll a second serializer.
3. **Keep both forms in sync at the boundary in.** When content arrives, derive the missing form so
   `contentJson` and `contentMarkdown` always agree: parse markdown to JSON for external/AI callers,
   serialize JSON to markdown for rich clients.
4. **Strip before any preview.** Route every flattened snippet through `stripMarkdownToInline()` or
   `truncateContent()`. If you're adding a surface that shows a content preview, stripping is part
   of the surface, not an optional polish step.
5. **Make wire serialization strip-friendly.** Structured embeds that have no plain-text form
   (shared message, memo embed, quote reply) serialize as markdown link syntax precisely so the
   strippers reduce them to a clean sentence rather than leaking a raw URL.

## How Threa implements it

- **The canonical type.** `Message` carries both `contentJson: ThreaDocument` and
  `contentMarkdown: string` (`packages/types/src/domain.ts:386`). The doc comment on the type spells
  out that `contentJson` is the canon and markdown is the serialization.
- **The one converter.** `serializeToMarkdown` and `parseMarkdown` live in
  `packages/prosemirror/src/markdown.ts`, with a single shared `INLINE_MARKDOWN_PATTERN` so the
  frontend editor and the backend tokenize identically.
- **Boundary in.** `normalizeContent` (`apps/backend/src/features/messaging/handlers.ts:183`) takes
  whichever form the caller sent and returns both: a rich client's `contentJson` gets a markdown
  projection serialized from it, and an AI/external caller's markdown gets parsed to `contentJson`.
- **Internal handling out.** The composer works in `contentJson` and sends `contentJson` to the API
  (`apps/frontend/src/components/timeline/message-input.tsx:510`); the offline operation queue
  persists optimistic message events as `contentJson` too
  (`apps/frontend/src/sync/operation-queue.ts:144`).
- **The strippers.** `stripMarkdownToInline()` / `stripMarkdown()`
  (`apps/frontend/src/lib/markdown/strip.ts`) remove markdown and collapse newlines for single-line
  previews; `truncateContent()` (`apps/frontend/src/components/layout/sidebar/utils.ts:79`) accepts
  either `contentJson` or a markdown string, serializes the former, then strips.
- **Strip-friendly embeds.** The `sharedMessage`, `memoEmbed`, and `quoteReply` serializers in
  `markdown.ts` emit markdown link syntax (`[Author](shared-message:...)`, `[Title](memo:...)`)
  with comments noting they do so for the INV-60 strippers; the frontend hydrates the live card on
  render, and the strip helpers reduce the wire fallback to plain text.
- **Reference surfaces that strip correctly.** `StreamItemPreview` (sidebar stream list,
  `stream-item.tsx`), `ActivityPreview` (`activity-content.tsx:34`), thread cards
  (`thread-card.tsx:108`), saved and scheduled list items, the scratchpad drawer, and the
  moved-messages drawer all go through `truncateContent`/`stripMarkdownToInline`.

## Boundaries

The principle is the established standard and the machinery is fully in production, but a sweep
found two surfaces that still ship raw markdown to users. Both are bugs against INV-60, not
unfinished plumbing; they're flagged here so the doc stays honest and so a fix has a target.

- **Conversation-list message preview.** `MessagePreview` in
  `apps/frontend/src/components/conversations/conversation-item.tsx:137` slices
  `message.contentMarkdown` by character count and renders it into a `whitespace-pre-wrap` `<p>`
  (`:157`) with no strip. Markdown formatting shows through in the conversation list.
- **Web-push notification text.** The activity service stores a raw `contentMarkdown.slice(0, 200)`
  as `contentPreview` (`apps/backend/src/features/activity/service.ts:95`, `:135`, `:227`, `:286`).
  The in-app activity feed strips that at render (`ActivityPreview`), so the feed is fine. The push
  path is not: `push/service.ts:303` and `:357` forward the same unstripped preview, and the
  service worker's `formatLine` (`apps/frontend/src/lib/sw-notification-format.ts:64`) only
  truncates it, so an OS notification can display literal markdown.

The second case also illustrates the backend's half of the contract: the backend deliberately
sends and stores raw markdown, leaving stripping to the frontend at render time (INV-60 says as
much). That's correct for the in-app feed, but it means every consumer of a raw preview string
must strip for itself, and the push consumer currently doesn't.

## Invariants

- **INV-58**: `contentJson` is the canonical internal representation; markdown is a serialization
  format at the wire only. Internal code passes and stores `contentJson` and serializes to markdown
  solely at the system boundary.
- **INV-60**: preview surfaces strip markdown before rendering, routing `contentMarkdown` through
  `stripMarkdownToInline()` or `truncateContent()` so literal syntax never reaches the user.
