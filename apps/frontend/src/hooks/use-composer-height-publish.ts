import { useLayoutEffect, useRef } from "react"
import { persistComposerHeight } from "@/lib/composer-height-storage"

interface UseComposerHeightPublishOptions {
  active?: boolean
  /**
   * Fired whenever the published height *changes* from the height the footer
   * spacer was last sized for — including the initial measurement when it
   * differs from what first paint rendered with (the persisted `:root`
   * fallback), but not when the first measurement matches that fallback. The
   * timeline uses this to re-anchor a virtualized list to the bottom: the
   * footer spacer that keeps the last message above the composer is sized from
   * `--composer-height`, but Virtuoso's scroll position is frozen when that
   * spacer resizes (its `followOutput` only reacts to new items, and its resize
   * safety-net only watches the scroller's own height — not footer growth).
   * Without this notification a composer that settles to a different height a
   * few frames after mount (the persisted default not matching the actual
   * composer, the 200ms height transition, async encryption notice / attachment
   * chips) leaves the last message hidden behind the composer — or the list
   * parked too high — until the next reload.
   *
   * `opts.initial` is true only for the very first measurement of this mount,
   * which runs inside a layout effect *before the browser paints*. The timeline
   * uses that to correct the approximate persisted footer height synchronously
   * (no visible jump) instead of debouncing — later, async runtime changes
   * arrive with `initial: false`.
   */
  onHeightChange?: (px: number, opts: { initial: boolean }) => void
}

/**
 * Measures the element referenced by `ref` and publishes its height (in px) as
 * `--composer-height` on the nearest `[data-editor-zone]` ancestor. Scrollable
 * siblings inside the same editor zone can consume the variable (e.g.
 * plain-scroll `padding-bottom`) to reserve space for the floating composer
 * pill.
 *
 * The first measurement runs in a layout effect (before paint) so the variable
 * and the timeline's bottom anchor can be corrected in the same frame the list
 * first reveals, rather than one paint later.
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

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !active) return

    const zone = el.closest<HTMLElement>("[data-editor-zone]")
    if (!zone) return
    let retryRafId = 0

    // Seed the baseline from the height the footer spacer is *currently*
    // rendered with: the persisted `:root` fallback applied at boot, or a value
    // a prior composer left on the zone. `getComputedStyle(zone)` resolves the
    // inherited value, so this matches what `var(--composer-height)` paints
    // with right now. When the first real measurement differs from this — the
    // persisted default didn't match the actual composer (density/zoom change,
    // a restored multi-line draft, attachment chips, the async encryption
    // notice) — the footer spacer resizes after first paint, so we must notify
    // even on the initial measure. Otherwise the virtualized list stays
    // anchored to the stale height: the last message ends up hidden behind the
    // composer, or the list parks too high. A first measurement that matches
    // seeds silently, exactly as before (no spurious snap on a clean reload).
    const rendered = Number.parseFloat(getComputedStyle(zone).getPropertyValue("--composer-height"))
    let lastPublished: number | null = Number.isFinite(rendered) ? Math.ceil(rendered) : null
    let isInitialMeasure = true

    const write = (h: number) => {
      const px = Math.ceil(h)
      if (px <= 0) {
        cancelAnimationFrame(retryRafId)
        retryRafId = requestAnimationFrame(() => {
          const measured = Math.ceil(el.getBoundingClientRect().height)
          if (measured > 0) write(measured)
        })
        return
      }
      zone.style.setProperty("--composer-height", `${px}px`)
      persistComposerHeight(px)
      // Notify on any change from the height the footer was last sized for —
      // including the initial measure when it differs from first paint (see the
      // baseline note above). The timeline re-anchors to the bottom on this;
      // `initial` lets it do so synchronously, pre-paint, on the first measure.
      if (lastPublished !== null && px !== lastPublished) {
        onHeightChangeRef.current?.(px, { initial: isInitialMeasure })
      }
      lastPublished = px
      isInitialMeasure = false
    }

    // Runs in the layout phase, before paint: the list reveals this frame with
    // the corrected footer already accounted for.
    write(el.getBoundingClientRect().height)

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      const h = entry?.borderBoxSize?.[0]?.blockSize ?? entry?.contentRect.height ?? el.getBoundingClientRect().height
      write(h)
    })
    ro.observe(el)

    return () => {
      cancelAnimationFrame(retryRafId)
      ro.disconnect()
      // Intentionally leave --composer-height set so stream navigation
      // starts with a reasonable approximation instead of falling back to 0px.
    }
  }, [ref, active])
}
