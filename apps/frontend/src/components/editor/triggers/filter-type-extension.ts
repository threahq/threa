/**
 * TipTap extension for `is:` filter trigger in search mode.
 * Shows stream type options (scratchpad, channel, dm, thread) when user types `is:`.
 *
 * Unlike mention/channel extensions, this inserts plain text, not a node.
 * Note: `type:` is kept as an alias in the parser but the primary trigger is `is:`.
 */
import { Extension } from "@tiptap/core"
import Suggestion from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import { getParentTextBefore } from "../markdown-guards"

export const FilterTypePluginKey = new PluginKey("filterType")

export interface FilterTypeItem {
  id: string
  value: string
  label: string
  description: string
}

export const FILTER_TYPE_OPTIONS: FilterTypeItem[] = [
  { id: "scratchpad", value: "scratchpad", label: "Scratchpad", description: "Personal notes and AI companion" },
  { id: "channel", value: "channel", label: "Channel", description: "Public or private team channels" },
  { id: "dm", value: "dm", label: "Direct Message", description: "One-on-one conversations" },
  { id: "thread", value: "thread", label: "Thread", description: "Nested discussions" },
]

export interface FilterTypeOptions {
  suggestion: {
    items: (props: { query: string }) => FilterTypeItem[] | Promise<FilterTypeItem[]>
    render: () => {
      onStart: (props: SuggestionProps<FilterTypeItem>) => void
      onUpdate: (props: SuggestionProps<FilterTypeItem>) => void
      onExit: (props: SuggestionProps<FilterTypeItem>) => void
      onKeyDown: (props: SuggestionKeyDownProps) => boolean
    }
  }
}

/**
 * Custom match function for `is:` trigger.
 * Detects when user types `is:` followed by optional characters.
 *
 * Uses TipTap's Trigger interface which provides $position for cursor context.
 */
function findFilterTypeMatch(config: {
  char: string
  allowSpaces: boolean
  allowedPrefixes: string[] | null
  startOfLine: boolean
  $position: import("@tiptap/pm/model").ResolvedPos
}) {
  const { $position } = config

  const textBefore = getParentTextBefore($position)

  // Match `is:` at word boundary (start of text or after whitespace)
  // Also match after `?` since search mode uses `?` prefix
  const match = textBefore.match(/(?:^|\s|\?)(is:)(\S*)$/)
  if (!match) return null

  const fullMatch = match[0]
  const triggerPart = match[1] // "is:"
  const query = match[2] || "" // characters after "is:"

  // Calculate positions relative to document
  const matchStart = $position.pos - fullMatch.length + (fullMatch.startsWith(" ") ? 1 : 0)

  return {
    range: { from: matchStart, to: $position.pos },
    query,
    text: triggerPart + query,
  }
}

export const FilterTypeExtension = Extension.create<FilterTypeOptions>({
  name: "filterType",

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

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: FilterTypePluginKey,
        char: "is:",
        allowSpaces: false,
        // Custom matching function for multi-character trigger
        findSuggestionMatch: findFilterTypeMatch,
        ...this.options.suggestion,
        command: ({ editor, range, props }) => {
          const item = props as FilterTypeItem
          editor.chain().focus().deleteRange(range).insertContent(`is:${item.value} `).run()
        },
      }),
    ]
  },
})
