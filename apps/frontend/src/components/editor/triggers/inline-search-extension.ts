/**
 * Factory for mid-sentence search triggers like `/memo <query>` and `/doc <query>`.
 *
 * The query may contain spaces, so a custom `findSuggestionMatch` captures
 * everything after the trigger and its space rather than stopping at the first
 * whitespace. A bare trigger (no trailing space yet) is left to the slash
 * palette, which offers a discovery entry for it, so the two surfaces never both
 * open; the picker takes over once a space follows, which is also how the
 * palette hands off. Picking a result deletes the typed trigger and runs the
 * caller's insert command in its place, so the caret's marks carry over.
 */
import { Extension, type ChainedCommands } from "@tiptap/core"
import Suggestion from "@tiptap/suggestion"
import type { PluginKey } from "@tiptap/pm/state"
import type { ResolvedPos } from "@tiptap/pm/model"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import { getParentTextBefore } from "../markdown-guards"
import { showOnTypingOnly } from "./keyboard-correction-match"

export interface InlineSearchOptions<T> {
  suggestion: {
    items: (props: { query: string }) => T[] | Promise<T[]>
    render: () => {
      onStart: (props: SuggestionProps<T>) => void
      onUpdate: (props: SuggestionProps<T>) => void
      onExit: (props: SuggestionProps<T>) => void
      onKeyDown: (props: SuggestionKeyDownProps) => boolean
    }
  }
}

interface InlineSearchConfig<T> {
  name: string
  /** The typed trigger, e.g. `/memo`; used verbatim in a RegExp, so no metacharacters. */
  trigger: string
  pluginKey: PluginKey
  /** Inserts the picked item at the caret, chained after the trigger is deleted. */
  insert: (chain: ChainedCommands, item: T) => ChainedCommands
}

export function createInlineSearchExtension<T>({ name, trigger, pluginKey, insert }: InlineSearchConfig<T>) {
  // The trigger at a word boundary, then a REQUIRED separating space + the
  // (possibly multi-word) query up to the caret.
  const pattern = new RegExp(`(?:^|\\s)${trigger}[ \\t](.*)$`)

  const findMatch = ({ $position }: { $position: ResolvedPos }) => {
    const match = getParentTextBefore($position).match(pattern)
    if (!match) return null

    const fullMatch = match[0]
    const text = fullMatch.trimStart()
    const leading = fullMatch.length - text.length
    return {
      range: { from: $position.pos - fullMatch.length + leading, to: $position.pos },
      query: match[1] ?? "",
      text,
    }
  }

  return Extension.create<InlineSearchOptions<T>>({
    name,

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

    addProseMirrorPlugins() {
      return [
        Suggestion<T>({
          editor: this.editor,
          pluginKey,
          char: trigger,
          allowSpaces: true,
          startOfLine: false,
          findSuggestionMatch: findMatch,
          shouldShow: showOnTypingOnly(pluginKey, this.editor),
          // Suppressed inside code blocks and inline code (mirrors createTriggerExtension).
          // A backtick directly before the trigger can't match: the pattern needs whitespace or block start.
          allow: ({ state, range }) => {
            const $from = state.doc.resolve(range.from)
            for (let depth = $from.depth; depth >= 0; depth--) {
              if ($from.node(depth).type.name === "codeBlock") return false
            }
            const marks = state.storedMarks ?? $from.marks()
            return !marks.some((mark) => mark.type.name === "code")
          },
          ...this.options.suggestion,
          command: ({ editor, range, props }) => {
            // Removing the typed trigger clears the suggestion match, so the plugin
            // fires `onExit` and the popup closes instead of lingering.
            insert(editor.chain().focus().deleteRange(range), props as T).run()
          },
        }),
      ]
    },
  })
}
