/**
 * TipTap extension for `status:` filter trigger in search mode.
 * Shows stream status options (active, archived) when user types `status:`.
 *
 * Inserts plain text like "status:active " or "status:archived ".
 */
import { Extension } from "@tiptap/core"
import Suggestion from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import { getParentTextBefore } from "../markdown-guards"

export const StatusFilterPluginKey = new PluginKey("statusFilter")

export interface StatusFilterItem {
  id: string
  value: string
  label: string
  description: string
}

export const STATUS_FILTER_OPTIONS: StatusFilterItem[] = [
  { id: "active", value: "active", label: "Active", description: "Currently active streams" },
  { id: "archived", value: "archived", label: "Archived", description: "Archived streams" },
]

export interface StatusFilterOptions {
  suggestion: {
    items: (props: { query: string }) => StatusFilterItem[] | Promise<StatusFilterItem[]>
    render: () => {
      onStart: (props: SuggestionProps<StatusFilterItem>) => void
      onUpdate: (props: SuggestionProps<StatusFilterItem>) => void
      onExit: (props: SuggestionProps<StatusFilterItem>) => void
      onKeyDown: (props: SuggestionKeyDownProps) => boolean
    }
  }
}

/**
 * Custom match function for `status:` trigger.
 * Detects when user types `status:` followed by optional characters.
 *
 * Uses TipTap's Trigger interface which provides $position for cursor context.
 */
function findStatusFilterMatch(config: {
  char: string
  allowSpaces: boolean
  allowedPrefixes: string[] | null
  startOfLine: boolean
  $position: import("@tiptap/pm/model").ResolvedPos
}) {
  const { $position } = config

  const textBefore = getParentTextBefore($position)

  // Match `status:` at word boundary (start of text or after whitespace)
  // Also match after `?` since search mode uses `?` prefix
  const match = textBefore.match(/(?:^|\s|\?)(status:)(\S*)$/)
  if (!match) return null

  const fullMatch = match[0]
  const triggerPart = match[1] // "status:"
  const query = match[2] || "" // characters after "status:"

  // Calculate positions relative to document
  const matchStart = $position.pos - fullMatch.length + (fullMatch.startsWith(" ") ? 1 : 0)

  return {
    range: { from: matchStart, to: $position.pos },
    query,
    text: triggerPart + query,
  }
}

export const StatusFilterExtension = Extension.create<StatusFilterOptions>({
  name: "statusFilter",

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
        pluginKey: StatusFilterPluginKey,
        char: "status:",
        allowSpaces: false,
        // Custom matching function for multi-character trigger
        findSuggestionMatch: findStatusFilterMatch,
        ...this.options.suggestion,
        command: ({ editor, range, props }) => {
          const item = props as StatusFilterItem
          editor.chain().focus().deleteRange(range).insertContent(`status:${item.value} `).run()
        },
      }),
    ]
  },
})
