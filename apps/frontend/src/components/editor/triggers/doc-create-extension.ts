import type { Editor, Range } from "@tiptap/core"
import { PluginKey } from "@tiptap/pm/state"
import { createInlineSearchExtension, type InlineSearchOptions } from "./inline-search-extension"
import { isNewDoc, type DocSuggestionItem, type NewDocItem } from "./use-doc-suggestion"

export const DocCreatePluginKey = new PluginKey("docCreate")

export type DocCreateOptions = InlineSearchOptions<DocSuggestionItem | NewDocItem>

/**
 * `/doc [title]`: creates a doc titled from the query, or links one of the docs already carrying that title.
 * "New doc" is taken over by `useDocCreateSuggestion`, which links the doc through `linkNewDoc` once it exists.
 */
export const DocCreateExtension = createInlineSearchExtension<DocSuggestionItem | NewDocItem>({
  name: "docCreate",
  trigger: "/doc",
  pluginKey: DocCreatePluginKey,
  insert: (chain, item) =>
    isNewDoc(item) ? chain : chain.insertDocEmbed({ docId: item.id, title: item.displayName ?? "" }),
})

const pendingCreates = new WeakSet<Editor>()

/** A `/doc` pick is still creating its doc, so sending now would send the typed trigger instead of the chip. */
export const isDocCreatePending = (editor: Editor) => pendingCreates.has(editor)

const currentMatch = (editor: Editor) =>
  DocCreatePluginKey.getState(editor.state) as { active: boolean; range: Range; text: string } | undefined

/**
 * Waits for `create` with the typed `/doc` left in place, then swaps the doc's chip in for the trigger as it reads
 * now, so whatever was synced meanwhile can't misplace it. Text typed after the trigger stays after the chip; a
 * trigger that was edited, sent, undone or dismissed links nothing, and neither does a doc that wasn't created.
 */
export async function linkNewDoc(
  editor: Editor,
  create: () => Promise<{ id: string; displayName: string | null } | null>
) {
  const picked = currentMatch(editor)?.text
  pendingCreates.add(editor)
  try {
    const doc = await create()
    const match = currentMatch(editor)
    if (!doc || editor.isDestroyed || !picked || !match?.active || !match.text.startsWith(picked)) return
    const { from } = match.range
    // The chip brings its own trailing space, so a space typed after the title is folded into it.
    const to = from + picked.length + (match.text.startsWith(" ", picked.length) ? 1 : 0)
    const caret = editor.state.selection.to
    const chipSize = 2
    editor
      .chain()
      .setTextSelection({ from, to })
      .insertDocEmbed({ docId: doc.id, title: doc.displayName ?? "" })
      .setTextSelection(caret >= to ? caret - (to - from) + chipSize : from + chipSize)
      .run()
  } finally {
    pendingCreates.delete(editor)
  }
}
