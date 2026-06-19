import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { StreamEvent } from "@threa/types"

export interface VisibleRow {
  id: string
  top: number
  bottom: number
}

/**
 * Bottom-most row the viewer has seen: the last row (chronological DOM order)
 * whose top edge has crossed above the viewport bottom while any part of it is
 * still below the viewport top. A row taller than the viewport counts as seen
 * once its top scrolls past — the viewer has reached its start.
 */
export function pickBottomSeenId(rows: VisibleRow[], viewportTop: number, viewportBottom: number): string | null {
  let seen: string | null = null
  for (const row of rows) {
    if (row.top < viewportBottom && row.bottom > viewportTop) seen = row.id
  }
  return seen
}

interface UseLastSeenEventOptions {
  /** The owned scroll container (virtualized timeline or plain thread scroller). */
  scrollContainerRef: React.RefObject<HTMLElement | null>
  /** The loaded event window, used to map a seen row back to its position. */
  events: StreamEvent[]
  streamId: string
  /** Off while loading/jumping/draft — no scroller to read, nothing to track. */
  enabled: boolean
}

interface UseLastSeenEventResult {
  /**
   * Highest event the viewer has scrolled into view this session, advanced
   * monotonically and reset per stream. `undefined` until the first scan, so
   * read state never runs ahead of what the user has actually reached.
   */
  lastSeenEventId: string | undefined
  /**
   * Whether the bottom-most visible row is the last rendered row — i.e. the
   * viewer is at the live tail. Drives whether a mark-as-read is a full read
   * (clear the badge) or a partial one (leave messages below the fold unread).
   */
  atLastRow: boolean
}

/**
 * Track how far down a stream the viewer has actually read — the bottom-most
 * timeline row that has entered the viewport, advanced monotonically. Drives
 * progressive mark-as-read (Slack parity): opening a stream no longer marks
 * everything read after a debounce regardless of scroll; unread messages below
 * the fold stay unread until the viewer scrolls to them.
 */
export function useLastSeenEvent({
  scrollContainerRef,
  events,
  streamId,
  enabled,
}: UseLastSeenEventOptions): UseLastSeenEventResult {
  const [lastSeenEventId, setLastSeenEventId] = useState<string | undefined>(undefined)
  const [atLastRow, setAtLastRow] = useState(false)

  // Index lookup + events kept in refs so the scroll listener closure stays
  // stable across data ticks — re-attaching it on every new message would drop
  // scroll events mid-gesture.
  const indexById = useMemo(() => {
    const m = new Map<string, number>()
    for (let i = 0; i < events.length; i++) m.set(events[i].id, i)
    return m
  }, [events])
  const indexByIdRef = useRef(indexById)
  indexByIdRef.current = indexById

  // Highest seen index this session. Monotonic so a scroll back up never
  // retracts the read pointer.
  const maxSeenIndexRef = useRef(-1)

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

    const seenId = pickBottomSeenId(rows, viewportTop, viewportBottom)
    if (!seenId) return
    setAtLastRow(seenId === rows[rows.length - 1]?.id)

    const idx = indexByIdRef.current.get(seenId)
    if (idx === undefined) return
    if (idx > maxSeenIndexRef.current) {
      maxSeenIndexRef.current = idx
      setLastSeenEventId(seenId)
    }
  }, [scrollContainerRef])

  // Reset on stream switch — a new stream's read position must not inherit the
  // previous stream's seen pointer.
  useEffect(() => {
    maxSeenIndexRef.current = -1
    setLastSeenEventId(undefined)
    setAtLastRow(false)
  }, [streamId])

  // Attach the scroll listener and seed an initial scan. The initial scan
  // covers a window that fits the viewport with no scroll, where no scroll
  // event would ever fire. `enabled` flips true exactly when the scroller is
  // mounted (loading skeleton gone), so the container ref is live here.
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
    schedule()
    el?.addEventListener("scroll", schedule, { passive: true })
    return () => {
      if (raf) cancelAnimationFrame(raf)
      el?.removeEventListener("scroll", schedule)
    }
  }, [enabled, streamId, recompute, scrollContainerRef])

  // Re-scan when the loaded window grows (a live append at the tail moves the
  // last row; a content-fits-viewport append fires no scroll event).
  useEffect(() => {
    if (!enabled) return
    const raf = requestAnimationFrame(recompute)
    return () => cancelAnimationFrame(raf)
  }, [enabled, events.length, recompute])

  return { lastSeenEventId, atLastRow }
}
