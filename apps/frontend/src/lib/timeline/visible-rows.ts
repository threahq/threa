export interface VisibleRow {
  id: string
  top: number
  bottom: number
}

export interface ViewportBounds {
  top: number
  bottom: number
}

/**
 * The scroller's viewport band in client coordinates. The floating composer
 * overlaps the scroller's bottom; a row hidden behind it has not been seen, so
 * that band is excluded.
 */
export function readViewportBounds(el: HTMLElement): ViewportBounds {
  const rect = el.getBoundingClientRect()
  const composerH = Number.parseFloat(getComputedStyle(el).getPropertyValue("--composer-height")) || 0
  return { top: rect.top, bottom: rect.bottom - composerH }
}

/**
 * Rects of the rendered rows in `el` keyed by `data-event-id` or
 * `data-message-id`, in DOM (chronological) order, one row per id. A message
 * renders the same `data-message-id` on its event wrapper and on the message
 * element inside it; the outermost (first) occurrence wins. `accept` drops rows
 * whose id the caller can't place — e.g. the thread view's parent-message row,
 * which carries the PARENT stream's event id.
 */
export function collectRowRects(
  el: HTMLElement,
  key: "eventId" | "messageId",
  accept?: (id: string) => boolean
): VisibleRow[] {
  const rowEls = el.querySelectorAll<HTMLElement>(key === "eventId" ? "[data-event-id]" : "[data-message-id]")
  const rows: VisibleRow[] = []
  const seen = new Set<string>()
  for (let i = 0; i < rowEls.length; i++) {
    const id = rowEls[i].dataset[key]
    if (!id || seen.has(id) || (accept && !accept(id))) continue
    seen.add(id)
    const r = rowEls[i].getBoundingClientRect()
    rows.push({ id, top: r.top, bottom: r.bottom })
  }
  return rows
}

/**
 * The rows intersecting the viewport band, in DOM order. A row counts as visible
 * when any part of it is between the band's top and bottom; a row taller than
 * the band still counts (the viewer has reached it).
 */
export function pickVisibleRows(rows: VisibleRow[], bounds: ViewportBounds): VisibleRow[] {
  return rows.filter((row) => row.top < bounds.bottom && row.bottom > bounds.top)
}
