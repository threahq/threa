import { useCallback, useEffect, useRef } from "react"
import type { VirtualizerHandle } from "virtua"
import { deepLinkDebug } from "@/components/timeline/deep-link-debug"

/**
 * Gap between the viewport top and a top-aligned scroll target (the unread
 * divider row): clears the sticky date header and leaves a sliver of context
 * above so the unread run reads from the top. Shared by the jump-to-first-
 * unread pill and the marker-open scroll so both land identically.
 */
export const UNREAD_MARKER_TOP_GAP_PX = 56

/**
 * Consecutive 60ms refine ticks the scroll target must hold its aligned
 * position before `onFirstSettle` fires — long enough that virtua's
 * measurement reflow has genuinely converged, short enough (~180ms) that the
 * anchor restore's skeleton hold is imperceptible on top of the load itself.
 */
const SCROLL_SETTLE_STABLE_TICKS = 3

/** The topmost timeline row intersecting the scroller viewport, with its
 *  offset from the viewport top (negative when partially scrolled off). */
export function snapshotTopVisibleRow(el: HTMLElement): { id: string; offsetPx: number } | null {
  const sr = el.getBoundingClientRect()
  let best: { id: string; top: number } | null = null
  for (const row of el.querySelectorAll<HTMLElement>("[data-message-id], [data-event-id]")) {
    const rr = row.getBoundingClientRect()
    if (rr.bottom <= sr.top + 1 || rr.top >= sr.bottom) continue
    const id = row.dataset.messageId ?? row.dataset.eventId
    if (!id) continue
    if (!best || rr.top < best.top) best = { id, top: rr.top }
  }
  return best ? { id: best.id, offsetPx: Math.round(best.top - sr.top) } : null
}

export type DetachedHold = { id: string; offsetPx: number; takenAt: number }

export interface ScrollToMessageOptions {
  align?: "center" | "start"
  topOffsetPx?: number
  /** Fires exactly once, the first time the target has held its aligned
   *  position for a few ticks — or the loop ends without ever landing
   *  (user abort, timeout, superseded). The anchor restore holds the
   *  cold-load skeleton up until this, so the first revealed frame is
   *  already at the restored position instead of a tail flash. */
  onFirstSettle?: () => void
}

export interface UseScrollToMessageOptions {
  /**
   * Index of `targetId` in the rendered window, resolved at render scope. Gates
   * the entry bail, and its identity is the hook's only data dependency — memoize
   * it on the window so `scrollToMessage` changes exactly when the window does
   * (the callers' convergent drivers re-attempt on that change).
   */
  findIndex: (targetId: string) => number
  /**
   * The same lookup against the *live* window, read on every refine tick. Keep it
   * ref-backed and stable: the window can shift under a running loop, and a stale
   * index makes virtua's offset-tree search dereference an undefined node.
   */
  findLiveIndex: (targetId: string) => number
  scrollerRef: React.RefObject<HTMLElement | null>
  listRef: React.RefObject<VirtualizerHandle | null>
  disableAutoScroll: () => void
  isFollowingTailRef: React.MutableRefObject<boolean>
  /**
   * Sticky "user grabbed the scroller" stamp for the *current* scroll intent.
   * Reset to 0 whenever a new intent is established (deep-link nav, search jump,
   * stream switch) and set by the long-lived input listeners on the scroller
   * (attached by `useTimelineScroll`'s gesture-stamp effect). The refine loop
   * reads it so a manual scroll always wins — including a gesture that began in
   * the rAF gap before the loop attached its own abort listeners. That gap is
   * exactly the "I scroll up to read context, then get yanked back to the linked
   * message" deep-link bug.
   */
  userInteractedAtRef: React.MutableRefObject<number>
  programmaticScrollAtRef: React.MutableRefObject<number>
}

export interface ScrollToMessageApi {
  /** Returns true when a refine loop engaged, false when it bailed. */
  scrollToMessage: (targetId: string, opts?: ScrollToMessageOptions) => boolean
  /** Non-null while a refine loop owns the viewport; calling it aborts the loop. */
  scrollAbortRef: React.MutableRefObject<(() => void) | null>
  /**
   * Rolling detached-viewport snapshot: the topmost visible row and its offset
   * from the viewport top, valid while the reader is parked off the tail.
   * Refreshed by every programmatic scroll's first settle, and by the caller's
   * own debounced scroll snapshot and older-fetch arm — so it always describes
   * the position the reader currently owns. The detached viewport guard re-pins
   * this row when content resizes out from under a parked reader (virtua
   * size-estimate corrections, prepends, late media) — every one of those
   * otherwise slides the viewport through the content.
   */
  detachedHoldRef: React.MutableRefObject<DetachedHold | null>
}

