import { Node, mergeAttributes } from "@tiptap/react"
import { InputRule } from "@tiptap/core"
import Suggestion from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import type { EmojiEntry } from "@threa/types"
import { currentWordContainsBacktick, isInBacktickWord } from "../markdown-guards"

export const EmojiPluginKey = new PluginKey("emoji")

export interface EmojiNodeAttrs {
  shortcode: string
  emoji: string
}

export interface EmojiExtensionOptions {
  suggestion: {
    items: (props: { query: string }) => EmojiEntry[] | Promise<EmojiEntry[]>
    render: () => {
      onStart: (props: SuggestionProps<EmojiEntry>) => void
      onUpdate: (props: SuggestionProps<EmojiEntry>) => void
      onExit: (props: SuggestionProps<EmojiEntry>) => void
      onKeyDown: (props: SuggestionKeyDownProps) => boolean
    }
  }
  /** Look up emoji by shortcode - used for input rule auto-convert */
  toEmoji: (shortcode: string) => string | null
}

/**
 * TipTap extension for :emoji: shortcuts.
 *
 * Features:
 * - Suggestion popup when typing ":" followed by query
 * - Input rule to auto-convert :shortcode: to editable emoji text
 * - Renders legacy emoji atom nodes from older message JSON
 */
export const EmojiExtension = Node.create<EmojiExtensionOptions>({
  name: "emoji",
  group: "inline",
  inline: true,
  selectable: false,
  atom: true,
  marks: "_", // Allow all marks (bold, italic, etc.)

  addStorage() {
    return { popupVisible: false }
  },

  addOptions() {
    return {
      suggestion: {
        items: () => [],
        render: () => ({
          onStart: () => {},
          onUpdate: () => {},
          onExit: () => {},
          onKeyDown: () => false,
        }),
      },
      toEmoji: () => null,
    }
  },

  addAttributes() {
    return {
      shortcode: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-shortcode"),
        renderHTML: (attrs) => ({ "data-shortcode": attrs.shortcode }),
      },
      emoji: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-emoji"),
        renderHTML: (attrs) => ({ "data-emoji": attrs.emoji }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="emoji"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-type": "emoji",
        // Match trigger atoms' text-like inline layout; Firefox Android handles
        // adjacent contenteditable=false inline-block emoji spans poorly.
        class: "inline",
      }),
      node.attrs.emoji,
    ]
  },

  // Copy/paste serializes back to :shortcode:.
  renderText({ node }) {
    return `:${node.attrs.shortcode}:`
  },

  addInputRules() {
    const { toEmoji } = this.options

    // Auto-convert :shortcode: to emoji text when closing colon is typed.
    // Legacy emoji atom rendering remains above for old content, but new
    // composer input uses text so mobile browsers delete it natively.
    return [
      new InputRule({
        find: /:([a-z0-9_+-]+):$/,
        handler: ({ state, range, match, chain }) => {
          const shortcode = match[1]
          const emoji = toEmoji(shortcode)
          if (!emoji) return null

          // Suppress inside an unclosed inline-code word (see markdown-guards).
          if (isInBacktickWord(state, range.from)) return null

          // Preserve marks at the caret so the converted emoji keeps surrounding styling.
          const $from = state.doc.resolve(range.from)
          const { storedMarks } = state
          const currentMarks = storedMarks || $from.marks()
          const marks = currentMarks.map((mark: { type: { name: string }; attrs: Record<string, unknown> }) => ({
            type: mark.type.name,
            attrs: mark.attrs,
          }))

          chain()
            .deleteRange(range)
            .insertContent([{ type: "text", text: emoji, marks }])
            .run()
        },
      }),
    ]
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: EmojiPluginKey,
        char: ":",
        allowSpaces: false,
        startOfLine: false,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)

          for (let depth = $from.depth; depth >= 0; depth--) {
            const node = $from.node(depth)
            if (node.type.name === "codeBlock") {
              return false
            }
          }

          const marks = $from.marks()
          if (marks.some((mark) => mark.type.name === "code")) {
            return false
          }

          const storedMarks = state.storedMarks || $from.marks()
          if (storedMarks.some((mark) => mark.type.name === "code")) {
            return false
          }

          // Suppress inside an unclosed inline-code word (see markdown-guards).
          if (currentWordContainsBacktick($from)) {
            return false
          }

          return true
        },
        ...this.options.suggestion,
        command: ({ editor, range, props }) => {
          const item = props as EmojiEntry

          // Preserve marks at the caret so the inserted emoji keeps surrounding styling.
          const { $from } = editor.state.selection
          const { storedMarks } = editor.state
          const currentMarks = storedMarks || $from.marks()
          const marks = currentMarks.map((mark: { type: { name: string }; attrs: Record<string, unknown> }) => ({
            type: mark.type.name,
            attrs: mark.attrs,
          }))

          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent([
              { type: "text", text: item.emoji, marks },
              { type: "text", text: " ", marks },
            ])
            .run()
        },
      }),
    ]
  },
})
