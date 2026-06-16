/**
 * TipTap extension for `with:@` filter trigger in search mode.
 * Filters for messages in streams where the selected user is a member.
 * Inserts plain text: `with:@slug `
 */
import { Extension } from "@tiptap/core"
import Suggestion from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import type { Mentionable } from "./types"
import { getParentTextBefore } from "../markdown-guards"

export const WithFilterPluginKey = new PluginKey("withFilter")

export interface WithFilterOptions {
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
 * Custom match function for `with:` trigger.
 * Detects when user types `with:` followed by optional `@` and characters.
 * This allows both `with:martin` and `with:@martin` to work.
 */
function findWithFilterMatch(config: {
  char: string
  allowSpaces: boolean
  allowedPrefixes: string[] | null
  startOfLine: boolean
  $position: import("@tiptap/pm/model").ResolvedPos
}) {
  const { $position } = config

  const textBefore = getParentTextBefore($position)

  // Match `with:` at word boundary, optionally followed by `@`
  // Also match after `?` since search mode uses `?` prefix
  // Examples: "with:", "with:@", "with:mar", "with:@mar"
  const match = textBefore.match(/(?:^|\s|\?)(with:@?)(\S*)$/)
  if (!match) return null

  const fullMatch = match[0]
  const triggerPart = match[1] // "with:" or "with:@"
  const query = match[2] || "" // characters after trigger

  // Calculate positions relative to document
  const matchStart = $position.pos - fullMatch.length + (fullMatch.startsWith(" ") ? 1 : 0)

  return {
    range: { from: matchStart, to: $position.pos },
    query,
    text: triggerPart + query,
  }
}

export const WithFilterExtension = Extension.create<WithFilterOptions>({
  name: "withFilter",

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
        pluginKey: WithFilterPluginKey,
        char: "with:",
        allowSpaces: false,
        findSuggestionMatch: findWithFilterMatch,
        ...this.options.suggestion,
        command: ({ editor, range, props }) => {
          const item = props as Mentionable
          // Insert plain text: "with:@slug "
          editor.chain().focus().deleteRange(range).insertContent(`with:@${item.slug} `).run()
        },
      }),
    ]
  },
})
