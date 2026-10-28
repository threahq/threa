import { PluginKey } from "@tiptap/pm/state"
import type { Memo } from "@threahq/types"
import { createInlineSearchExtension, type InlineSearchOptions } from "./inline-search-extension"

export const MemoSearchPluginKey = new PluginKey("memoSearch")

export type MemoSearchOptions = InlineSearchOptions<Memo>

/** `/memos <query>`: picks a memo from workspace memory and inserts an inline `memoEmbed` chip. */
export const MemoSearchExtension = createInlineSearchExtension<Memo>({
  name: "memoSearch",
  trigger: "/memos",
  pluginKey: MemoSearchPluginKey,
  insert: (chain, memo) => chain.insertMemoEmbed({ memoId: memo.id, title: memo.title }),
})
