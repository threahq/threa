/**
 * TipTap extension for the `/refine` trigger in search mode. Typing `/` at a
 * word boundary offers "Refine"; picking it inserts `/refine ` and the prose
 * that follows becomes a refinement of the result list once committed.
 */
import { Extension } from "@tiptap/core"
import Suggestion from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"
import { getParentTextBefore } from "../markdown-guards"
import type { TriggerExtensionOptions } from "./create-trigger-extension"

export const RefinePluginKey = new PluginKey("refine")

export interface RefineItem {
  id: string
  label: string
  description: string
}

export const REFINE_OPTIONS: RefineItem[] = [
  { id: "refine", label: "Refine", description: "Describe what to keep, drop, or rank first" },
]

export type RefineOptions = TriggerExtensionOptions<RefineItem>

function findRefineMatch(config: {
  char: string
  allowSpaces: boolean
  allowedPrefixes: string[] | null
  startOfLine: boolean
  $position: import("@tiptap/pm/model").ResolvedPos
}) {
  const { $position } = config
  const textBefore = getParentTextBefore($position)

  // `/` at the start, after whitespace, or after the quick switcher's `?` prefix.
  const match = textBefore.match(/(?:^|\s|\?)(\/)(\S*)$/)
  if (!match) return null

  const fullMatch = match[0]
  const query = match[2] || ""
  // Only a prefix of "refine" opens the popup; `/tmp` or `/etc/hosts` stays plain text.
  if (!"refine".startsWith(query.toLowerCase())) return null
  const matchStart = $position.pos - fullMatch.length + (fullMatch.startsWith(" ") ? 1 : 0)

  return {
    range: { from: matchStart, to: $position.pos },
    query,
    text: match[1] + query,
  }
}

export const RefineExtension = Extension.create<RefineOptions>({
  name: "refine",

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
        pluginKey: RefinePluginKey,
        char: "/",
        allowSpaces: false,
        findSuggestionMatch: findRefineMatch,
        ...this.options.suggestion,
        command: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).insertContent("/refine ").run()
        },
      }),
    ]
  },
})
