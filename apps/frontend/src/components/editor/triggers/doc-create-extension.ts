import { PluginKey } from "@tiptap/pm/state"
import { createInlineSearchExtension, type InlineSearchOptions } from "./inline-search-extension"
import { isNewDoc, type DocSuggestionItem, type NewDocItem } from "./use-doc-suggestion"

export const DocCreatePluginKey = new PluginKey("docCreate")

export type DocCreateOptions = InlineSearchOptions<DocSuggestionItem | NewDocItem>

/**
 * `/doc [title]`: creates a doc titled from the query, or links one of the docs already carrying that title.
 * A new doc's chip lands once the doc exists, through the `onPick` that `useDocCreateSuggestion` supplies.
 */
export const DocCreateExtension = createInlineSearchExtension<DocSuggestionItem | NewDocItem>({
  name: "docCreate",
  trigger: "/doc",
  pluginKey: DocCreatePluginKey,
  insert: (chain, item) =>
    isNewDoc(item) ? chain : chain.insertDocEmbed({ docId: item.id, title: item.displayName ?? "" }),
})
