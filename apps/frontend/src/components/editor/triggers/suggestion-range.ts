import type { Editor } from "@tiptap/react"
import type { PluginKey } from "@tiptap/pm/state"

export interface SuggestionRange {
  from: number
  to: number
}

/**
 * The range a pick replaces.
 *
 * A popup is rendered from a snapshot, so the range it hands back is one
 * transaction stale the moment anything else edits the doc first — a phone
 * keyboard's word-correction landing under the finger rewrites `:smi` to
 * `: smile`, and the snapshot's range then cuts the wrong four characters,
 * leaving `ile` behind next to the emoji. The plugin recomputes its own range
 * on every transaction, so while the suggestion is still running that one is
 * current; once it has ended there is nothing better than the snapshot.
 */
export function currentSuggestionRange(
  pluginKey: PluginKey,
  editor: Editor,
  snapshot: SuggestionRange
): SuggestionRange {
  const state = pluginKey.getState(editor.state) as { active?: boolean; range?: SuggestionRange } | undefined
  return state?.active === true && state.range ? state.range : snapshot
}
