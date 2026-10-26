import { PluginKey } from "@tiptap/pm/state"
import { createInlineSearchExtension, type InlineSearchOptions } from "./inline-search-extension"
import type { DocSuggestionItem } from "./use-doc-suggestion"

export const DocSearchPluginKey = new PluginKey("docSearch")

export type DocSearchOptions = InlineSearchOptions<DocSuggestionItem>

/** `/doc <query>`: picks a workspace doc and inserts an inline `docEmbed` chip. */
export const DocSearchExtension = createInlineSearchExtension<DocSuggestionItem>({
  name: "docSearch",
  trigger: "/doc",
  pluginKey: DocSearchPluginKey,
  insert: (chain, doc) => chain.insertDocEmbed({ docId: doc.id, title: doc.displayName ?? "" }),
})
