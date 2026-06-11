/**
 * @threa/prosemirror - Shared ProseMirror utilities
 *
 * This package provides bidirectional conversion between Markdown text
 * and ProseMirror JSON format, ensuring consistent handling across
 * frontend (TipTap editor) and backend (AI agents, external integrators).
 */

export {
  serializeToMarkdown,
  parseMarkdown,
  normalizeMarkdownTables,
  INLINE_MARKDOWN_PATTERN,
  type MentionTypeLookup,
  type EmojiLookup,
  type ParseMarkdownOptions,
} from "./markdown"
export {
  escapeMarkdownLinkText,
  unescapeMarkdownLinkText,
  escapeMarkdownLinkTitle,
  unescapeMarkdownLinkTitle,
  serializeAttachmentMetadata,
  parseAttachmentMetadata,
  type ParsedAttachmentMetadata,
} from "./attachment-markdown"
export {
  buildQuoteHref,
  parseQuoteHref,
  buildSharedMessageHref,
  parseSharedMessageHref,
  buildMemoHref,
  parseMemoHref,
  buildGiphyHref,
  parseGiphyHref,
  type QuoteHref,
  type SharedMessageHref,
  type MemoHref,
  type GiphyHref,
} from "./pointer-urls"
export { collectAttachmentReferenceIds, collectMentionSlugs } from "./extractors"

// Re-export types for convenience
export type { JSONContent, JSONContentMark, ThreaDocument } from "@threa/types"
