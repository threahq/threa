import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

/**
 * CSS variable the floating inline composer publishes its shell height to (on
 * the anchor element), so the anchor's scrollable content can reserve bottom
 * space while the composer is open — same contract as the stream page's
 * `--composer-height`, but transient: cleared when the composer closes.
 */
export const FLOATING_COMPOSER_HEIGHT_VAR = "--floating-composer-height"

interface FloatingComposerAnchor {
  /** Positioned container the floating composer shell portals into. */
  el: HTMLElement
  /** Form currently owning the floating slot (one per anchor). */
  claimantId: string | null
  claim: (id: string) => void
  release: (id: string) => void
}

const FloatingComposerAnchorContext = createContext<FloatingComposerAnchor | null>(null)

/**
 * Marks a positioned container as the floating-composer slot for the inline
 * composer surfaces below it. On mobile an open `InlineComposerForm` portals
 * into the anchor inside the shared `FloatingComposerShell` — the same pill the
 * stream composer uses — instead of expanding in place mid-scroll, so it pins
 * to the visible bottom and rides above the keyboard
 * (`interactive-widget=resizes-content` resizes the layout viewport). Desktop
 * surfaces ignore the anchor and keep their in-place composers.
 *
 * The claimant id keeps the slot exclusive: opening a second composer under the
 * same anchor collapses the first back to its resting affordance (its draft
 * persists via the per-target draft key).
 */
export function FloatingComposerAnchorProvider({ el, children }: { el: HTMLElement | null; children: ReactNode }) {
  const [claimantId, setClaimantId] = useState<string | null>(null)
  const claim = useCallback((id: string) => setClaimantId(id), [])
  const release = useCallback((id: string) => setClaimantId((current) => (current === id ? null : current)), [])
  const value = useMemo<FloatingComposerAnchor | null>(
    () => (el ? { el, claimantId, claim, release } : null),
    [el, claimantId, claim, release]
  )
  return <FloatingComposerAnchorContext.Provider value={value}>{children}</FloatingComposerAnchorContext.Provider>
}

export function useFloatingComposerAnchor(): FloatingComposerAnchor | null {
  return useContext(FloatingComposerAnchorContext)
}
