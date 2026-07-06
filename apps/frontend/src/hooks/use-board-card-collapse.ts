import { useCallback } from "react"
import { composeBlockCollapseKey } from "@/lib/markdown/markdown-block-context"
import { setBlockCollapse, useBlockCollapseStore } from "@/lib/markdown/collapse-cache"

export interface BoardCardCollapseState {
  collapsed: boolean
  toggle: () => void
}

/**
 * Whole-card fold state, persisted per conversation through the same
 * localStorage-primary collapse cache the markdown blocks use (synchronous first
 * paint, per-tab, survives reload). Keyed by conversation id under the
 * `board-card` block kind; there's no content hash — a card is one fold, not
 * per-block.
 *
 * `collapsedByDefault` is the caller's measured "this card is tall" decision (see
 * `BoardCard`), used only when the user hasn't toggled this card. An explicit
 * toggle persists an override that always wins over the default.
 */
export function useBoardCardCollapse(conversationId: string, collapsedByDefault: boolean): BoardCardCollapseState {
  const key = composeBlockCollapseKey(conversationId, "board-card", "")
  const persisted = useBlockCollapseStore(key)
  const collapsed = persisted ?? collapsedByDefault

  const toggle = useCallback(() => {
    setBlockCollapse(key, conversationId, "board-card", !collapsed)
  }, [key, conversationId, collapsed])

  return { collapsed, toggle }
}
