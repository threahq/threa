import { useCallback, useEffect, useRef } from "react"
import { useAutoReadAttention } from "@/hooks/use-auto-mark-as-read"
import type { RowReadState } from "@/components/timeline/read-frontier-context"
import type { ConversationRowRead } from "@/components/message/conversation-read-context"
import type { RenderableMessage } from "@/components/message/message-item"

/**
 * Flag-gated tracer (`window.__threaAutoReadDebug = true`, then reload) — the
 * whole pipeline is invisible timers and observer callbacks, so a staging "it
 * didn't mark" report is undiagnosable without seeing which stage stopped
 * (armed → seen → evaluate → fire). Mirrors `deepLinkDebug` in stream-content.
 */
function autoReadDebug(...args: unknown[]) {
  if (typeof window !== "undefined" && (window as { __threaAutoReadDebug?: boolean }).__threaAutoReadDebug) {
    console.debug("[auto-read]", ...args)
  }
}

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
   * The rows eligible for auto-read: the surface's rendered rows, chronological.
   * Marking is a `createdAt` cutoff (ConversationService.markRead), so a mark
   * through a rendered row also covers older rows the surface is hiding (a
   * collapsed card's "N more" middle, a panel's still-backfilling older
   * replies) — deliberate: reading a conversation's visible tail reads it up to
   * there, the same contract as the menu's "Mark as read up to here" on that
   * row. The array need not be referentially stable; effects key on the id set.
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
  /** The controller's `getReadTruth`: raw per-stream watermark sequence +
   * overlay ids, diffed to catch a cross-device mark-unread. See the pin notes
   * on the hook doc for why this is raw truth and not derived row state. */
  getReadTruth: (streamId: string) => { lastReadSequence: string | null; readMessageIds: readonly string[] }
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
 *   an explicit unread — the controller's synchronous signal, or a RAW
 *   read-truth regression from another device (watermark sequence decreasing,
 *   or overlay ids removed without a compensating watermark advance, on a row
 *   this surface shows) — unsees everything and suppresses EVERY eligible
 *   row, holding auto-read entirely until the suppressions release. The
 *   cross-device arm deliberately watches raw primitives, never derived row
 *   state: derivation flaps (the `unreadCounts === 0` short-circuit falling
 *   back to a stale frontier when a count leaves zero, a stale `lastReadAt`
 *   time fallback after compaction) would read as mass regressions and
 *   false-pin. Suppression covers all eligible rows, not just the
 *   currently-visible set: visibility is unknowable across observer teardowns
 *   (attention loss, id-set changes), and under-suppressing would let a
 *   still-on-screen row dwell and cutoff-mark right back over the explicit
 *   unread.
 * - Pin release — the mark sticks while the viewer keeps looking (that IS the
 *   pin's purpose) and lifts only at the next genuine RE-ATTENTION boundary,
 *   never on a timer. Two boundaries release it:
 *   (a) Per-row viewport exit — a row's observer reporting it off-screen
 *       releases that row's suppression (immediately for rows that were never
 *       visible after a rebuild, on leave for the ones that were). A static
 *       board never fires this, which is why (b) exists.
 *   (b) Attention cycle — a blur→refocus (or hide→show on a phone-like device,
 *       per `useAutoReadAttention`) lifts the whole pin, but only once the
 *       viewer has ATTENDED to it: a pin engaged while attentive that then
 *       loses and regains attention has crossed the boundary; a pin engaged
 *       while attention is off (a background cross-device regression) treats
 *       the coming refocus as the viewer's first look, not a boundary, and
 *       waits for the cycle AFTER that. This is the board wedge fix — a static,
 *       continuously-focused card that earlier never released now releases the
 *       moment the viewer tabs away and back.
 *   Unmounting the surface (panel close, card scrolled off the board window)
 *   discards the pin with the hook's refs; a remount re-reads from a clean
 *   slate, so navigate-away-and-back is a third, implicit release.
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
  getReadTruth,
}: UseConversationAutoReadOptions): void {
  const canAutoRead = useAutoReadAttention()
  const canAutoReadRef = useRef(canAutoRead)
  canAutoReadRef.current = canAutoRead

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
  // The attention-cycle release state (see the pin doc): whether the viewer has
  // attended to the page since the pin engaged, and whether attention has since
  // dropped. A pin engaged while attentive that then loses and regains attention
  // has crossed a full re-attention boundary and releases.
  const pinAttendedRef = useRef(false)
  const pinBlurredAfterAttendedRef = useRef(false)

  const stateOf = useCallback(
    (m: RenderableMessage): RowReadState =>
      rowStateRef.current(m.streamId ?? rootStreamIdRef.current, m.id, m.sequence, m.createdAt),
    []
  )

  const evaluate = useCallback(() => {
    debounceRef.current = null
    // An active pin blocks firing entirely (not just for the pinned rows): the
    // cutoff means marking through ANY newer row would undo the explicit unread.
    if (suppressedRef.current.size > 0) {
      autoReadDebug("evaluate: pinned", { suppressed: [...suppressedRef.current] })
      return
    }
    const rows = eligibleRef.current
    let targetIdx = -1
    for (let i = 0; i < rows.length; i++) {
      if (seenRef.current.has(rows[i].id)) targetIdx = i
    }
    if (targetIdx < 0) {
      autoReadDebug("evaluate: nothing seen", { eligible: rows.map((m) => m.id) })
      return
    }
    const target = rows[targetIdx]
    if (lastMarkedRef.current === target.id) return
    // Fire only when the cutoff would actually read something: any row at/below
    // the target effectively unread. All-read (another device, a prior mark) and
    // all-ungated (no resolvable frontier) both no-op.
    let anyUnread = false
    for (let i = 0; i <= targetIdx && !anyUnread; i++) {
      if (stateOf(rows[i]) === "unread") anyUnread = true
    }
    if (!anyUnread) {
      autoReadDebug("evaluate: nothing unread at/below target", {
        target: target.id,
        states: rows.slice(0, targetIdx + 1).map((m) => `${m.id}=${stateOf(m)}`),
      })
      return
    }
    autoReadDebug("evaluate: firing markRead", { target: target.id })
    lastMarkedRef.current = target.id
    markReadRef.current(target.id).catch((err) => {
      autoReadDebug("markRead failed", err)
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
    autoReadDebug("pin engaged")
    seenRef.current.clear()
    for (const timer of dwellTimersRef.current.values()) clearTimeout(timer)
    dwellTimersRef.current.clear()
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    lastMarkedRef.current = null
    for (const m of eligibleRef.current) suppressedRef.current.add(m.id)
    // Baseline the attention-cycle release: a pin engaged while the viewer is
    // attending starts "attended", so the next blur→refocus releases it. A pin
    // engaged while attention is off (a cross-device regression that lands in
    // the background) is NOT attended yet — the coming refocus is the viewer's
    // FIRST look at it, not a re-attention boundary, so it must not release.
    pinAttendedRef.current = canAutoReadRef.current
    pinBlurredAfterAttendedRef.current = false
  }, [])

  /** Lift the whole pin (all suppressions) — the attention-cycle release. */
  const releasePin = useCallback(() => {
    suppressedRef.current.clear()
    pinAttendedRef.current = false
    pinBlurredAfterAttendedRef.current = false
    // Rows that became `seen` mid-pin (a reply streaming in dwells into seenRef
    // while evaluate is blocked) re-fire as already-seen after release and never
    // re-schedule — evaluate once now so they mark immediately instead of
    // waiting for an unrelated future dwell.
    scheduleEvaluate()
  }, [scheduleEvaluate])

  // The controller invokes this synchronously at the top of the menu "Mark as
  // unread", before the request departs — closing the window where a pending
  // debounce could race the in-flight unread.
  useEffect(() => {
    registerExplicitUnread(pin)
    return () => registerExplicitUnread(null)
  }, [registerExplicitUnread, pin])

  // The attention-cycle arm of the pin release: a blur→refocus (or, on a
  // phone-like device, a hide→show) after the viewer has attended to the pin is
  // a genuine re-attention boundary — the pin has served its "don't re-read what
  // I just marked" purpose and lifts. Runs before the observer effect so the
  // rebuilt observer re-arms against cleared suppressions.
  useEffect(() => {
    if (suppressedRef.current.size === 0) {
      pinAttendedRef.current = false
      pinBlurredAfterAttendedRef.current = false
      return
    }
    if (canAutoRead) {
      if (pinBlurredAfterAttendedRef.current) {
        autoReadDebug("pin: released on re-attention")
        releasePin()
      } else {
        pinAttendedRef.current = true
      }
    } else if (pinAttendedRef.current) {
      pinBlurredAfterAttendedRef.current = true
    }
  }, [canAutoRead, releasePin])

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
    if (!canAutoRead || eligibleIdsKey === "") {
      autoReadDebug("observer: off", { canAutoRead, eligible: eligibleIdsKey })
      return
    }
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
              autoReadDebug("seen", { id })
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
    let observed = 0
    for (const el of container.querySelectorAll<HTMLElement>("[data-message-row]")) {
      const id = el.dataset.messageId
      if (id && eligibleIds.has(id)) {
        io.observe(el)
        observed++
      }
    }
    autoReadDebug("observer: armed", { eligible: [...eligibleIds], observed })
    return () => {
      io.disconnect()
      for (const timer of dwellTimersRef.current.values()) clearTimeout(timer)
      dwellTimersRef.current.clear()
    }
  }, [canAutoRead, eligibleIdsKey, containerRef, scheduleEvaluate])

  // The cross-device arm of the pin: diff RAW per-stream read truth (the local
  // menu action pins synchronously via registerExplicitUnread above, without
  // waiting for its snapshot to land). A stream regresses when its watermark
  // sequence decreases, or when overlay ids vanish without the watermark
  // advancing (compaction drops ids but always advances; a message move drops
  // ids but the row leaves the stream too). Pin only when the regression
  // exposes a row THIS surface shows: previously covered by the old truth
  // (id in the old overlay, or sequence at/below the old watermark) and now
  // deriving unread — that is an actual mark-unread of on-surface content, not
  // a move artifact. First run only baselines. Derived row state is NEVER the
  // trigger — see the pin notes above.
  const prevTruthRef = useRef<Map<string, { seq: bigint | null; overlay: Set<string> }> | null>(null)
  useEffect(() => {
    const eligibleIds = new Set(eligibleRef.current.map((m) => m.id))
    // Rows that left the conversation (deleted, re-clustered) can't hold a pin
    // or a seen slot forever.
    for (const id of suppressedRef.current) if (!eligibleIds.has(id)) suppressedRef.current.delete(id)
    for (const id of seenRef.current) if (!eligibleIds.has(id)) seenRef.current.delete(id)

    const streamIds = new Set<string>([rootStreamIdRef.current])
    for (const m of eligibleRef.current) if (m.streamId) streamIds.add(m.streamId)
    const next = new Map<string, { seq: bigint | null; overlay: Set<string> }>()
    for (const streamId of streamIds) {
      const truth = getReadTruth(streamId)
      next.set(streamId, {
        seq: truth.lastReadSequence != null ? BigInt(truth.lastReadSequence) : null,
        overlay: new Set(truth.readMessageIds),
      })
    }
    const prev = prevTruthRef.current
    prevTruthRef.current = next
    if (!prev) return

    for (const [streamId, truth] of next) {
      const before = prev.get(streamId)
      if (!before) continue
      const seqRegressed = truth.seq != null && before.seq != null && truth.seq < before.seq
      const advanced = truth.seq != null && before.seq != null && truth.seq > before.seq
      let overlayDropped = false
      if (!advanced) {
        for (const id of before.overlay) {
          if (!truth.overlay.has(id)) {
            overlayDropped = true
            break
          }
        }
      }
      if (!seqRegressed && !overlayDropped) continue
      for (const m of eligibleRef.current) {
        if ((m.streamId ?? rootStreamIdRef.current) !== streamId) continue
        const wasCovered =
          before.overlay.has(m.id) || (m.sequence != null && before.seq != null && BigInt(m.sequence) <= before.seq)
        if (wasCovered && stateOf(m) === "unread") {
          autoReadDebug("pin: read-truth regression", { streamId, row: m.id })
          pin()
          return
        }
      }
    }
  }, [rowState, eligibleIdsKey, rootStreamId, getReadTruth, stateOf, pin])

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
