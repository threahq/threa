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
import { parseMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@threa/types"

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
export function parsePromptMarkdown(markdown: string): JSONContent {
  return parseMarkdown(markdown, undefined, undefined, {
    enableMentions: false,
    enableChannels: false,
    enableSlashCommands: false,
    enableEmoji: false,
  })
}
