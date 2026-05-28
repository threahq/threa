import { Node, mergeAttributes, type Editor } from "@tiptap/react"
import Suggestion from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import { currentWordContainsBacktick } from "../markdown-guards"

/**
 * Configuration for a single attribute on a trigger node.
 */
interface AttributeConfig {
  default?: unknown
  dataAttr: string
}

/**
 * Configuration for creating a trigger extension.
 */
export interface TriggerExtensionConfig<TItem, TAttrs extends object> {
  /** Node name in the ProseMirror schema */
  name: string
  /** Unique plugin key for the suggestion plugin */
  pluginKey: PluginKey
  /** Character that triggers the autocomplete (e.g., "@", "#", "/") */
  char: string
  /** Whether trigger only works at start of line (default: false) */
  startOfLine?: boolean
  /** Attribute definitions for the node */
  attributes: Record<keyof TAttrs, AttributeConfig>
  /** Returns the CSS class(es) for the rendered node */
  getClassName: (attrs: TAttrs) => string
  /** Returns the text content for the rendered node (e.g., "@slug") */
  getText: (attrs: TAttrs) => string
  /** Maps the selected autocomplete item to node attributes */
  mapPropsToAttrs: (item: TItem) => TAttrs
  /**
   * Optional selection override. Return `true` to fully handle the pick and
   * skip the default "insert node chip" behavior — e.g. a slash item that
   * hands off to another trigger by inserting plain text instead of a node.
   */
  onSelectItem?: (ctx: { editor: Editor; range: { from: number; to: number }; item: TItem }) => boolean
}

/**
 * Options passed to the extension at runtime.
 */
export interface TriggerExtensionOptions<TItem> {
  suggestion: {
    items: (props: { query: string }) => TItem[] | Promise<TItem[]>
    render: () => {
      onStart: (props: SuggestionProps<TItem>) => void
      onUpdate: (props: SuggestionProps<TItem>) => void
      onExit: (props: SuggestionProps<TItem>) => void
      onKeyDown: (props: SuggestionKeyDownProps) => boolean
    }
  }
}

// No text-sm - inherit font size from parent (important for headers)
// No font-medium - inherit font weight from parent (important for bold)
// Use inline (not inline-flex) to properly propagate text-decoration (strikethrough, underline)
const baseClassName = "inline rounded px-1 py-0.5"

/**
 * Factory function to create TipTap trigger extensions.
 * Reduces boilerplate for @mentions, #channels, /commands, and future triggers.
 */
export function createTriggerExtension<TItem, TAttrs extends object>(config: TriggerExtensionConfig<TItem, TAttrs>) {
  const {
    name,
    pluginKey,
    char,
    startOfLine = false,
    attributes,
    getClassName,
    getText,
    mapPropsToAttrs,
    onSelectItem,
  } = config

  return Node.create<TriggerExtensionOptions<TItem>>({
    name,
    group: "inline",
    inline: true,
    selectable: false,
    atom: true,
    marks: "_", // Allow all marks (bold, italic, code, strike) on this node

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
      }
    },

    addAttributes() {
      const attrConfig: Record<string, object> = {}
      for (const [key, cfg] of Object.entries(attributes) as [string, AttributeConfig][]) {
        attrConfig[key] = {
          default: cfg.default ?? null,
          parseHTML: (element: HTMLElement) => element.getAttribute(cfg.dataAttr),
          renderHTML: (attrs: Record<string, unknown>) => ({ [cfg.dataAttr]: attrs[key] }),
        }
      }
      return attrConfig
    },

    parseHTML() {
      return [{ tag: `span[data-type="${name}"]` }]
    },

    renderHTML({ node, HTMLAttributes }) {
      const attrs = node.attrs as TAttrs
      return [
        "span",
        mergeAttributes(HTMLAttributes, {
          "data-type": name,
          class: `${baseClassName} ${getClassName(attrs)}`,
        }),
        getText(attrs),
      ]
    },

    renderText({ node }) {
      return getText(node.attrs as TAttrs)
    },

    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          pluginKey,
          char,
          allowSpaces: false,
          startOfLine,
          // Disable suggestions in code contexts (code blocks and inline code)
          allow: ({ state, range }) => {
            const $from = state.doc.resolve(range.from)

            // Check if inside a code block
            for (let depth = $from.depth; depth >= 0; depth--) {
              const node = $from.node(depth)
              if (node.type.name === "codeBlock") {
                return false
              }
            }

            // Check if cursor position has code mark
            const marks = $from.marks()
            if (marks.some((mark) => mark.type.name === "code")) {
              return false
            }

            // Also check if the trigger character itself would be inside code
            // by looking at stored marks
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
            const item = props as TItem
            if (onSelectItem?.({ editor, range, item })) return
            const attrs = mapPropsToAttrs(item)

            // Get marks at the current position to preserve styling (bold, italic, etc.)
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
                { type: name, attrs, marks },
                { type: "text", text: " ", marks },
              ])
              .run()
          },
        }),
      ]
    },
  })
}
