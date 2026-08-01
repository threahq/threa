/**
 * Registry of armed board-card reveal windows (see useBoardCardRevealAnchor).
 *
 * A programmatic feed jump — the "N new" pill's scroll-to-top, a lens switch's
 * reset, the own-post jump — fires no wheel/touch event, so the gesture
 * listeners that normally hand control back to the reader never see it. An
 * armed window then treats the jump's scroll delta as growth to compensate and
 * scrolls the viewport right back away from the top. The jump sites close every
 * window through here BEFORE moving the scroller.
 */
const windows = new Set<() => void>()

export function registerRevealWindow(close: () => void): () => void {
  windows.add(close)
  return () => {
    windows.delete(close)
  }
}

export function closeAllRevealWindows(): void {
  for (const close of [...windows]) close()
}
