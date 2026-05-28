/**
 * TipTap extension for the inline `/memo <query>` search trigger.
 *
 * Unlike the `/` slash-command (a start-of-line command palette), this fires
 * mid-sentence: typing `/memo auth rewrite` opens a memo picker backed by the
 * same keyword + semantic search as the memory explorer. Picking a result
 * deletes the typed trigger and inserts an inline `memoEmbed` chip in its place.
 *
 * The query may contain spaces, so a custom `findSuggestionMatch` captures
 * everything after `/memo ` rather than stopping at the first whitespace. The
 * trailing space after `/memo` is optional so the trigger fires mid-sentence on
 * a bare `/memo`, while a bare `/memo` at the very start of a block is left to
 * the slash-command palette (which offers a "memo" discovery entry).
 */
import { Extension } from "@tiptap/core"
import Suggestion from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"
import type { ResolvedPos } from "@tiptap/pm/model"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import type { Memo } from "@threa/types"
import { getParentTextBefore } from "../markdown-guards"

export const MemoSearchPluginKey = new PluginKey("memoSearch")

export interface MemoSearchOptions {
  suggestion: {
    items: (props: { query: string }) => Memo[] | Promise<Memo[]>
    render: () => {
      onStart: (props: SuggestionProps<Memo>) => void
      onUpdate: (props: SuggestionProps<Memo>) => void
      onExit: (props: SuggestionProps<Memo>) => void
      onKeyDown: (props: SuggestionKeyDownProps) => boolean
    }
  }
}

// `/memo` at a word boundary, then an optional separating space + the (possibly
// multi-word) query up to the caret. The trailing space/query group is optional
// so a bare `/memo` mid-sentence still matches.
const MEMO_TRIGGER = /(?:^|\s)\/memo(?:[ \t](.*))?$/

function findMemoSearchMatch(config: { $position: ResolvedPos }) {
  const { $position } = config
  const textBefore = getParentTextBefore($position)

  const match = textBefore.match(MEMO_TRIGGER)
  if (!match) return null

  const fullMatch = match[0]
  const trigger = fullMatch.trimStart() // "/memo <query>" without the leading boundary char
  const leading = fullMatch.length - trigger.length

  // A bare `/memo` at the very start of a block (no separating space yet) is
  // the slash-palette's discovery shortcut, not a live trigger — defer to it so
  // both surfaces don't fire at once. Mid-sentence bare `/memo` (preceded by
  // whitespace) and any `/memo ` with a space still activate here.
  const atBlockStart = leading === 0
  if (atBlockStart && match[1] === undefined) return null

  const query = match[1] ?? ""
  const matchStart = $position.pos - fullMatch.length + leading

  return {
    range: { from: matchStart, to: $position.pos },
    query,
    text: trigger,
  }
}

export const MemoSearchExtension = Extension.create<MemoSearchOptions>({
  name: "memoSearch",

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
      Suggestion<Memo>({
        editor: this.editor,
        pluginKey: MemoSearchPluginKey,
        char: "/memo",
        allowSpaces: true,
        startOfLine: false,
        findSuggestionMatch: findMemoSearchMatch,
        // Suppress inside code blocks / inline code (mirrors createTriggerExtension).
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
          const memo = props as Memo
          // Delete the typed trigger, drop the chip + a trailing space, and
          // refocus. Removing the `/memo …` text clears the suggestion match so
          // the plugin fires `onExit` and the popup closes (otherwise it lingers
          // open over a position where nothing can be typed).
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent([
              { type: "memoEmbed", attrs: { memoId: memo.id, title: memo.title } },
              { type: "text", text: " " },
            ])
            .run()
        },
      }),
    ]
  },
})
