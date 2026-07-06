import { useCallback, useRef } from "react"
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
 * The default (no persisted override) is captured once at first render, so a
 * card that grows past the threshold while on screen does NOT retroactively fold
 * under the eye — only a fresh mount re-reads the default. An explicit toggle
 * always wins over the default.
 */
export function useBoardCardCollapse(conversationId: string, collapsedByDefault: boolean): BoardCardCollapseState {
  const key = composeBlockCollapseKey(conversationId, "board-card", "")
  const persisted = useBlockCollapseStore(key)
  const initialDefaultRef = useRef(collapsedByDefault)
  const collapsed = persisted ?? initialDefaultRef.current

  const toggle = useCallback(() => {
    setBlockCollapse(key, conversationId, "board-card", !collapsed)
  }, [key, conversationId, collapsed])

  return { collapsed, toggle }
}
