import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { StreamEvent } from "@threa/types"

export interface VisibleRow {
  id: string
  top: number
  bottom: number
}

export interface VisibleRange {
  /** First row (chronological DOM order) intersecting the viewport. */
  topId: string
  /** Last row intersecting the viewport. */
  bottomId: string
}

/**
 * The contiguous run of rows intersecting the viewport — first and last. A row
 * counts as visible when any part of it is between the viewport top and bottom;
 * a row taller than the viewport still counts (the viewer has reached it).
 */
export function pickVisibleRange(rows: VisibleRow[], viewportTop: number, viewportBottom: number): VisibleRange | null {
  let topId: string | null = null
  let bottomId: string | null = null
  for (const row of rows) {
    if (row.top < viewportBottom && row.bottom > viewportTop) {
      if (topId === null) topId = row.id
      bottomId = row.id
    }
  }
  return topId !== null && bottomId !== null ? { topId, bottomId } : null
}

/**
 * Advance the read frontier through a contiguous run only. The frontier moves to
 * the bottom of the viewport when the viewport's top is at or above the first
 * unread row (`frontier + 1`) — i.e. there is no gap of unseen rows between the
 * read frontier and what's on screen. Landing at the live bottom leaves such a
 * gap, so the frontier (and the read pointer) stays put; flinging past a block
 * of rows without them entering the viewport likewise stops the advance.
 */
export function advanceFrontier(frontier: number, topIdx: number, botIdx: number): number {
  if (topIdx <= frontier + 1 && botIdx > frontier) return botIdx
  return frontier
}

interface UseLastSeenEventOptions {
  /** The owned scroll container (virtualized timeline or plain thread scroller). */
  scrollContainerRef: React.RefObject<HTMLElement | null>
  /**
   * The scrolling content box inside the container (its height = scrollHeight).
   * Observed for size changes so the scan re-runs when rows grow after the last
   * scroll — the open-at-bottom settle finishing, or async embeds (link/GitHub
   * cards, images) loading. Without it a short stream that fits the viewport,
   * and so fires no scroll event, would never re-scan and the trailing rows
   * would stay unread. Falls back to the container when omitted.
   */
  contentRef?: React.RefObject<HTMLElement | null>
  /** The loaded event window, used to map a visible row back to its position. */
  events: StreamEvent[]
  streamId: string
  /**
   * The viewer's persisted read pointer (the last event they've read up to), or
   * `null`/`undefined` when nothing is read / still hydrating. Seeds the read
   * frontier so marking resumes from where the viewer left off.
   */
  lastReadEventId: string | null | undefined
  /** Off while loading/jumping/draft — no scroller to read, nothing to track. */
  enabled: boolean
}

interface UseLastSeenEventResult {
  /**
   * The event to mark read up to: the bottom of the contiguous run the viewer
   * has scrolled through starting from their read pointer. `undefined` until the
   * frontier advances past the pointer. Read state never jumps a gap — landing
   * at the live bottom does NOT mark the unread above it read; the viewer must
   * scroll down through it (or press Escape) for the pointer to advance.
   */
  lastSeenEventId: string | undefined
  /** Whether the read frontier has reached the last rendered row (a full read). */
  atLastRow: boolean
  /**
   * Whether unread sits above the current viewport — i.e. the first unread row
   * is scrolled off the top. Drives the "N new ↑" jump affordance.
   */
  unreadAboveViewport: boolean
}

/**
 * Track how far the viewer has actually read, advancing the read pointer only
 * through a CONTIGUOUS run from where they left off (Slack-style). Opening a
 * stream lands at the live bottom; the unread above stays unread until the
 * viewer scrolls up to the first unread and reads down through it — the pointer
 * cannot skip a gap of messages the viewer never had on screen.
 */