/**
 * Scroll to a specific row — addressed by message id or event id (any row the
 * caller's index resolver finds, including session/command group cards) — and
 * keep re-scrolling until the target element is actually visible in the scroller
 * viewport. Items rendered with estimated heights — and link previews /
 * long-message toggles that resolve later — drift the target after the first
 * scroll; this loop keeps correcting for a bounded window rather than stopping
 * at the first frame that looks right. User input (wheel / touch / key) aborts
 * the loop immediately so manual scrolling always wins. `align: "center"`
 * (default) centers the target (deep links); `align: "start"` pins its top near
 * the viewport top (the unread marker open).
 *
 * This is the *only* thing that should scroll a highlighted row into view, on
 * both scroll modes: an unvirtualized scroller renders every row, so it just
 * takes the DOM branch and never reaches virtua. A second, ungated
 * `scrollIntoView({behavior:"smooth"})` on the row itself used to race this loop
 * — it re-fired every time virtua remounted the row, dragging a reader who had
 * scrolled away back to the match.
 *
 * Implementation notes: `scrollToIndex` expects the 0-based index within the
 * current data array (NOT firstItemIndex + idx). Once the item is rendered in
 * the DOM we use native `scrollTop` on the scroller to position it precisely —
 * this sidesteps the virtualizer's internal offset estimation, which tends to
 * overshoot with unmeasured items.
 */
