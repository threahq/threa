import { createContext, useContext, useEffect, type MutableRefObject } from "react"

/**
 * Two-way bridge between MessageComposer and the stashed-drafts picker it
 * hosts as a slot node, so the signal travels by context:
 *
 *  - composer → picker: Cmd/Ctrl+S on an EMPTY composer opens the drafts
 *    popover (nothing to stash, so the shortcut flips to "show me my drafts").
 *    The picker registers its `open` into `openRef`; the composer's stash key
 *    handler calls it.
 *  - picker → composer: after a restore, focus follows the restored content —
 *    the picker calls `focusComposer` (editor focus lands at the end of the
 *    doc; see applyExternalEditorContent for the caret staying at the end once
 *    the async rehydrate delivers the body).
 *
 * Null outside a composer that wires the bridge.
 */
export interface StashedDraftsComposerBridge {
  openRef: MutableRefObject<(() => void) | null>
  /** The scheduled-messages picker's `open`, for the folded phone foot whose
   *  Schedule row lives in the Aa popover while the picker stays a slot node. */
  openScheduledRef: MutableRefObject<(() => void) | null>
  /**
   * How many sends the scheduled picker is holding, published upward because
   * the phone foot hides the picker's own trigger (dot and all) and shows the
   * presence on its "+" instead. Reactive (state, not a ref): the "+"
   * re-renders on it.
   */
  reportScheduledCount: (count: number) => void
  focusComposer: () => void
}

export const StashedDraftsComposerBridgeContext = createContext<StashedDraftsComposerBridge | null>(null)

export function useStashedDraftsBridge(): StashedDraftsComposerBridge | null {
  return useContext(StashedDraftsComposerBridgeContext)
}

export function useRegisterStashedDraftsOpen(open: () => void) {
  const bridge = useStashedDraftsBridge()
  useEffect(() => {
    if (!bridge) return
    bridge.openRef.current = open
    return () => {
      if (bridge.openRef.current === open) bridge.openRef.current = null
    }
  }, [bridge, open])
}

export function useReportScheduledCount(count: number) {
  const bridge = useStashedDraftsBridge()
  useEffect(() => {
    if (!bridge) return
    bridge.reportScheduledCount(count)
    return () => bridge.reportScheduledCount(0)
  }, [bridge, count])
}

export function useRegisterScheduledMessagesOpen(open: () => void) {
  const bridge = useStashedDraftsBridge()
  useEffect(() => {
    if (!bridge) return
    bridge.openScheduledRef.current = open
    return () => {
      if (bridge.openScheduledRef.current === open) bridge.openScheduledRef.current = null
    }
  }, [bridge, open])
}
