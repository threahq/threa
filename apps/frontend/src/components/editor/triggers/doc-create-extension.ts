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

/**
 * Waits for `create` with the typed `/doc` left in place, then swaps the doc's chip in for the trigger as it reads
 * now, so whatever was typed or synced meanwhile can't misplace it. Links nothing when the doc wasn't created or the
 * trigger is gone (sent, undone, dismissed).
 */
export async function linkNewDoc(
  editor: Editor,
  create: () => Promise<{ id: string; displayName: string | null } | null>
) {
  const doc = await create()
  if (!doc || editor.isDestroyed) return
  const match = DocCreatePluginKey.getState(editor.state) as { active: boolean; range: Range } | undefined
  if (!match?.active) return
  editor
    .chain()
    .deleteRange(match.range)
    .insertDocEmbed({ docId: doc.id, title: doc.displayName ?? "" })
    .run()
}
