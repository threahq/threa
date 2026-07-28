import { useLayoutEffect, useRef, type RefObject } from "react"
import { FLOATING_COMPOSER_HEIGHT_VAR } from "./floating-composer-anchor"

interface UseFloatingComposerHeightOptions {
  /** Anchor element the height is published on (the positioned slot container). */
  anchorEl: HTMLElement | null | undefined
  /** Identity written to `dataset.floatingComposerOwner` while this shell owns the slot. */
  ownerId: string
  /** False while this shell does not hold the floating slot — the effect no-ops. */
  active: boolean
  /**
   * Fired for the first measurement of this mount (`initial: true`, inside the
   * layout effect, before paint) and afterwards whenever the published height
   * changes. Same contract as `useComposerHeightPublish`, so a surface can
   * re-pin its scroller without touching `:root`.
   */
  onHeightChange?: (px: number, opts: { initial: boolean }) => void
}

/**
 * Publishes a floating composer shell's height to
 * {@link FLOATING_COMPOSER_HEIGHT_VAR} on the anchor, so the anchor's scrollable
 * content can reserve bottom space while the composer floats over it.
 *
 * Ownership-tagged: during a slot hand-off the outgoing form unmounts after the
 * incoming one has already measured, and must not wipe the incoming form's
 * value. A measured height of 0 (a hidden shell) is never written for the same
 * reason.
 */
export function useFloatingComposerHeight({
  anchorEl,
  ownerId,
  active,
  onHeightChange,
}: UseFloatingComposerHeightOptions): RefObject<HTMLDivElement | null> {
  const shellRef = useRef<HTMLDivElement>(null)
  // Held in a ref so a new callback identity each render doesn't tear down and
  // re-create the ResizeObserver (which would re-fire the initial measure).
  const onHeightChangeRef = useRef(onHeightChange)
  onHeightChangeRef.current = onHeightChange
  // Per-mount, not per-activation: the slot is claimed and released repeatedly
  // (mobile branch composer, new sub-topic), and consumers treat `initial` as a
  // licence to force-scroll. Only the first published measurement of this
  // mount's lifetime may carry it.
  const hasPublished = useRef(false)

  useLayoutEffect(() => {
    if (!active || !anchorEl) return
    const shell = shellRef.current
    if (!shell) return

    let lastPublished: number | null = null
    let isInitialMeasure = true

    const write = () => {
      const px = Math.ceil(shell.getBoundingClientRect().height)
      // A later 0 is a shell on its way out (a hand-off collapsing this pill) —
      // writing it would wipe the incoming owner's reservation. The first
      // measurement still publishes: this effect only runs while the shell holds
      // the slot, so there is no value of anyone else's to clobber.
      if (px <= 0 && lastPublished !== null) return
      anchorEl.style.setProperty(FLOATING_COMPOSER_HEIGHT_VAR, `${px}px`)
      anchorEl.dataset.floatingComposerOwner = ownerId
      if (isInitialMeasure || px !== lastPublished) {
        onHeightChangeRef.current?.(px, { initial: isInitialMeasure && !hasPublished.current })
      }
      lastPublished = px
      isInitialMeasure = false
      hasPublished.current = true
    }

    write()
    const ro = new ResizeObserver(write)
    ro.observe(shell)
    return () => {
      ro.disconnect()
      if (anchorEl.dataset.floatingComposerOwner === ownerId) {
        anchorEl.style.removeProperty(FLOATING_COMPOSER_HEIGHT_VAR)
        delete anchorEl.dataset.floatingComposerOwner
      }
    }
  }, [active, anchorEl, ownerId])

  return shellRef
}
