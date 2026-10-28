import type { Editor, Range } from "@tiptap/core"
import { PluginKey, TextSelection } from "@tiptap/pm/state"
import { createInlineSearchExtension, type InlineSearchOptions } from "./inline-search-extension"
import { isNewDoc, type DocSuggestionItem, type NewDocItem } from "./use-doc-suggestion"

export const DocCreatePluginKey = new PluginKey("docCreate")

type DocCreateItem = DocSuggestionItem | NewDocItem

export type DocCreateOptions = InlineSearchOptions<DocCreateItem>

interface CreatedDoc {
  id: string
  displayName: string | null
}

/**
 * `/doc [title]`: creates a doc titled from the query, or links one of the docs already carrying that title.
 * "New doc" is taken over by `takeOverNewDoc`, which links the doc through `linkNewDoc` once it exists.
 */
export const DocCreateExtension = createInlineSearchExtension<DocCreateItem>({
  name: "docCreate",
  trigger: "/doc",
  pluginKey: DocCreatePluginKey,
  insert: (chain, item) =>
    isNewDoc(item) ? chain : chain.insertDocEmbed({ docId: item.id, title: item.displayName ?? "" }),
}).extend({
  addStorage() {
    return { ...this.parent?.(), pending: false }
  },
})

const docCreateStorage = (editor: Editor) =>
  (editor.storage as unknown as Record<string, { pending?: boolean } | undefined>).docCreate

/** A `/doc` pick is still creating its doc, so sending now would send the typed trigger instead of the chip. */
export const isDocCreatePending = (editor: Editor) => docCreateStorage(editor)?.pending === true

const currentMatch = (editor: Editor) =>
  DocCreatePluginKey.getState(editor.state) as { active: boolean; range: Range; text: string } | undefined

/**
 * Waits for `create` with the typed `/doc` left in place, then swaps the doc's chip in for the trigger as it reads
 * now, so whatever was synced meanwhile can't misplace it. Text typed after the title stays after the chip; a
 * trigger that was edited, sent, undone or dismissed links nothing. Resolves to the created doc, linked or not.
 */
export async function linkNewDoc(editor: Editor, create: () => Promise<CreatedDoc | null>) {
  const picked = currentMatch(editor)?.text
  const storage = docCreateStorage(editor)
  if (storage) storage.pending = true
  try {
    const doc = await create()
    const match = currentMatch(editor)
    if (!doc || editor.isDestroyed || !picked || !match?.active || !titleUnchanged(match.text, picked)) return doc
    const { from } = match.range
    // The chip brings its own trailing space, so a space typed after the title is folded into it.
    const to = from + picked.length + (match.text.startsWith(" ", picked.length) ? 1 : 0)
    const caret = editor.state.selection.to
    editor
      .chain()
      .setTextSelection({ from, to })
      .insertDocEmbed({ docId: doc.id, title: doc.displayName ?? "" })
      .command(({ tr }) => {
        tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(caret)))
        return true
      })
      .run()
    return doc
  } finally {
    if (storage) storage.pending = false
  }
}

/** The picked title still reads the same, maybe followed by more words: `/doc Q4` then `/doc Q4 notes`, not `/doc Q4x`. */
const titleUnchanged = (text: string, picked: string) =>
  text.startsWith(picked) && (text.length === picked.length || /\s/.test(text[picked.length]))

/**
 * The picker's `takeOver` for "New doc": creates the doc, links it in place of the typed trigger, then opens it. The
 * open waits for the link because it can close the pane the trigger was typed in. While a create is pending every
 * pick is swallowed, so a listed match can't take the trigger the new doc is waiting to replace.
 */
export function takeOverNewDoc(
  create: (title: string) => Promise<CreatedDoc | null>,
  open: (docId: string) => void
): NonNullable<DocCreateOptions["takeOver"]> {
  return ({ editor, item }) => {
    if (isDocCreatePending(editor)) return true
    if (!isNewDoc(item)) return false
    void linkNewDoc(editor, () => create(item.title)).then((doc) => doc && open(doc.id))
    return true
  }
}
