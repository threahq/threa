import { useCallback, useEffect, useRef } from "react"
import { useAutoReadAttention } from "@/hooks/use-auto-mark-as-read"
import type { RowReadState } from "@/components/timeline/read-frontier-context"
import type { ConversationRowRead } from "@/components/message/conversation-read-context"
import type { RenderableMessage } from "@/components/message/message-item"

/** A row is "seen" once any part of it has stayed in the viewport this long
 * while the viewer's attention is on the page. */
const DWELL_MS = 1_000

/** Seen rows batch into one mark-read call per conversation — a trailing
 * debounce, so reading down a card coalesces instead of firing per row. */
const DEBOUNCE_MS = 2_000

interface UseConversationAutoReadOptions {
  /** Wraps this surface's rendered `MessageItem` rows (the board card's root, the
   * panel's scroller) — rows are found by their `data-message-id` attribute. */
  containerRef: React.RefObject<HTMLElement | null>
  /**
   * The rows eligible for auto-read, chronological: the contiguous-from-the-start
   * run of the conversation the surface is actually showing. A collapsed board
   * card with an "N more" gap passes only the opening — marking is a `createdAt`
   * cutoff (ConversationService.markRead), so marking through a row past the gap
   * would silently read the hidden middle the viewer never saw. The array need
   * not be referentially stable; effects key on the id set.
   */
  messages: RenderableMessage[]
  /** Fallback stream for rows without their own `streamId`, as row rendering. */
  rootStreamId: string
  /** The controller's per-row derivation — auto-read fires only when something
   * at/below the target is effectively unread, so it is idempotent against the
   * overlay/watermark state and never loops. */
  rowState: ConversationRowRead["state"]
  /** The silent mark-read mutation (`markReadSilently` off the controller). */
  markRead: (messageId: string) => Promise<void>
  enabled?: boolean
}

/**
 * Viewport auto-read for a conversation surface (board card, conversation
 * panel): reading IS marking. A row that dwells in the viewport for a beat
 * while the tab has the viewer's attention becomes "seen"; seen rows debounce
 * into one conversation mark-read through the newest seen row (the same
 * cutoff API as the menu action). The explicit menu actions remain as the
 * override.
 *
 * Semantics, mirroring the stream timeline's auto-read where they map:
 * - A row counts as visible when ANY part of it intersects the viewport (a row
 *   taller than the viewport still counts) — `pickVisibleRange` semantics; the
 *   dwell requirement is what keeps a scroll-past from marking.
 * - Marking runs through the FURTHEST seen row. Rows above it that never got
 *   their dwell are covered by the cutoff — the viewer scrolled past them
 *   inside a run they were reading, the same acceptance as the timeline's
 *   partial reads.
 * - Mark-as-unread pins: when any eligible row regresses read → unread (the
 *   viewer's explicit action, here or on another device), everything unseen-s
 *   and the rows still on screen are suppressed — auto-read holds entirely
 *   until every suppressed row has left the viewport (the timeline's
 *   `pinnedRef`, with leave-and-return as the resume gesture instead of a
 *   scroll, which a small card doesn't have). Without the full hold, a newer
 *   row dwelling would cutoff-mark right back over the explicit unread.
 * - Optimistic `temp_` rows are never targets (the id doesn't exist
 *   server-side yet); their confirmed swap re-enters normally.
 */
