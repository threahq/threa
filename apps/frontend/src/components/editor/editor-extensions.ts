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

import { MentionExtension, type MentionOptions } from "./triggers/mention-extension"
import { ChannelExtension, type ChannelOptions } from "./triggers/channel-extension"
import { CommandExtension, type CommandOptions } from "./triggers/command-extension"
import { EmojiExtension, type EmojiExtensionOptions } from "./triggers/emoji-extension"
import { AttachmentReferenceExtension } from "./attachment-reference-extension"
import HorizontalRule from "@tiptap/extension-horizontal-rule"
import { QuoteReplyExtension } from "./quote-reply-extension"
import { SharedMessageExtension } from "./shared-message-extension"
import { DictationPreview } from "./dictation-preview-extension"

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
