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
  parseMentionPointerHref,
  type ReferencePin,
  type QuoteHref,
  type SharedMessageHref,
  type MemoHref,
  type GiphyHref,
  type MentionPointerType,
  type MentionHrefPointer,
  type ChannelHrefPointer,
  type ActorHrefPointer,
} from "./pointer-urls"
export { LEAF_NODE_TYPES, CONTAINER_NODE_TYPES, UnknownNodeTypeError, nodeSize, docContentSize } from "./positions"
export { sliceContent, isRangeValid, normalizeRange, isEmptySlice } from "./slice"
export { resolveSelectionRange, type SelectionRangeInput } from "./selection-range"
export {
  collectAttachmentReferenceIds,
  collectGiphyEmbeds,
  collectLinkUrls,
  collectQuoteReplyMessageIds,
  collectMemoEmbedIds,
  collectMentionActorRefs,
  collectChannelStreamIds,
  collectUnresolvedMentionSlugs,
  collectUnresolvedChannelLinkSlugs,
  mapMentionAndChannelNodes,
  type GiphyEmbedRef,
} from "./extractors"

export type { ContentRange, JSONContent, JSONContentMark, ThreaDocument } from "@threa/types"
