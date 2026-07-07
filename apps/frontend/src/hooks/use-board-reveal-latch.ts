import { useRef } from "react"

/**
 * Latch the board's first-paint reveal. The board holds its first paint until the
 * above-fold card rails and the conversation graph are warm, so a card's first
 * frame is its final frame (no pop-in). That gate re-evaluates continuously,
 * though: adding a conversation drops a brand-new, still-cold stream into the
 * prewarm set, flipping `revealReadyNow` false — which, ungated, un-reveals and
 * BLANKS the whole feed for the beat until that one rail resolves (the "adding a
 * conversation flashes the board" bug).
 *
 * This latch holds the reveal once it has ever been ready: after the feed has
 * painted, a later cold rail can't un-paint it — the individual card handles its
 * own cold load via its projection fallback and pops in where it belongs. Resets
 * only on a workspace switch (a genuinely new board that should gate afresh).
 */
export function useBoardRevealLatch(revealReadyNow: boolean, workspaceId: string): boolean {
  const hasRevealedRef = useRef(false)
  const workspaceRef = useRef(workspaceId)
  if (workspaceRef.current !== workspaceId) {
    workspaceRef.current = workspaceId
    hasRevealedRef.current = false
  }
  if (revealReadyNow) hasRevealedRef.current = true
  return revealReadyNow || hasRevealedRef.current
}
