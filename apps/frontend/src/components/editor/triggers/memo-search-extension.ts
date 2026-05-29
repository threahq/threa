/**
 * TipTap extension for the inline `/memo <query>` search trigger.
 *
 * Unlike the `/` slash-command (a start-of-line command palette), this fires
 * mid-sentence: typing `/memo auth rewrite` opens a memo picker backed by the
 * same keyword + semantic search as the memory explorer. Picking a result
 * deletes the typed trigger and inserts an inline `memoEmbed` chip in its place.
 *
 * The query may contain spaces, so a custom `findSuggestionMatch` captures
 * everything after `/memo ` rather than stopping at the first whitespace. A
 * bare `/memo` (no trailing space yet) is left to the slash-command palette —
 * which now fires mid-sentence too and offers a "memo" discovery entry — so the
 * two surfaces never both open. Memo-search takes over once a space follows
 * (`/memo ` or `/memo <query>`), which is also how the palette hands off.
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

// `/memo` at a word boundary, then a REQUIRED separating space + the (possibly
// multi-word) query up to the caret. The space is mandatory so a bare `/memo`
// (no trailing space yet) defers to the slash palette — only `/memo ` and
// `/memo <query>` activate the picker here, avoiding a double popover.
const MEMO_TRIGGER = /(?:^|\s)\/memo[ \t](.*)$/

function findMemoSearchMatch(config: { $position: ResolvedPos }) {
  const { $position } = config
  const textBefore = getParentTextBefore($position)

  const match = textBefore.match(MEMO_TRIGGER)
  if (!match) return null

  const fullMatch = match[0]
  const trigger = fullMatch.trimStart() // "/memo <query>" without the leading boundary char
  const leading = fullMatch.length - trigger.length

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
        // A literal backtick directly before `/memo` (`` `/memo`` ) can't match the
        // trigger anyway — MEMO_TRIGGER requires whitespace or block-start before
        // `/memo`, and a backtick is neither.
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