export function useScrollToMessage({
  findIndex,
  findLiveIndex,
  scrollerRef,
  listRef,
  disableAutoScroll,
  isFollowingTailRef,
  userInteractedAtRef,
  programmaticScrollAtRef,
}: UseScrollToMessageOptions): ScrollToMessageApi {
  const scrollRetryTimerRef = useRef<number | null>(null)
  const scrollAbortRef = useRef<(() => void) | null>(null)
  const detachedHoldRef = useRef<DetachedHold | null>(null)
  const findLiveIndexRef = useRef(findLiveIndex)
  findLiveIndexRef.current = findLiveIndex

  const scrollToMessage = useCallback(
    (targetId: string, opts?: ScrollToMessageOptions) => {
      const align = opts?.align ?? "center"
      const engagedAt = performance.now()
      let settleNotified = false
      let stableTicks = 0
      let everLanded = false
      const notifySettled = () => {
        if (settleNotified) return
        settleNotified = true
        // A genuine landing (or a user takeover) is the reader's new owned
        // position: refresh the detached-viewport snapshot so the guard
        // protects the landed spot instead of a stale pre-jump one. A timeout
        // that never landed must NOT overwrite it — the caller-seeded target
        // stays, and the guard keeps pulling toward it on later reflows.
        const scrollerNow = scrollerRef.current
        const userTookOver = userInteractedAtRef.current > engagedAt
        if (scrollerNow && !isFollowingTailRef.current && (everLanded || userTookOver)) {
          const snap = snapshotTopVisibleRow(scrollerNow)
          detachedHoldRef.current = snap ? { ...snap, takenAt: performance.now() } : null
        }
        opts?.onFirstSettle?.()
      }
      // For "start": px between the viewport top and the target's top. The
      // unread-marker default leaves a small context gap; an anchor restore
      // passes the exact (possibly negative) offset the reader detached at.
      const topOffsetPx = opts?.topOffsetPx ?? UNREAD_MARKER_TOP_GAP_PX
      if (findIndex(targetId) < 0) {
        deepLinkDebug("scrollToMessage bail: target not a timeline item yet", targetId)
        return false
      }
      // The user already took manual control for this scroll intent (e.g.
      // started scrolling while a jump was loading the window). Don't start a
      // retry loop that would fight them back to the target — the mount anchor
      // already placed it close enough.
      if (userInteractedAtRef.current > 0) {
        deepLinkDebug("scrollToMessage bail: user already interacting", targetId)
        return false
      }

      // Cancel any previous retry loop
      if (scrollRetryTimerRef.current !== null) {
        window.clearTimeout(scrollRetryTimerRef.current)
        scrollRetryTimerRef.current = null
      }
      scrollAbortRef.current?.()
      scrollAbortRef.current = null

      // Disable auto-scroll so tail-following doesn't snap back to bottom
      // while we're trying to scroll the target into view.
      disableAutoScroll()

      const scroller = scrollerRef.current
      if (!scroller) {
        deepLinkDebug("scrollToMessage bail: scroller not attached yet", targetId)
        return false
      }

      // Abort the retry loop the moment the user takes over
      let aborted = false
      const abort = () => {
        aborted = true
        notifySettled()
        if (scrollRetryTimerRef.current !== null) {
          window.clearTimeout(scrollRetryTimerRef.current)
          scrollRetryTimerRef.current = null
        }
        scroller.removeEventListener("wheel", abort)
        scroller.removeEventListener("touchmove", abort)
        scroller.removeEventListener("keydown", abort)
        scrollAbortRef.current = null
      }
      scrollAbortRef.current = abort
      scroller.addEventListener("wheel", abort, { passive: true })
      scroller.addEventListener("touchmove", abort, { passive: true })
      scroller.addEventListener("keydown", abort)

      const started = performance.now()
      // The loop watches for the whole window rather than stopping the moment
      // the target first looks settled: a link preview card resolving above the
      // target lands ~800ms after the window renders and shoves the target down
      // under a reader already looking at it. Any real input aborts within one
      // tick (the listeners above plus the shared gesture stamp, which also
      // covers a scrollbar drag), so watching costs the user nothing.
      const MAX_MS = 1200

      const attempt = () => {
        if (aborted) return
        // A manual scroll landed after this loop began (caught by the
        // long-lived scroller listeners even for a gesture that started
        // before this loop's own abort listeners attached). Hand control
        // back instead of re-centering on the target.
        if (userInteractedAtRef.current > 0) {
          abort()
          return
        }

        // Message rows carry both attributes; non-message rows (session cards,
        // command groups, retitles) only data-event-id — one query serves any
        // row the unread divider can anchor on.
        const escaped = CSS.escape(targetId)
        const el = scroller.querySelector<HTMLElement>(`[data-message-id="${escaped}"], [data-event-id="${escaped}"]`)

        if (el) {
          // Target is rendered — scroll via DOM so we get pixel-precise positioning
          const sr = scroller.getBoundingClientRect()
          const er = el.getBoundingClientRect()
          const scCenter = (sr.top + sr.bottom) / 2
          // "start" pins the target's top at topOffsetPx below the viewport
          // top (the unread marker open, an anchor restore). "center" is the
          // deep-link behavior, unchanged.
          const desiredTop = sr.top + topOffsetPx
          const delta = align === "start" ? er.top - desiredTop : (er.top + er.bottom) / 2 - scCenter
          if (Math.abs(delta) > 2) {
            programmaticScrollAtRef.current = performance.now()
            scroller.scrollTop += delta
            stableTicks = 0
          } else {
            everLanded = true
            if (++stableTicks >= SCROLL_SETTLE_STABLE_TICKS) {
              // Landed and holding — the loop keeps watching for late reflows
              // (link previews), but the position is presentable now.
              notifySettled()
            }
          }
        } else {
          stableTicks = 0
          // Target is virtualized out — ask the virtualizer to render it
          // (0-based index). Re-resolve against the live window every tick: it
          // can shift under this loop, and a stale/out-of-range index makes the
          // offset-tree binary search dereference an undefined node, throwing
          // "Cannot read properties of undefined (reading 'index')" which
          // crashes the whole route.
          const liveIdx = findLiveIndexRef.current(targetId)
          // liveIdx < 0 means the target is transiently out of the window
          // (e.g. a jump-window swap mid-flight). Skip this tick rather than
          // scroll to a wrong index; a later tick retries once it reappears,
          // and MAX_MS still bounds the loop if it never does.
          if (liveIdx >= 0) {
            try {
              programmaticScrollAtRef.current = performance.now()
              listRef.current?.scrollToIndex(
                liveIdx,
                align === "start" ? { align: "start", offset: -topOffsetPx } : { align: "center" }
              )
            } catch {
              // virtua can still throw internally on a freshly mounted,
              // not-yet-measured list. Non-fatal: the next tick retries once
              // sizes are populated, or the DOM path takes over once the row
              // renders.
            }
          }
        }

        const elapsed = performance.now() - started
        if (elapsed < MAX_MS) {
          scrollRetryTimerRef.current = window.setTimeout(attempt, 60)
        } else {
          abort()
        }
      }
      deepLinkDebug("scrollToMessage: refine loop engaged", targetId)
      attempt()
      return true
    },
    [
      findIndex,
      listRef,
      disableAutoScroll,
      scrollerRef,
      isFollowingTailRef,
      userInteractedAtRef,
      programmaticScrollAtRef,
    ]
  )

  useEffect(() => {
    return () => {
      scrollAbortRef.current?.()
    }
  }, [])

  return { scrollToMessage, scrollAbortRef, detachedHoldRef }
}
