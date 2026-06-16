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
export {
  serializeToMarkdown,
  parseMarkdown,
  INLINE_MARKDOWN_PATTERN,
  type MentionTypeLookup,
  type EmojiLookup,
  type ParseMarkdownOptions,
} from "@threa/prosemirror"
