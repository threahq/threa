/**
 * TipTap extension for `in:@` filter trigger in search mode.
 * Shows user suggestions when user types `in:@` (for DM filtering).
 * Inserts plain text: `in:@slug `
 *
 * Examples:
 * - `in:@` → shows all users
 * - `in:@mar` → shows users matching "mar"
 * - `in:` → NOT matched (handled by in-channel-filter-extension for streams)
 * - `in:#` → NOT matched (handled by in-channel-filter-extension for streams)
 */
import { Extension } from "@tiptap/core"
import Suggestion from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import type { Mentionable } from "./types"
import { getParentTextBefore } from "../markdown-guards"

export const InUserFilterPluginKey = new PluginKey("inUserFilter")

export interface InUserFilterOptions {
  suggestion: {
    items: (props: { query: string }) => Mentionable[] | Promise<Mentionable[]>
    render: () => {
      onStart: (props: SuggestionProps<Mentionable>) => void
      onUpdate: (props: SuggestionProps<Mentionable>) => void
      onExit: (props: SuggestionProps<Mentionable>) => void
      onKeyDown: (props: SuggestionKeyDownProps) => boolean
    }
  }
}

/**
 * Custom match function for `in:@` trigger (for DM filtering).
 * Only matches `in:@` followed by optional query.
 * `in:` alone is handled by in-channel-filter-extension (shows streams).
 */
function findInUserFilterMatch(config: {
  char: string
  allowSpaces: boolean
  allowedPrefixes: string[] | null
  startOfLine: boolean
  $position: import("@tiptap/pm/model").ResolvedPos
}) {
  const { $position } = config

  const textBefore = getParentTextBefore($position)

  // Match `in:@` at word boundary - requires explicit @ for DM filter
  // - `in:@` → matches (shows users)
  // - `in:@mar` → matches (query="mar")
  // - `in:` → does NOT match (handled by in-channel-filter-extension)
  // - `in:#` → does NOT match (handled by in-channel-filter-extension)
  const match = textBefore.match(/(?:^|\s|\?)(in:@)(\S*)$/)
  if (!match) return null

  const fullMatch = match[0]
  const triggerPart = match[1] // "in:@"
  const query = match[2] || "" // characters after trigger

  // Calculate positions relative to document
  const matchStart = $position.pos - fullMatch.length + (fullMatch.startsWith(" ") ? 1 : 0)

  return {
    range: { from: matchStart, to: $position.pos },
    query,
    text: triggerPart + query,
  }
}

export const InUserFilterExtension = Extension.create<InUserFilterOptions>({
  name: "inUserFilter",

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
        pluginKey: InUserFilterPluginKey,
        char: "in:@", // Explicit @ required for DM filter
        allowSpaces: false,
        findSuggestionMatch: findInUserFilterMatch,
        ...this.options.suggestion,
        command: ({ editor, range, props }) => {
          const item = props as Mentionable
          editor.chain().focus().deleteRange(range).insertContent(`in:@${item.slug} `).run()
        },
      }),
    ]
  },
})