export function useLastSeenEvent({
  scrollContainerRef,
  contentRef,
  events,
  streamId,
  lastReadEventId,
  enabled,
}: UseLastSeenEventOptions): UseLastSeenEventResult {
  const [lastSeenEventId, setLastSeenEventId] = useState<string | undefined>(undefined)
  const [atLastRow, setAtLastRow] = useState(false)
  const [unreadAboveViewport, setUnreadAboveViewport] = useState(false)

  const indexById = useMemo(() => {
    const m = new Map<string, number>()
    for (let i = 0; i < events.length; i++) m.set(events[i].id, i)
    return m
  }, [events])
  // Refs keep the scroll-listener closure stable across data ticks — re-attaching
  // it on every new message would drop scroll events mid-gesture.
  const indexByIdRef = useRef(indexById)
  indexByIdRef.current = indexById
  const eventsRef = useRef(events)
  eventsRef.current = events

  // The viewer's read pointer as an index into the loaded window. A read event
  // older than the window (or unknown) is -1: everything loaded is unread.
  const readIndex = lastReadEventId != null ? (indexById.get(lastReadEventId) ?? -1) : -1
  const readIndexRef = useRef(readIndex)
  readIndexRef.current = readIndex

  // The read frontier: the bottom of the contiguous run read so far. Seeded from
  // the read pointer and advanced only while the viewport stays contiguous with
  // it. An external read (another device) bumps it forward via readIndexRef.
  const frontierRef = useRef(readIndex)

  // When the read pointer moves BACKWARD (mark-as-unread, here or on another
  // device) the frontier is pulled back with it and pinned: the just-unread row
  // is usually still on screen, so without the pin advanceFrontier would re-read
  // it on the very next scan and auto-mark would undo the unread. The next real
  // user scroll lifts the pin and resumes normal advancement. prevReadIndexRef
  // tracks the prior pointer index so a decrease can be detected.
  const pinnedRef = useRef(false)
  const prevReadIndexRef = useRef(readIndex)

  const recompute = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const containerRect = el.getBoundingClientRect()
    // The floating composer overlaps the scroller's bottom; a row hidden behind
    // it has not been seen, so exclude that band from the viewport.
    const composerH = Number.parseFloat(getComputedStyle(el).getPropertyValue("--composer-height")) || 0
    const viewportTop = containerRect.top
    const viewportBottom = containerRect.bottom - composerH

    const rowEls = el.querySelectorAll<HTMLElement>("[data-event-id]")
    if (rowEls.length === 0) return
    const rows: VisibleRow[] = []
    for (let i = 0; i < rowEls.length; i++) {
      const id = rowEls[i].dataset.eventId
      if (!id) continue
      const r = rowEls[i].getBoundingClientRect()
      rows.push({ id, top: r.top, bottom: r.bottom })
    }

    const range = pickVisibleRange(rows, viewportTop, viewportBottom)
    if (!range) return
    const map = indexByIdRef.current
    const topIdx = map.get(range.topId)
    const botIdx = map.get(range.bottomId)
    if (topIdx === undefined || botIdx === undefined) return
    const lastRenderedIdx = map.get(rows[rows.length - 1].id) ?? botIdx

    // While pinned (the pointer was just moved back by mark-as-unread and the
    // now-unread row is still on screen) hold the frontier so advanceFrontier
    // doesn't immediately re-read it; a user scroll lifts the pin.
    if (!pinnedRef.current) {
      // External reads can only move the frontier forward.
      if (readIndexRef.current > frontierRef.current) frontierRef.current = readIndexRef.current
      frontierRef.current = advanceFrontier(frontierRef.current, topIdx, botIdx)
    }

    const frontier = frontierRef.current
    setAtLastRow(frontier >= lastRenderedIdx)
    // Unread sits above the viewport when the first unread row (frontier + 1)
    // exists in the window and is scrolled off the top.
    setUnreadAboveViewport(frontier + 1 <= lastRenderedIdx && frontier + 1 < topIdx)
    // Only emit a mark target once the frontier has moved PAST the read pointer —
    // marking up to where they already are is a wasted no-op round-trip.
    if (frontier > readIndexRef.current && frontier >= 0) {
      const id = eventsRef.current[frontier]?.id
      if (id) setLastSeenEventId((prev) => (prev === id ? prev : id))
    }
  }, [scrollContainerRef])

  // Reset on stream switch — the new stream's frontier seeds from its own read
  // pointer, never inheriting the previous stream's position.
  useEffect(() => {
    frontierRef.current = readIndexRef.current
    prevReadIndexRef.current = readIndexRef.current
    pinnedRef.current = false
    setLastSeenEventId(undefined)
    setAtLastRow(false)
    setUnreadAboveViewport(false)
  }, [streamId])

  // Attach the scroll listener and seed an initial scan. The initial scan covers
  // a window that fits the viewport with no scroll (no scroll event would fire).
  // `enabled` flips true exactly when the scroller is mounted, so the ref is live.
  useEffect(() => {
    if (!enabled) return
    const el = scrollContainerRef.current
    let raf = 0
    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        recompute()
      })
    }
    // A real user scroll is the gesture that resumes normal advancement after a
    // mark-as-unread pin; resize/initial re-scans must NOT lift it.
    const onScroll = () => {
      pinnedRef.current = false
      schedule()
    }
    schedule()
    el?.addEventListener("scroll", onScroll, { passive: true })
    // Re-scan when the rendered geometry changes without a scroll: the
    // open-at-bottom settle finishing, or async embeds (link/GitHub cards,
    // images) loading and resizing the trailing rows. On a short stream that
    // can't scroll this is the ONLY thing that brings the last rows into the
    // seen frontier — otherwise they stay unread with no gesture to fix it.
    const content = contentRef?.current ?? null
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null
    if (ro) {
      if (el) ro.observe(el)
      if (content && content !== el) ro.observe(content)
    }
    return () => {
      if (raf) cancelAnimationFrame(raf)
      el?.removeEventListener("scroll", onScroll)
      ro?.disconnect()
    }
  }, [enabled, streamId, recompute, scrollContainerRef, contentRef])

  // Re-scan when the window grows (live append) or the read pointer moves under
  // us (external read), so the frontier and the affordance stay current.
  useEffect(() => {
    if (!enabled) return
    // A backward move of the read pointer to a known row (mark-as-unread, here or
    // echoed from another device) pulls the frontier back with it and pins it.
    if (readIndex >= 0 && readIndex < prevReadIndexRef.current) {
      frontierRef.current = readIndex
      pinnedRef.current = true
    }
    prevReadIndexRef.current = readIndex
    const raf = requestAnimationFrame(recompute)
    return () => cancelAnimationFrame(raf)
  }, [enabled, events.length, readIndex, recompute])

  return { lastSeenEventId, atLastRow, unreadAboveViewport }
}
