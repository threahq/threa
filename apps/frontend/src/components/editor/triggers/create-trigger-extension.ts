import { Node, ReactNodeViewRenderer, mergeAttributes, type Editor, type ReactNodeViewProps } from "@tiptap/react"
import type { ComponentType } from "react"
import Suggestion from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import { currentWordContainsBacktick } from "../markdown-guards"
import { withKeyboardCorrectionTolerance } from "./keyboard-correction-match"
import { withSpacedQuery } from "./spaced-query-match"
import { currentSuggestionRange } from "./suggestion-range"

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
  /**
   * Let the query contain the trigger char, so a doubled sigil stays one match
   * (`##pi` → query `#pi`) instead of the second char starting a fresh match the
   * `allowedPrefixes` check then rejects — which is what closes the popup.
   */
  allowToIncludeChar?: boolean
  /**
   * Let a space extend the query while it still matches, so a multi-word target
   * is reachable (see `withSpacedQuery`). Off by default: for most triggers a
   * space ends the mention, and only a synchronous item source can answer
   * mid-transaction whether the query still matches.
   */
  spacedQuery?: boolean
  /** Attribute definitions for the node */
  attributes: Record<keyof TAttrs, AttributeConfig>
  /** Returns the CSS class(es) for the rendered node */
  getClassName: (attrs: TAttrs) => string
  /** Returns the text content for the rendered node (e.g., "@slug") */
  getText: (attrs: TAttrs) => string
  /** Maps the selected autocomplete item to node attributes */
  mapPropsToAttrs: (item: TItem) => TAttrs
  /**
   * Optional React node view. A chip whose label is baked into `attrs` renders
   * fine from `renderHTML`; one that has to read live state — a `#` chip
   * resolving its target's current name from the id — needs a component.
   * `renderHTML` stays the fallback for the copy/paste and export paths.
   */
  nodeView?: ComponentType<ReactNodeViewProps>
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
 * `setAttribute` stringifies, so an unset attribute would land on the element as
 * the literal text "null".
 */
function definedAttributes(attrs: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(attrs)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)])
  )
}

/**
 * Whether a query would fill the popup. Only a synchronous item source can
 * answer inside a transaction; an async one (server-backed search) hands back a
 * promise, and firing a request per keystroke to decide a match is not worth it.
 */
function hasItems<TItem>(items: (props: { query: string }) => TItem[] | Promise<TItem[]>, query: string): boolean {
  const result = items({ query })
  return Array.isArray(result) && result.length > 0
}

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
    allowToIncludeChar = false,
    spacedQuery = false,
    attributes,
    getClassName,
    getText,
    mapPropsToAttrs,
    nodeView,
    onSelectItem,
  } = config

  return Node.create<TriggerExtensionOptions<TItem>>({
    name,
    group: "inline",
    inline: true,
    selectable: true,
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

    // A node view replaces the editor DOM, so `renderHTML`'s attributes never
    // reach it. They go on the outer element TipTap builds, the same one
    // `selectNode()` marks, so the `[data-type=…].ProseMirror-selectednode`
    // styling, `pillFromDom` and the paste specs' `data-id` all find one element.
    ...(nodeView
      ? {
          addNodeView: () =>
            ReactNodeViewRenderer(nodeView, {
              attrs: ({ HTMLAttributes }) => ({ ...definedAttributes(HTMLAttributes), "data-type": name }),
            }),
        }
      : {}),

    addProseMirrorPlugins() {
      const { items } = this.options.suggestion
      const matchSuggestion = withKeyboardCorrectionTolerance(pluginKey, this.editor)

      return [
        Suggestion({
          editor: this.editor,
          pluginKey,
          char,
          allowSpaces: false,
          allowToIncludeChar,
          startOfLine,
          findSuggestionMatch: spacedQuery
            ? withSpacedQuery(matchSuggestion, (query) => hasItems(items, query))
            : matchSuggestion,
          // Disable suggestions in code contexts (code blocks and inline code)
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

            // The trigger character itself can land inside a code mark via
            // stored marks even when the resolved position carries none.
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
            const liveRange = currentSuggestionRange(pluginKey, editor, range)
            if (onSelectItem?.({ editor, range: liveRange, item })) return
            const attrs = mapPropsToAttrs(item)

            // Preserve marks at the caret so a chip inserted mid-styled-run keeps the formatting.
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
              .deleteRange(liveRange)
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
