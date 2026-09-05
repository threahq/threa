import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { READ_BLOCKING_EVENT_TYPES, type StreamEvent } from "@threa/types"
import { collectRowRects, pickVisibleRows, readViewportBounds, type VisibleRow } from "@/lib/timeline/visible-rows"

export type { VisibleRow }

export interface VisibleRange {
  /** First row (chronological DOM order) intersecting the viewport. */
  topId: string
  /** Last row intersecting the viewport. */
  bottomId: string
}

/** The contiguous run of rows intersecting the viewport — first and last. */
export function pickVisibleRange(rows: VisibleRow[], viewportTop: number, viewportBottom: number): VisibleRange | null {
  const visible = pickVisibleRows(rows, { top: viewportTop, bottom: viewportBottom })
  if (visible.length === 0) return null
  return { topId: visible[0].id, bottomId: visible[visible.length - 1].id }
}

/**
 * Advance the read frontier through a contiguous run only. The frontier moves to
 * the bottom of the viewport when the viewport's top is at or above `gateIdx` —
 * i.e. no unread content sits between the read frontier and what's on screen.
 * Landing at the live bottom leaves such a gap, so the frontier (and the read
 * pointer) stays put.
 *
 * `gateIdx` is {@link readGateIndex}: the first unread MESSAGE after the
 * frontier, so rows carrying nothing to read are bridged. Never give it a
 * `frontier + 1` default: raw adjacency cannot advance past chrome the viewport
 * never showed, which strands replies bracketed by agent-session events unread.
 *
 * `topIdx` is the sweep-effective top: recompute substitutes the previous scan's
 * top when two scans link into one continuous user scroll (see SWEEP_LINK_MS), so
 * a fast fling — whose per-frame viewport jumps exceed the viewport height —
 * still reads as the continuous sweep it visually was.
 */
export function advanceFrontier(frontier: number, topIdx: number, botIdx: number, gateIdx: number): number {
  if (topIdx <= gateIdx && botIdx > frontier) return botIdx
  return frontier
}

/**
 * The lowest index the viewport's top may sit at and still continue the read
 * run: the first UNREAD MESSAGE after the frontier. Events that carry nothing
 * to read — agent-session cards, command chrome, membership notices — are
 * bridged, because a viewer who never had them on screen has not skipped any
 * content (`READ_BLOCKING_EVENT_TYPES`).
 *
 * Gating on raw adjacency (`frontier + 1`) wedged real streams: every bot reply
 * is bracketed by `agent_session:started`/`:completed`, so a session card sits
 * between the viewer's pointer and the first unread message, and any landing
 * that starts inside a tall message — a deep link, or the unread marker — puts
 * that card above the fold. The run could then never close, and the message
 * stayed unread while being read, indefinitely.
 *
 * Skipping a real message still blocks: its own index becomes the gate.
 */
export function readGateIndex(events: StreamEvent[], frontier: number): number {
  let idx = frontier + 1
  while (idx < events.length && !READ_BLOCKING_TYPES.has(events[idx].eventType)) idx++
  return idx
}

const READ_BLOCKING_TYPES: ReadonlySet<string> = new Set(READ_BLOCKING_EVENT_TYPES)

/**
 * Two viewport scans within this window, with no programmatic scroll write
 * between them, belong to one continuous user scroll: everything between the
 * first scan's top and the second scan's bottom was painted on the way through,
 * so the pair advances the frontier as one swept range. Without this, a fast
 * fling (or a busy main thread dropping rAF scans — mobile with heavy rows)
 * moves the viewport more than its own height between scans, the contiguity
 * check fails once, and the whole read-through silently marks nothing.
 * Programmatic scrolls (jump-to-latest, deep links, landing positioning) stamp
 * `programmaticScrollAtRef` on every write, which breaks the link — a jump
 * stays a gap the viewer never read.
 */
export const SWEEP_LINK_MS = 1500

