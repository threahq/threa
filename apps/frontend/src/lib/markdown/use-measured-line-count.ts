import { useCallback, useLayoutEffect, useState, type RefObject } from "react"

export interface MeasuredLines {
  /**
   * Visual line count = rendered content height ÷ computed line-height.
   * `null` until a real layout exists (first paint, JSDOM with no layout
   * engine, detached node), or when line measurement is disabled. Line-based
   * consumers treat `null` as "not measured yet" and render expanded with no
   * collapse chrome.
   */
  lineCount: number | null
  /** Computed line-height in CSS px, used to build the collapsed clamp. */
  lineHeightPx: number | null
  /** Rendered content height in CSS px. */
  heightPx?: number | null
}

const UNMEASURED: MeasuredLines = { lineCount: null, lineHeightPx: null, heightPx: null }

function resolveLineHeightPx(el: HTMLElement): number {
  const cs = getComputedStyle(el)
  const lh = Number.parseFloat(cs.lineHeight)
  if (Number.isFinite(lh) && lh > 0) return lh
  // `line-height: normal` doesn't expose a px value; browsers render it at
  // roughly 1.2× the font size, which is close enough to decide "long vs not".
  const fs = Number.parseFloat(cs.fontSize)
  return Number.isFinite(fs) && fs > 0 ? fs * 1.2 : 0
}

/**
 * Measures how many *visual* lines an element occupies after wrapping, by
 * dividing its rendered content height by the computed line-height. Unlike
 * counting "\n" in the source, this reflects soft-wrapped lines, which depend
 * on the viewport / message-column width — the number that actually decides
 * whether a block reads as "long".
 *
 * Measurement runs in a layout effect (before paint, so a block that resolves
 * to collapsed never flashes its full height) and re-runs when the element
 * resizes (column resize, font-size preference change) or when `deps` change
 * (content changed). `scrollHeight` reports full content height even while a
 * max-height clamp is applied, so the collapsed state never hides lines from
 * the measurement.
 *
 * Constraint: the ref'd element and its subtree must carry no vertical
 * padding/border/margin, so `scrollHeight` equals the text block height
 * exactly. Put visual spacing on a non-ref'd ancestor.
 */
export function useMeasuredLineCount(
  ref: RefObject<HTMLElement | null>,
  deps: ReadonlyArray<unknown>,
  { measureLines = true }: { measureLines?: boolean } = {}
): MeasuredLines & { remeasure: () => void } {
  const [measured, setMeasured] = useState<MeasuredLines>(UNMEASURED)

  const remeasure = useCallback(() => {
    const node = ref.current
    if (!node) return
    const height = node.scrollHeight
    const lineHeightPx = measureLines ? resolveLineHeightPx(node) : null
    if (height <= 0 || (lineHeightPx !== null && lineHeightPx <= 0)) {
      // No layout engine (JSDOM) or not yet attached — stay unmeasured so
      // consumers fall back to "expanded, no chrome".
      return
    }
    const lineCount = lineHeightPx === null ? null : height / lineHeightPx
    setMeasured((prev) =>
      prev.lineHeightPx === lineHeightPx && prev.heightPx === height
        ? prev
        : { lineCount, lineHeightPx, heightPx: height }
    )
  }, [ref, measureLines])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    remeasure()

    const observer = new ResizeObserver(remeasure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, remeasure, ...deps])

  return { ...measured, remeasure }
}
