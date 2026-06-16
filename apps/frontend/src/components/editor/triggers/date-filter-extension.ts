/**
 * TipTap extension for `after:` and `before:` date filter triggers in search mode.
 * Shows date picker/suggestions when user types `after:` or `before:`.
 *
 * Inserts plain text like "after:2025-01-15 " or "before:2025-12-31 ".
 */
import { Extension } from "@tiptap/core"
import Suggestion from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import { formatISODate, getPastDatePresets, getFutureDatePresets } from "@/lib/dates"
import { getParentTextBefore } from "../markdown-guards"

export const DateFilterPluginKey = new PluginKey("dateFilter")

export type DateFilterType = "after" | "before"

export interface DateFilterItem {
  id: string
  label: string
  value: string // ISO date string or relative value
  description: string
  filterType: DateFilterType
  isCustom?: boolean // True for "Pick a date..." option that opens calendar
}

/**
 * Generate quick date options for the date picker.
 *
 * - "after:" shows past-oriented options (search for messages after this date)
 * - "before:" shows future-oriented options first (upper bound), then past dates
 */
export function getDateFilterOptions(filterType: DateFilterType): DateFilterItem[] {
  const now = new Date()
  const presets = filterType === "after" ? getPastDatePresets(now) : getFutureDatePresets(now)

  const items: DateFilterItem[] = presets.map((preset) => ({
    id: preset.id,
    label: preset.label,
    value: formatISODate(preset.date),
    description: formatISODate(preset.date),
    filterType,
  }))

  // Add "Pick a date..." option at the end
  items.push({
    id: "custom",
    label: "Pick a date...",
    value: "",
    description: "Open calendar",
    filterType,
    isCustom: true,
  })

  return items
}

export interface DateFilterOptions {
  suggestion: {
    items: (props: { query: string }) => DateFilterItem[] | Promise<DateFilterItem[]>
    render: () => {
      onStart: (props: SuggestionProps<DateFilterItem>) => void
      onUpdate: (props: SuggestionProps<DateFilterItem>) => void
      onExit: () => void
      onKeyDown: (props: SuggestionKeyDownProps) => boolean
    }
  }
}

/**
 * Custom match function for `after:` and `before:` triggers.
 * Detects when user types `after:` or `before:` followed by optional characters.
 *
 * Uses TipTap's Trigger interface which provides $position for cursor context.
 */
function findDateFilterMatch(config: {
  char: string
  allowSpaces: boolean
  allowedPrefixes: string[] | null
  startOfLine: boolean
  $position: import("@tiptap/pm/model").ResolvedPos
}) {
  const { $position } = config

  const textBefore = getParentTextBefore($position)

  // Match `after:` or `before:` at word boundary, allowing spaces in query
  // Also match after `?` since search mode uses `?` prefix
  // Popover stays open as long as there are matching items
  const match = textBefore.match(/(?:^|\s|\?)(after:|before:)(.*)$/)
  if (!match) return null

  const fullMatch = match[0]
  const triggerPart = match[1] // "after:" or "before:"
  const query = match[2] || "" // characters after the trigger

  // Calculate positions relative to document
  const matchStart = $position.pos - fullMatch.length + (fullMatch.startsWith(" ") ? 1 : 0)

  return {
    range: { from: matchStart, to: $position.pos },
    query,
    text: triggerPart + query,
  }
}

export const DateFilterExtension = Extension.create<DateFilterOptions>({
  name: "dateFilter",

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
        pluginKey: DateFilterPluginKey,
        char: "after:", // Base trigger (we use custom matching for both after: and before:)
        allowSpaces: false,
        findSuggestionMatch: findDateFilterMatch,
        ...this.options.suggestion,
        command: ({ editor, range, props }) => {
          const item = props as DateFilterItem
          editor.chain().focus().deleteRange(range).insertContent(`${item.filterType}:${item.value} `).run()
        },
      }),
    ]
  },
})
