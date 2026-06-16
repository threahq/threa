/**
 * TipTap extension for `from:@` filter trigger in search mode.
 * Shows user/persona suggestions when user types `from:@`.
 * Inserts plain text: `from:@slug `
 */
import { Extension } from "@tiptap/core"
import Suggestion from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import type { Mentionable } from "./types"
import { getParentTextBefore } from "../markdown-guards"

export const FromFilterPluginKey = new PluginKey("fromFilter")

export interface FromFilterOptions {
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
 * Custom match function for `from:` trigger.
 * Detects when user types `from:` followed by optional `@` and characters.
 * This allows both `from:martin` and `from:@martin` to work.
 */
function findFromFilterMatch(config: {
  char: string
  allowSpaces: boolean
  allowedPrefixes: string[] | null
  startOfLine: boolean
  $position: import("@tiptap/pm/model").ResolvedPos
}) {
  const { $position } = config

  const textBefore = getParentTextBefore($position)

  // Match `from:` at word boundary, optionally followed by `@`
  // Also match after `?` since search mode uses `?` prefix
  // Examples: "from:", "from:@", "from:mar", "from:@mar"
  const match = textBefore.match(/(?:^|\s|\?)(from:@?)(\S*)$/)
  if (!match) return null

  const fullMatch = match[0]
  const triggerPart = match[1] // "from:" or "from:@"
  const query = match[2] || "" // characters after trigger

  // Calculate positions relative to document
  const matchStart = $position.pos - fullMatch.length + (fullMatch.startsWith(" ") ? 1 : 0)

  return {
    range: { from: matchStart, to: $position.pos },
    query,
    text: triggerPart + query,
  }
}

export const FromFilterExtension = Extension.create<FromFilterOptions>({
  name: "fromFilter",

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
        pluginKey: FromFilterPluginKey,
        char: "from:",
        allowSpaces: false,
        findSuggestionMatch: findFromFilterMatch,
        ...this.options.suggestion,
        command: ({ editor, range, props }) => {
          const item = props as Mentionable
          editor.chain().focus().deleteRange(range).insertContent(`from:@${item.slug} `).run()
        },
      }),
    ]
  },
})
