import { useEffect, useState, type RefObject } from "react"

const HIGHLIGHT_NAME = "stream-search"
const ACTIVE_HIGHLIGHT_NAME = "stream-search-active"

/**
 * Walks text nodes in `root` and finds all case-insensitive occurrences of `query`.
 * Returns an array of Range objects, one per occurrence, in document order.
 */
function findTextRanges(root: Element, query: string): Range[] {
  if (!query) return []

  const ranges: Range[] = []
  const lowerQuery = query.toLowerCase()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)

  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    const text = node.textContent
    if (!text) continue

    const lowerText = text.toLowerCase()
    let pos = 0
    while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
      const range = document.createRange()
      range.setStart(node, pos)
      range.setEnd(node, pos + query.length)
      ranges.push(range)
      pos += query.length
    }
  }

  return ranges
}

/**
 * Maps a message-level active match (messageId + occurrence) to a global range index.
 * Finds the DOM element with data-message-id matching, then counts ranges belonging
 * to that element to find the Nth occurrence.
 */
function findActiveRangeIndex(
  root: Element,
  ranges: Range[],
  activeMessageId: string | null,
  activeOccurrence: number
): number {
  if (!activeMessageId || ranges.length === 0) return -1

  const msgEl = root.querySelector(`[data-message-id="${CSS.escape(activeMessageId)}"]`)
  if (!msgEl) return -1

  let occurrenceCount = 0
  for (let i = 0; i < ranges.length; i++) {
    if (msgEl.contains(ranges[i].startContainer)) {
      if (occurrenceCount === activeOccurrence) return i
      occurrenceCount++
    }
  }

  // Fallback: return first range in this message
  return ranges.findIndex((r) => msgEl.contains(r.startContainer))
}

/**
 * Highlights search matches in the DOM using the CSS Custom Highlight API.
 * All matches get a yellow highlight; the active match gets an orange highlight.
 * Falls back to no-op if the API is unavailable.
 *
 * Scroll positioning is NOT handled here — callers own scrolling so that the
 * virtualized list can use its own scrollToIndex retry loop without fighting
 * a DOM-level scrollIntoView.
 */
export function useSearchHighlight(
  containerRef: RefObject<HTMLElement | null>,
  query: string,
  activeMessageId: string | null,
  activeOccurrence: number
): void {
  // Tick bumped by a MutationObserver so highlights re-compute when virtualized
  // items enter or leave the DOM (otherwise matches outside the initial
  // rendered window never get highlighted).
  const [domTick, setDomTick] = useState(0)

  useEffect(() => {
    const root = containerRef.current
    if (!root || !query) return
    let raf = 0
    const observer = new MutationObserver((mutations) => {
      // Only react when items are added/removed — ignore attribute or
      // text-node changes which fire constantly during scroll/resize.
      const hasChildListChange = mutations.some(
        (m) => m.type === "childList" && (m.addedNodes.length > 0 || m.removedNodes.length > 0)
      )
      if (!hasChildListChange) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setDomTick((t) => t + 1))
    })
    observer.observe(root, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [containerRef, query])

  // Apply highlights. Do NOT clean up on every re-run — set() replaces any
  // existing Highlight atomically, so clearing-then-setting on each tick
  // would cause a visible flicker. Cleanup happens in the unmount effect below.
  useEffect(() => {
    if (typeof CSS === "undefined" || !("highlights" in CSS)) return
    const highlights = CSS.highlights as Map<string, Highlight>

    if (!query || !containerRef.current) {
      highlights.delete(HIGHLIGHT_NAME)
      highlights.delete(ACTIVE_HIGHLIGHT_NAME)
      return
    }

    const root = containerRef.current
    const ranges = findTextRanges(root, query)

    if (ranges.length === 0) {
      highlights.delete(HIGHLIGHT_NAME)
      highlights.delete(ACTIVE_HIGHLIGHT_NAME)
      return
    }

    // set() replaces any existing Highlight atomically.
    highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges))

    const activeIdx = findActiveRangeIndex(root, ranges, activeMessageId, activeOccurrence)
    if (activeIdx >= 0) {
      highlights.set(ACTIVE_HIGHLIGHT_NAME, new Highlight(ranges[activeIdx]))
    } else {
      highlights.delete(ACTIVE_HIGHLIGHT_NAME)
    }
  }, [containerRef, query, activeMessageId, activeOccurrence, domTick])

  useEffect(() => {
    return () => {
      if (typeof CSS === "undefined" || !("highlights" in CSS)) return
      const highlights = CSS.highlights as Map<string, Highlight>
      highlights.delete(HIGHLIGHT_NAME)
      highlights.delete(ACTIVE_HIGHLIGHT_NAME)
    }
  }, [])
}