interface UseLastSeenEventOptions {
  /** The owned scroll container (virtualized timeline or plain thread scroller). */
  scrollContainerRef: React.RefObject<HTMLElement | null>
  /**
   * The mounted scroller element as reactive state, when the owner tracks it
   * (the virtualized timeline late-mounts its scroller via a ref callback). The
   * attach effect depends on it so the scroll listener + ResizeObserver are
   * armed once the element actually exists — a ref alone never re-runs the
   * effect, so a window that fits the viewport (no scroll to re-trigger a scan)
   * would otherwise never advance the frontier. `null` for owners whose scroller
   * mounts synchronously with `enabled` (the plain thread scroller).
   */
  scrollContainerEl?: HTMLElement | null
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
  /** Authoritative sequence, including when the pointer's event is outside the loaded window. */
  lastReadSequence?: bigint | null
  /** Off while loading/jumping/draft — no scroller to read, nothing to track. */
  enabled: boolean
  /**
   * Timestamp (performance.now()) of the owner's last programmatic scroll
   * write. Scans on either side of a stamp never sweep-link (see
   * SWEEP_LINK_MS): a jump must remain a gap, not a read-through.
   */
  programmaticScrollAtRef?: React.RefObject<number>
  /**
   * The row a positional landing (unread marker, anchor restore) placed at the
   * top of the viewport, set by the owner when the landing engages and consumed
   * by the next arm. The first scan sweeps from it: a gesture that lifted the
   * settle mask early moved the viewport off the landing row before tracking
   * armed, and without this seed that movement reads as a jump, the contiguity
   * check fails once, and the whole read-through marks nothing. Keyed by event
   * id, so a row left over from another stream resolves to nothing and is inert.
   */
  sweepOriginRef?: React.RefObject<string | null>
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
  /** Whether no read-blocking content remains after the read frontier (a full read). */
  atLastRow: boolean
  /** Whether no read-blocking content remains after the viewport's bottom row. */
  tailVisible: boolean
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
  scrollContainerEl,
  contentRef,
  events,
  streamId,
  lastReadEventId,
  lastReadSequence,
  enabled,
  programmaticScrollAtRef,
  sweepOriginRef,
}: UseLastSeenEventOptions): UseLastSeenEventResult {
  const [lastSeenEventId, setLastSeenEventId] = useState<string | undefined>(undefined)
  const [atLastRow, setAtLastRow] = useState(false)
  const [tailVisible, setTailVisible] = useState(false)
  const [unreadAboveViewport, setUnreadAboveViewport] = useState(false)

  const indexById = useMemo(() => {
    const m = new Map<string, number>()
    // An aside anchor row renders beside its anchor, not at its sequence
    // position (`attachAsideAnchors`), so its index would misreport what is on
    // screen; left unmapped, the scan skips its row like a foreign one.
    for (let i = 0; i < events.length; i++) {
      if (events[i].eventType === "aside:anchored") continue
      m.set(events[i].id, i)
    }
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

  // The read pointer's sequence: -1 for "nothing read" (null pointer), null when
  // the pointer sits outside the loaded window. A backward move is judged against
  // the pointer's OWN past sequence (see below), so it is sequence- not index-based.
  const readSeq = useMemo<bigint | null>(() => {
    if (lastReadEventId == null) return -1n
    if (lastReadSequence !== undefined) return lastReadSequence ?? -1n
    const ev = readIndex >= 0 ? events[readIndex] : undefined
    return ev ? BigInt(ev.sequence) : null
  }, [lastReadEventId, lastReadSequence, readIndex, events])
  const readSeqRef = useRef(readSeq)
  readSeqRef.current = readSeq

  // The read frontier: the bottom of the contiguous run read so far. Seeded from
  // the read pointer and advanced only while the viewport stays contiguous with
  // it. An external read (another device) bumps it forward via readIndexRef.
  const frontierRef = useRef(readIndex)

  // When the read pointer moves BACKWARD (mark-as-unread, here or on another
  // device) the frontier is pulled back with it and pinned: the just-unread row
  // is usually still on screen, so without the pin advanceFrontier would re-read
  // it on the very next scan and auto-mark would undo the unread. The next real
  // user scroll lifts the pin and resumes normal advancement. A retreat is judged
  // by comparing the pointer to its OWN previous sequence (prevReadSeqRef), NEVER
  // to the frontier: while reading, the frontier leads the lagging pointer, so a
  // forward catch-up below the frontier must not be mistaken for a retreat (that
  // bug froze auto-read after a mark-unread).
  const pinnedRef = useRef(false)
  const prevReadSeqRef = useRef(readSeq)
  const prevLastReadIdRef = useRef(lastReadEventId)
  const prevStreamIdRef = useRef(streamId)

  // The previous scan's viewport top, for sweep-linking (SWEEP_LINK_MS). Keyed
  // by event id, not index: a prepend shifts every index but virtua holds the
  // viewport on the same rows, and an id re-resolves to its post-shift index.
  const prevScanRef = useRef<{ topId: string; at: number } | null>(null)

  const recompute = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const { top: viewportTop, bottom: viewportBottom } = readViewportBounds(el)

    const map = indexByIdRef.current
    // Skip rows that aren't in the loaded window rather than letting them
    // poison the range lookup below. The thread view renders its parent
    // message as a row carrying the PARENT stream's event id — in a short
    // thread it sits at the top of the viewport permanently, and bailing on
    // its unmappable id would veto every scan, so the thread never auto-reads.
    const rows = collectRowRects(el, "eventId", (id) => map.has(id))
    if (rows.length === 0) return

    const range = pickVisibleRange(rows, viewportTop, viewportBottom)
    if (!range) return
    const topIdx = map.get(range.topId)
    const botIdx = map.get(range.bottomId)
    if (topIdx === undefined || botIdx === undefined) return
    const lastLoadedIdx = eventsRef.current.length - 1

    // Sweep-link with the previous scan: within SWEEP_LINK_MS and with no
    // programmatic scroll write since that scan, the movement between the two
    // viewports is one continuous user scroll — everything from the previous
    // scan's top downward was painted on the way through, so contiguity is
    // judged from there. A programmatic stamp (jump, landing, refine loop)
    // newer than the previous scan breaks the link so a jump stays a gap.
    const now = performance.now()
    const prevScan = prevScanRef.current
    let effTopIdx = topIdx
    if (prevScan && now - prevScan.at <= SWEEP_LINK_MS && (programmaticScrollAtRef?.current ?? 0) < prevScan.at) {
      const prevTopIdx = map.get(prevScan.topId)
      if (prevTopIdx !== undefined && prevTopIdx < effTopIdx) effTopIdx = prevTopIdx
    }
    prevScanRef.current = { topId: range.topId, at: now }

    // While pinned (the pointer was just moved back by mark-as-unread and the
    // now-unread row is still on screen) hold the frontier so advanceFrontier
    // doesn't immediately re-read it; a user scroll lifts the pin.
    if (!pinnedRef.current) {
      // External reads can only move the frontier forward.
      if (readIndexRef.current > frontierRef.current) frontierRef.current = readIndexRef.current
      frontierRef.current = advanceFrontier(
        frontierRef.current,
        effTopIdx,
        botIdx,
        readGateIndex(eventsRef.current, frontierRef.current)
      )
    }

    const frontier = frontierRef.current
    // Trailing non-read-blocking chrome (agent-session/command terminals,
    // reactions) renders no `[data-event-id]` row, so `lastLoadedIdx` itself is
    // unreachable by the frontier or the viewport — both bridge through the gate.
    const firstUnreadIdx = readGateIndex(eventsRef.current, frontier)
    setAtLastRow(firstUnreadIdx > lastLoadedIdx)
    setTailVisible(readGateIndex(eventsRef.current, botIdx) > lastLoadedIdx)
    setUnreadAboveViewport(firstUnreadIdx <= lastLoadedIdx && firstUnreadIdx < topIdx)
    // `lastSeenEventId` is derived, not a forward-only latch: it names the
    // frontier's row only while the frontier sits PAST the read pointer. Once the
    // pointer catches up to (or passes) the frontier — the round-trip landed, or a
    // backward move (mark-as-unread) pulled the frontier back to the pointer —
    // nothing is seen-but-unmarked ahead, so clear it. Without this roll-back the
    // stale higher value would let auto-mark re-fire and undo the mark-as-unread.
    // `readSeq == null` means the pointer is set but sits OUTSIDE the loaded
    // window (e.g. mark-as-unread on the oldest loaded row moves it below the
    // window) — read progress is then unknowable, so emit nothing rather than
    // re-marking up to the stale frontier.
    const pointerResolved = readSeqRef.current != null && (readIndexRef.current >= 0 || readSeqRef.current === -1n)
    if (pointerResolved && frontier > readIndexRef.current && frontier >= 0) {
      const id = eventsRef.current[frontier]?.id
      if (id) setLastSeenEventId((prev) => (prev === id ? prev : id))
    } else {
      setLastSeenEventId((prev) => (prev === undefined ? prev : undefined))
    }
  }, [scrollContainerRef, programmaticScrollAtRef])

  // Reset on stream switch — the new stream's frontier seeds from its own read
  // pointer, never inheriting the previous stream's position.
  useEffect(() => {
    frontierRef.current = readIndexRef.current
    prevReadSeqRef.current = readSeqRef.current
    pinnedRef.current = false
    prevScanRef.current = null
    setLastSeenEventId(undefined)
    setAtLastRow(false)
    setTailVisible(false)
    setUnreadAboveViewport(false)
  }, [streamId])

  // Attach the scroll listener and seed an initial scan. The initial scan covers
  // a window that fits the viewport with no scroll (no scroll event would fire).
  // The virtualized timeline late-mounts its scroller AFTER `enabled` flips, so
  // this effect depends on the mounted element (`scrollContainerEl`), not just
  // `enabled`: a ref change never re-runs an effect, so without the element dep
  // the ResizeObserver would arm against a null scroller and a viewport-fitting
  // window (no scroll to re-trigger a scan) would never advance the frontier.
  useEffect(() => {
    if (!enabled) return
    const el = scrollContainerEl ?? scrollContainerRef.current
    // A re-arm (enabled flip, scroller mount, jump-mode exit) starts a fresh
    // sweep baseline — scans across a disabled window must never link — unless
    // a positional landing left the row it placed at the top (sweepOriginRef):
    // the first scan then sweeps from that row, as a scan right after the reveal
    // would have. Stamped now, after the landing's last programmatic write, so
    // the link check below admits it.
    const origin = sweepOriginRef?.current ?? null
    if (sweepOriginRef) sweepOriginRef.current = null
    prevScanRef.current = origin ? { topId: origin, at: performance.now() } : null
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
  }, [enabled, streamId, recompute, scrollContainerRef, scrollContainerEl, contentRef, sweepOriginRef])

  // Re-scan when the window grows (live append), an event at the same index is
  // replaced (the optimistic temp_ row for the viewer's own send is swapped for
  // its server-confirmed id in place — same length, new reference), or the read
  // pointer moves under us (external read) — so the frontier and the affordance
  // stay current. Depending on `events` itself (not just `.length`) matters: a
  // same-length swap leaves the frontier's index unchanged but its `.id` stale,
  // and `lastSeenEventId` is read off that id — without this, a viewer whose own
  // message is the last thing they did stays pinned to the dead temp_ id, and
  // auto-mark-as-read silently never advances past it (it refuses to persist a
  // temp_ id as the read pointer) until some other event nudges a re-scan.
  useEffect(() => {
    if (!enabled) return
    // Detect a genuine pointer move (the id changed), not a windowing artifact
    // where the same read event scrolls out of the loaded window. On a backward
    // move (readIndex now before the frontier — including -1 when the pointer
    // cleared to null) pull the frontier back and pin it; on a forward move (an
    // external read on another device) bump it forward. Skip on stream switch:
    // the reset effect already reseeds the frontier from the new stream.
    const streamChanged = prevStreamIdRef.current !== streamId
    prevStreamIdRef.current = streamId
    if (!streamChanged && lastReadEventId !== prevLastReadIdRef.current) {
      // Retreat = the pointer's sequence dropped below where it just was (mark-as-
      // unread). Forward moves and external reads are left to recompute's forward
      // bump; only a genuine backward move pins.
      if (readSeqRef.current != null && prevReadSeqRef.current != null && readSeqRef.current < prevReadSeqRef.current) {
        frontierRef.current = readIndex
        pinnedRef.current = true
      }
    }
    if (readSeqRef.current != null) prevReadSeqRef.current = readSeqRef.current
    prevLastReadIdRef.current = lastReadEventId
    const raf = requestAnimationFrame(recompute)
    return () => cancelAnimationFrame(raf)
  }, [enabled, events, streamId, lastReadEventId, readIndex, recompute])

  return { lastSeenEventId, atLastRow, tailVisible, unreadAboveViewport }
}
