import type { Editor } from "@tiptap/react"
import type { PluginKey } from "@tiptap/pm/state"

export interface SuggestionRange {
  from: number
  to: number
}

/**
 * The range a pick replaces.
 *
 * A popup is rendered from a snapshot, so the range it hands back goes stale
 * the moment anything else edits the doc first: a keyboard's word-correction
 * rewrites `:smi` to `: smile` under the finger, and the snapshot then cuts
 * four characters off the wrong place, leaving `ile` beside the emoji. The
 * plugin recomputes its range every transaction, so a running suggestion's
 * range is current; an ended one leaves nothing better than the snapshot.
 */
export function currentSuggestionRange(
  pluginKey: PluginKey,
  editor: Editor,
  snapshot: SuggestionRange
): SuggestionRange {
  const state = pluginKey.getState(editor.state) as { active?: boolean; range?: SuggestionRange } | undefined
  return state?.active === true && state.range ? state.range : snapshot
}
