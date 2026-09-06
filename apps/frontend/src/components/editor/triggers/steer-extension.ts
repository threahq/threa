/**
 * TipTap extension for the `/steer` trigger in search mode. Typing `/` at a
 * word boundary offers "Steer"; picking it inserts `/steer ` and the prose
 * that follows becomes a refinement of the result list once committed.
 */
import { Extension } from "@tiptap/core"
import Suggestion from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"
import { getParentTextBefore } from "../markdown-guards"
import type { TriggerExtensionOptions } from "./create-trigger-extension"

export const SteerPluginKey = new PluginKey("steer")

export interface SteerItem {
  id: string
  label: string
  description: string
}

export const STEER_OPTIONS: SteerItem[] = [
  { id: "steer", label: "Steer", description: "Describe what to keep, drop, or rank first" },
]

export type SteerOptions = TriggerExtensionOptions<SteerItem>

function findSteerMatch(config: {
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
  // Only a prefix of "steer" opens the popup; `/tmp` or `/etc/hosts` stays plain text.
  if (!"steer".startsWith(query.toLowerCase())) return null
  const matchStart = $position.pos - fullMatch.length + (fullMatch.startsWith(" ") ? 1 : 0)

  return {
    range: { from: matchStart, to: $position.pos },
    query,
    text: match[1] + query,
  }
}

export const SteerExtension = Extension.create<SteerOptions>({
  name: "steer",

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
        pluginKey: SteerPluginKey,
        char: "/",
        allowSpaces: false,
        findSuggestionMatch: findSteerMatch,
        ...this.options.suggestion,
        command: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).insertContent("/steer ").run()
        },
      }),
    ]
  },
})
