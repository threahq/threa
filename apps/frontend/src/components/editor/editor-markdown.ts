/**
 * Markdown ↔ ProseMirror JSON shim for the TipTap editor.
 *
 * The actual serializer / parser lives in `@threa/prosemirror`, shared with
 * the backend (AI agents, external integrators) so both sides agree on the
 * wire format. This file re-exports those entry points under the names the
 * editor's internals already use, plus the `ParseMarkdownOptions` flags
 * the composer toggles per-call (e.g. `enableMentions: false` while
 * dispatching a slash command). The parsers stay unified so the two sides
 * can't drift.
 */
import { parseMarkdown, serializeToMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@threa/types"
import type { Slice } from "@tiptap/pm/model"

export {
  serializeToMarkdown,
  parseMarkdown,
  INLINE_MARKDOWN_PATTERN,
  type MentionTypeLookup,
  type EmojiLookup,
  type ParseMarkdownOptions,
} from "@threa/prosemirror"

/**
 * Parse a standing-prompt markdown string (scratchpad custom prompt, persona
 * system prompt) into the ProseMirror doc a {@link RichEditor} edits. These
 * prompts are authored text, not messages: mention/channel/slash/emoji tokens
 * carry no reference and must not resolve to slugs, so every interactive parse
 * flag is off. Shared by every prompt-authoring editor so they can't drift.
 */
/**
 * Clipboard `text/plain` serializer for editor copy/cut. The default
 * ProseMirror text serialization is bare `textContent` — code fences, quote
 * markers, list bullets, and chip references (mentions, quote replies, shared
 * messages) all vanish, so pasting back can never restore them. Markdown is
 * the editor's canonical text form and the paste path parses it, closing the
 * copy → paste roundtrip.
 */
export function serializeClipboardSlice(slice: Slice): string {
  const content = slice.content.toJSON() as JSONContent[] | null
  if (!content) return ""
  // A NodeSelection of an inline atom (a chip) yields a slice whose top level
  // is inline content; the serializer expects blocks, so wrap it.
  const blocks = slice.content.firstChild?.isInline ? [{ type: "paragraph", content }] : content
  return serializeToMarkdown({ type: "doc", content: blocks })
}

/**
 * Content copied from a ProseMirror editor carries a `data-pm-slice` HTML
 * payload that restores the exact document, chips included. Paste handlers
 * bail on such events so ProseMirror's native paste applies it losslessly
 * instead of re-parsing the markdown `text/plain` fallback.
 */
export function isProseMirrorClipboardEvent(event: ClipboardEvent): boolean {
  const html = event.clipboardData?.getData("text/html")
  return !!html && html.includes("data-pm-slice")
}

export function parsePromptMarkdown(markdown: string): JSONContent {
  return parseMarkdown(markdown, undefined, undefined, {
    enableMentions: false,
    enableChannels: false,
    enableSlashCommands: false,
    enableEmoji: false,
  })
}
