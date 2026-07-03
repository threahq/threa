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
   * panel's scroller). Rows are matched by `data-message-row` — NOT bare
   * `data-message-id`, which editor nodes (quote reply, in-app links) also render
   * inside a composer that may live in this container; observing those would let
   * a quoted message "dwell" beside the cursor and mark rows never on screen. */
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
  /** Fallback stream for rows without their own `streamId` — the same fallback
   * the hosts pass when rendering the row. */
  rootStreamId: string
  /** The controller's per-row derivation — auto-read fires only when something
   * at/below the target is effectively unread, so it is idempotent against the
   * overlay/watermark state and never loops. */
  rowState: ConversationRowRead["state"]
  /** The silent mark-read mutation (`markReadSilently` off the controller). */
  markRead: (messageId: string) => Promise<void>
  /** The controller's `setExplicitUnreadListener`: lets the menu "Mark as
   * unread" pin this hook synchronously BEFORE its request departs — a pending
   * dwell-scheduled mark-read firing mid-flight would otherwise cutoff right
   * back over the explicit unread, with server arrival order deciding. */
  registerExplicitUnread: (listener: (() => void) | null) => void
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
 * - Mark-as-unread pins (the timeline's `pinnedRef`, with leave-and-return as
 *   the resume gesture instead of a scroll, which a small card doesn't have):
 *   an explicit unread — the controller's synchronous signal, or a
 *   read → unread regression from another device — unsees everything and
 *   suppresses EVERY eligible row, holding auto-read entirely until the
 *   suppressions release. All of them, not just the currently-visible set:
 *   visibility is unknowable across observer teardowns (attention loss, id-set
 *   changes), and under-suppressing would let a still-on-screen row dwell and
 *   cutoff-mark right back over the explicit unread. Each row's suppression
 *   releases when the observer reports it off-screen — immediately for rows
 *   that weren't visible, on leave for the ones that were.
 * - A pending debounce fires on unmount, and without re-checking attention:
 *   the dwell already happened while the viewer was attending, so the read is
 *   real — only the batching timer is late.
 * - Optimistic `temp_` rows are never targets (the id doesn't exist
 *   server-side yet); their confirmed swap re-enters normally.
 */
export function useConversationAutoRead({
  containerRef,
  messages,
  rootStreamId,
  rowState,
  markRead,
  registerExplicitUnread,
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

  const seenRef = useRef(new Set<string>())
  const suppressedRef = useRef(new Set<string>())
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

  /** Engage the mark-unread pin: unsee everything, cancel pending work, release
   * the dedup (after the pin lifts, re-reading may legitimately re-target the
   * same newest row), and suppress every eligible row. */
  const pin = useCallback(() => {
    seenRef.current.clear()
    for (const timer of dwellTimersRef.current.values()) clearTimeout(timer)
    dwellTimersRef.current.clear()
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    lastMarkedRef.current = null
    for (const m of eligibleRef.current) suppressedRef.current.add(m.id)
  }, [])

  // The controller invokes this synchronously at the top of the menu "Mark as
  // unread", before the request departs — closing the window where a pending
  // debounce could race the in-flight unread.
  useEffect(() => {
    registerExplicitUnread(pin)
    return () => registerExplicitUnread(null)
  }, [registerExplicitUnread, pin])

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
    if (!canAutoRead || eligibleIdsKey === "") return
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
          // Off-screen is the pin's release gesture for this row — a genuine
          // leave, or a rebuild's initial entries reporting it was never
          // visible at all.
          suppressedRef.current.delete(id)
          cancelDwell(id)
        }
      }
    })
    for (const el of container.querySelectorAll<HTMLElement>("[data-message-row]")) {
      const id = el.dataset.messageId
      if (id && eligibleIds.has(id)) io.observe(el)
    }
    return () => {
      io.disconnect()
      for (const timer of dwellTimersRef.current.values()) clearTimeout(timer)
      dwellTimersRef.current.clear()
    }
  }, [canAutoRead, eligibleIdsKey, containerRef, scheduleEvaluate])

  // The cross-device arm of the pin: watches per-row state for a read → unread
  // regression (a mark-unread applied elsewhere — the local menu action pins
  // synchronously via registerExplicitUnread above, without waiting for its
  // snapshot to land). First run only baselines.
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
    for (const [id, state] of next) {
      if (state === "unread" && prev.get(id) === "read") {
        pin()
        return
      }
    }
  }, [rowState, eligibleIdsKey, rootStreamId, stateOf, pin])

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
