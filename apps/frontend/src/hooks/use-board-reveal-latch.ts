import { useLayoutEffect, useRef } from "react"

/**
 * Latch the board's first-paint reveal. The board holds its first paint until the
 * above-fold card rails and the conversation graph are warm, so a card's first
 * frame is its final frame (no pop-in). That gate re-evaluates continuously,
 * though: adding a conversation drops a brand-new, still-cold stream into the
 * prewarm set, flipping `revealReadyNow` false — which, ungated, un-reveals and
 * BLANKS the whole feed for the beat until that one rail resolves (the "adding a
 * conversation flashes the board" bug).
 *
 * This latch holds the reveal once it has ever committed a ready state: after the
 * feed has painted, a later cold rail can't un-paint it — the individual card
 * handles its own cold load via its projection fallback and pops in where it
 * belongs. Resets only on a workspace switch (a genuinely new board that should
 * gate afresh).
 */
export function useBoardRevealLatch(revealReadyNow: boolean, workspaceId: string): boolean {
  const hasRevealedRef = useRef(false)
  const workspaceRef = useRef(workspaceId)
  // The workspace-switch reset stays in render: it is idempotent and keyed on the
  // id, so a concurrent double-render can't corrupt it (the same carve-out
  // use-timeline-scroll makes for its stream-switch reset).
  if (workspaceRef.current !== workspaceId) {
    workspaceRef.current = workspaceId
    hasRevealedRef.current = false
  }
  // Commit the latch in a layout effect, NEVER during render. A render that
  // observes `revealReadyNow` true but is discarded before commit (StrictMode /
  // a concurrent interrupt) must not leave the ref latched for a later committed
  // render — the reveal only counts once it actually paints. The current render
  // still reveals via the `revealReadyNow` term below the instant it's ready; the
  // ref just carries that forward once it has committed. (Same rule the sibling
  // scroll/rail hooks follow — mutating a ref during render is unsafe here.)
  useLayoutEffect(() => {
    if (revealReadyNow) hasRevealedRef.current = true
  }, [revealReadyNow, workspaceId])
  return revealReadyNow || hasRevealedRef.current
}
