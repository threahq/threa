import { type AnyExtension } from "@tiptap/core"
import Document from "@tiptap/extension-document"
import Paragraph from "@tiptap/extension-paragraph"
import Text from "@tiptap/extension-text"
import HardBreak from "@tiptap/extension-hard-break"
import History from "@tiptap/extension-history"
import Gapcursor from "@tiptap/extension-gapcursor"
import Placeholder from "@tiptap/extension-placeholder"

// Inline marks with atom-aware input rules
import { AtomAwareBold, AtomAwareItalic, AtomAwareStrike, AtomAwareCode, BoundaryAwareLink } from "./atom-aware-marks"

// Block extensions
import Blockquote from "@tiptap/extension-blockquote"
import BulletList from "@tiptap/extension-bullet-list"
import OrderedList from "@tiptap/extension-ordered-list"
import ListItem from "@tiptap/extension-list-item"
import Heading from "@tiptap/extension-heading"
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight"
import { common, createLowlight } from "lowlight"
import { Table } from "@tiptap/extension-table/table"
import { TableRow } from "@tiptap/extension-table/row"
import { TableHeader } from "@tiptap/extension-table/header"
import { TableCell } from "@tiptap/extension-table/cell"
import { MarkdownTableInputRule } from "./markdown-table-input-rule"

import { MentionExtension, type MentionOptions } from "./triggers/mention-extension"
import { ChannelExtension, type ChannelOptions } from "./triggers/channel-extension"
import { CommandExtension, type CommandOptions } from "./triggers/command-extension"
import { EmojiExtension, type EmojiExtensionOptions } from "./triggers/emoji-extension"
import { AttachmentReferenceExtension } from "./attachment-reference-extension"
import HorizontalRule from "@tiptap/extension-horizontal-rule"
import { QuoteReplyExtension } from "./quote-reply-extension"
import { SharedMessageExtension } from "./shared-message-extension"
import { DictationPreview } from "./dictation-preview-extension"
import { DictationChunkExtension } from "./dictation-chunk-extension"

// Create lowlight instance with common languages
const lowlight = createLowlight(common)

interface CreateEditorExtensionsOptions {
  placeholder: string
  mentionSuggestion?: MentionOptions["suggestion"]
  channelSuggestion?: ChannelOptions["suggestion"]
  commandSuggestion?: CommandOptions["suggestion"]
  emojiSuggestion?: EmojiExtensionOptions["suggestion"]
  /** Look up emoji by shortcode - used for input rule auto-convert */
  toEmoji?: (shortcode: string) => string | null
}

/**
 * Creates editor extensions for Linear-style rich text editing.
 *
 * Features:
 * - Inline marks: **bold**, *italic*, ~~strike~~, `code` with markdown input rules
 * - Block formatting: lists, code blocks, blockquotes, headings
 * - Atom nodes: @mentions, #channels, /commands, :emoji:, attachments
 *
 * Markdown syntax converts to styled text as you type (e.g., **text** becomes bold).
 */
export function createEditorExtensions(options: CreateEditorExtensionsOptions | string) {
  // Support legacy string-only signature
  const config: CreateEditorExtensionsOptions = typeof options === "string" ? { placeholder: options } : options

  const extensions: AnyExtension[] = [
    // Core text editing
    Document,
    Paragraph,
    Text,
    HardBreak,
    History,
    Gapcursor,

    // Placeholder text when empty
    Placeholder.configure({
      placeholder: config.placeholder,
      emptyEditorClass: "is-editor-empty",
    }),

    // Inline marks with atom-aware input rules
    AtomAwareBold,
    AtomAwareItalic,
    AtomAwareStrike,
    AtomAwareCode,

    // Block formatting
    Heading.configure({ levels: [1, 2, 3] }),
    BulletList,
    OrderedList,
    ListItem,
    Blockquote,
    HorizontalRule,
    CodeBlockLowlight.configure({
      lowlight,
      defaultLanguage: "plaintext",
    }),

    // GFM tables. Default cell content (`block+`) is intentionally kept so
    // pasting a table whose cells contain inline marks or hard breaks works
    // — the markdown serializer flattens those to a single line of pipes.
    // `renderWrapper: true` emits the standard `<div class="tableWrapper">`
    // around the table so the composer can scroll wide tables horizontally
    // on narrow viewports, matching how the timeline displays them.
    Table.configure({
      resizable: false,
      renderWrapper: true,
    }),
    TableRow,
    TableHeader,
    TableCell,

    // Type-to-create: pressing Enter after `| h |\n| --- |` converts the
    // pipe-row paragraphs to a real table node.
    MarkdownTableInputRule,

    // Auto-link URLs (makes them clickable)
    BoundaryAwareLink.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      HTMLAttributes: {
        class: "text-primary underline underline-offset-2 hover:text-primary/80",
      },
    }),

    // Inline attachments (images, files)
    AttachmentReferenceExtension,

    // Quote reply blocks
    QuoteReplyExtension,

    // Shared message pointer blocks (cross-stream shares)
    SharedMessageExtension,

    // Live dictation hypothesis ghost (inert unless actively dictating)
    DictationPreview,

    // Tracks ranges of polished dictation chunks so the session toggle can
    // swap them back to raw transcript; inert unless chunks are added.
    DictationChunkExtension,
  ]

  // Add mention extension if suggestion config provided
  if (config.mentionSuggestion) {
    extensions.push(
      MentionExtension.configure({
        suggestion: config.mentionSuggestion,
      })
    )
  }

  // Add channel extension if suggestion config provided
  if (config.channelSuggestion) {
    extensions.push(
      ChannelExtension.configure({
        suggestion: config.channelSuggestion,
      })
    )
  }

  // Add command extension if suggestion config provided
  if (config.commandSuggestion) {
    extensions.push(
      CommandExtension.configure({
        suggestion: config.commandSuggestion,
      })
    )
  }

  // Add emoji extension if suggestion config provided
  if (config.emojiSuggestion && config.toEmoji) {
    extensions.push(
      EmojiExtension.configure({
        suggestion: config.emojiSuggestion,
        toEmoji: config.toEmoji,
      })
    )
  }

  return extensions
}