export function useConversationAutoRead({
  containerRef,
  messages,
  rootStreamId,
  rowState,
  markRead,
  enabled = true,
}: UseConversationAutoReadOptions): void {
  const canAutoRead = useAutoReadAttention()

  const eligible = messages.filter((m) => !m.id.startsWith("temp_"))
  const eligibleIdsKey = eligible.map((m) => m.id).join(",")
  const eligibleRef = useRef(eligible)
  eligibleRef.current = eligible
  const rowStateRef = useRef(rowState)
  rowStateRef.current = rowState
  const rootStreamIdRef = useRef(rootStreamId)
  rootStreamIdRef.current = rootStreamId
  const markReadRef = useRef(markRead)
  markReadRef.current = markRead
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const seenRef = useRef(new Set<string>())
  const suppressedRef = useRef(new Set<string>())
  const visibleRef = useRef(new Set<string>())
  const dwellTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastMarkedRef = useRef<string | null>(null)

  const stateOf = useCallback(
    (m: RenderableMessage): RowReadState =>
      rowStateRef.current(m.streamId ?? rootStreamIdRef.current, m.id, m.sequence, m.createdAt),
    []
  )

  const evaluate = useCallback(() => {
    debounceRef.current = null
    if (!enabledRef.current) return
    // An active pin blocks firing entirely (not just for the pinned rows): the
    // cutoff means marking through ANY newer row would undo the explicit unread.
    if (suppressedRef.current.size > 0) return
    const rows = eligibleRef.current
    let targetIdx = -1
    for (let i = 0; i < rows.length; i++) {
      if (seenRef.current.has(rows[i].id)) targetIdx = i
    }
    if (targetIdx < 0) return
    const target = rows[targetIdx]
    if (lastMarkedRef.current === target.id) return
    // Fire only when the cutoff would actually read something: any row at/below
    // the target effectively unread. All-read (another device, a prior mark) and
    // all-ungated (no resolvable frontier) both no-op.
    let anyUnread = false
    for (let i = 0; i <= targetIdx && !anyUnread; i++) {
      if (stateOf(rows[i]) === "unread") anyUnread = true
    }
    if (!anyUnread) return
    lastMarkedRef.current = target.id
    markReadRef.current(target.id).catch(() => {
      // Background action: fail silently; releasing the dedup lets the next
      // evaluation retry.
      if (lastMarkedRef.current === target.id) lastMarkedRef.current = null
    })
  }, [stateOf])

  const scheduleEvaluate = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(evaluate, DEBOUNCE_MS)
  }, [evaluate])

  const cancelDwell = (id: string) => {
    const timer = dwellTimersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      dwellTimersRef.current.delete(id)
    }
  }

  // The observer: dwell timers start on enter, cancel on leave. Torn down (with
  // all pending dwells) whenever attention drops or the eligible set changes;
  // the rebuild's initial entries restart dwells for rows still on screen.
  // Already-seen rows stay seen across rebuilds — they were legitimately read.
  useEffect(() => {
    if (!enabled || !canAutoRead || eligibleIdsKey === "") return
    // jsdom (and any environment without IO) — auto-read simply stays off, the
    // same soft degradation as useLastSeenEvent's ResizeObserver guard.
    if (typeof IntersectionObserver === "undefined") return
    const container = containerRef.current
    if (!container) return
    const eligibleIds = new Set(eligibleRef.current.map((m) => m.id))
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.messageId
        if (!id) continue
        if (entry.isIntersecting) {
          visibleRef.current.add(id)
          if (seenRef.current.has(id) || suppressedRef.current.has(id)) continue
          if (dwellTimersRef.current.has(id)) continue
          dwellTimersRef.current.set(
            id,
            setTimeout(() => {
              dwellTimersRef.current.delete(id)
              seenRef.current.add(id)
              scheduleEvaluate()
            }, DWELL_MS)
          )
        } else {
          visibleRef.current.delete(id)
          // Leaving the viewport is the pin's release gesture for this row.
          suppressedRef.current.delete(id)
          cancelDwell(id)
        }
      }
    })
    for (const el of container.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const id = el.dataset.messageId
      if (id && eligibleIds.has(id)) io.observe(el)
    }
    return () => {
      io.disconnect()
      for (const timer of dwellTimersRef.current.values()) clearTimeout(timer)
      dwellTimersRef.current.clear()
      // Visibility is unknowable while unobserved; the rebuild's initial
      // entries repopulate it (and release pins for rows that left meanwhile).
      visibleRef.current.clear()
    }
  }, [enabled, canAutoRead, eligibleIdsKey, containerRef, scheduleEvaluate])

  // The mark-unread pin. Watches per-row state for a read → unread regression —
  // the viewer's explicit action (menu here, or another device) — and freezes
  // auto-read: everything unseen-s, pending work cancels, and every row still on
  // screen is suppressed until it leaves the viewport. First run only baselines.
  const prevStatesRef = useRef<Map<string, RowReadState> | null>(null)
  useEffect(() => {
    const next = new Map<string, RowReadState>()
    for (const m of eligibleRef.current) next.set(m.id, stateOf(m))
    const prev = prevStatesRef.current
    prevStatesRef.current = next
    // Rows that left the conversation (deleted, re-clustered) can't hold a pin
    // or a seen slot forever.
    for (const id of suppressedRef.current) if (!next.has(id)) suppressedRef.current.delete(id)
    for (const id of seenRef.current) if (!next.has(id)) seenRef.current.delete(id)
    if (!prev) return
    let regressed = false
    for (const [id, state] of next) {
      if (state === "unread" && prev.get(id) === "read") {
        regressed = true
        break
      }
    }
    if (!regressed) return
    seenRef.current.clear()
    for (const timer of dwellTimersRef.current.values()) clearTimeout(timer)
    dwellTimersRef.current.clear()
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    // Release the dedup too: after the pin lifts, re-reading may legitimately
    // re-target the same newest row.
    lastMarkedRef.current = null
    for (const id of visibleRef.current) suppressedRef.current.add(id)
  }, [rowState, eligibleIdsKey, rootStreamId, stateOf])

  // Flush a pending debounce on unmount (panel closed, card scrolled out of the
  // board's window mid-read) — the rows were seen; losing the mark to the
  // trailing debounce would resurface them unread on the next visit.
  useEffect(
    () => () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        evaluate()
      }
    },
    [evaluate]
  )
}
