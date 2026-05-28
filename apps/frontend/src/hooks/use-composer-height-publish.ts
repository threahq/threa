import { useEffect, useRef } from "react"
import { persistComposerHeight } from "@/lib/composer-height-storage"

interface UseComposerHeightPublishOptions {
  active?: boolean
  /**
   * Fired whenever the published height *changes* from a previously-measured
   * value (never on the initial measurement). The timeline uses this to
   * re-anchor a virtualized list to the bottom: the footer spacer that keeps
   * the last message above the composer is sized from `--composer-height`, but
   * Virtuoso's scroll position is frozen when that spacer grows (its
   * `followOutput` only reacts to new items, and its resize safety-net only
   * watches the scroller's own height — not footer growth). Without this
   * notification a composer that settles taller a few frames after a message
   * lands (the 200ms height transition, async encryption notice / attachment
   * chips) covers the bottom of the last message until the next reload.
   */
  onHeightChange?: (px: number) => void
}

/**
 * Measures the element referenced by `ref` and publishes its height (in px) as
 * `--composer-height` on the nearest `[data-editor-zone]` ancestor. Scrollable
 * siblings inside the same editor zone can consume the variable (e.g.
 * plain-scroll `padding-bottom`) to reserve space for the floating composer
 * pill.
 *
 * Pass `active: false` (e.g. while the expand-to-fullscreen overlay is open)
 * to disconnect the observer. The CSS variable is intentionally *not* cleared
 * on cleanup so that stream navigation preserves the last-known height; the
 * next composer mount overwrites it with its own measurement. The same value
 * is also mirrored to localStorage so the next hard refresh starts with a
 * sensible global default on `:root` instead of falling back to 0px — that
 * fallback grew the timeline's footer spacer mid-paint and caused Virtuoso
 * to shift content up on every reload.
 */
export function useComposerHeightPublish(
  ref: React.RefObject<HTMLElement | null>,
  { active = true, onHeightChange }: UseComposerHeightPublishOptions = {}
): void {
  // Held in a ref so a new callback identity each render doesn't tear down and
  // re-create the ResizeObserver (which would re-fire the initial measure).
  const onHeightChangeRef = useRef(onHeightChange)
  onHeightChangeRef.current = onHeightChange

  useEffect(() => {
    const el = ref.current
    if (!el || !active) return

    const zone = el.closest<HTMLElement>("[data-editor-zone]")
    if (!zone) return

    let lastPublished: number | null = null

    const write = (h: number) => {
      const px = Math.ceil(h)
      zone.style.setProperty("--composer-height", `${px}px`)
      persistComposerHeight(px)
      // Only notify on an actual change from an already-established height —
      // the initial measure just seeds the baseline (the footer spacer is
      // already sized for it via the persisted `:root` fallback).
      if (lastPublished !== null && px !== lastPublished) onHeightChangeRef.current?.(px)
      lastPublished = px
    }

    write(el.getBoundingClientRect().height)

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      const h = entry?.borderBoxSize?.[0]?.blockSize ?? entry?.contentRect.height ?? el.getBoundingClientRect().height
      write(h)
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      // Intentionally leave --composer-height set so stream navigation
      // starts with a reasonable approximation instead of falling back to 0px.
    }
  }, [ref, active])
}
