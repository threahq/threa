import { useEffect, useRef } from "react"
import { useUnreadCounts } from "./use-unread-counts"
import { useActivityCounts } from "./use-activity-counts"
import { usePageActivity } from "./use-page-activity"
import { computeAutoReadAttention } from "@/lib/auto-read-attention"
import { useReadCommitQueue } from "@/sync/read-commit-queue"
import { useIsMobile } from "./use-mobile"
import { useCoarsePointer } from "./use-pointer"

interface UseAutoMarkAsReadOptions {
  enabled?: boolean
  /**
   * When true, `lastEventId` is the bottom of what the viewer has seen, not the
   * tail of the loaded window — unread messages remain below the fold. The read
   * pointer advances to `lastEventId`, but the unread badge is NOT optimistically
   * zeroed; the server `stream:read` round-trip sets the true remaining count
   * (Slack-style progressive read). Defaults false: mark fully read as before.
   */
  partial?: boolean
  /**
   * The viewer's persisted read pointer (server watermark). Fallback anchor for
   * the activity heal: an activity whose stream has nothing unread AND nothing
   * trailing the watermark (a `member_added` born-read at the tail pins exactly
   * that) produces no frontier advance, so without this anchor the mark that
   * dismisses it can never fire and the sidebar row stays lit through every
   * visit. Committing the pointer itself is a monotonic no-op advance
   * server-side; only the handler's activity clear has effect.
   */
  readPointerEventId?: string | null
  /** Whether the timeline tail is actually visible; required for pointer-only activity healing. */
  activityHealEnabled?: boolean
}

/**
 * Whether the viewer's attention is plausibly on this page — the shared gate for
 * every auto-read surface (stream timeline here, conversation surfaces via
 * `useConversationAutoRead`) AND the optimistic viewing pin in the
 * `stream:activity` counter apply (via `isAutoReadAttentiveNow`). The formula
 * and its rationale live in `lib/auto-read-attention.ts`. This relaxation is
 * deliberately local to auto-read; `usePageActivity().isActive` stays the
 * strict visible-and-focused signal its other consumers (socket, connection
 * status, app-update) rely on.
 */
export function useAutoReadAttention(): boolean {
  const { isVisible, isFocused } = usePageActivity()
  const isMobile = useIsMobile()
  const isCoarsePointer = useCoarsePointer()
  return computeAutoReadAttention({ isVisible, isFocused, isMobile, isCoarsePointer })
}

/**
 * The view-layer half of auto-read: decide WHETHER what the frontier counted
 * as seen should be marked (attention, elevation, dedup against the last
 * committed mark), and report it to the workspace's `ReadCommitQueue`. The
 * queue owns all commit mechanics — debounce, coalescing, flush on
 * leave/pagehide — so component lifecycle can never lose a mark the viewer
 * earned (the #1881 glance-triage bug lived exactly in that gap).
 *
 * Checks unread counts, mention counts, AND activity counts — the mark-as-read
 * API clears all of these, so this must fire when any is elevated (e.g.,
 * activity arrives via the outbox handler while viewing the stream).
 *
 * `lastEventId` is the furthest event the viewer has actually scrolled into
 * view (see `useLastSeenEvent`), not the last loaded event — read state never
 * runs ahead of what the user has seen.
 */
export function useAutoMarkAsRead(
  workspaceId: string,
  streamId: string,
  lastEventId: string | undefined,
  options: UseAutoMarkAsReadOptions = {}
) {
  const { enabled = true, partial = false, readPointerEventId = null, activityHealEnabled = true } = options
  const { getUnreadCount } = useUnreadCounts(workspaceId)
  const { getActivityCount } = useActivityCounts(workspaceId)
  const canAutoRead = useAutoReadAttention()
  const queue = useReadCommitQueue()
  // Effect DEPS, not just reads: both hooks subscribe this component to the
  // unread store, so an `activity:created` landing while the frontier is
  // unchanged re-runs the effect through these values and re-fires the mark
  // that clears it. The old code got that re-fire by accident — `markAsRead`'s
  // identity churned every render, re-running the effect — so stable deps
  // alone would silently kill the activity-arrival re-mark (witness finding
  // on #1882).
  const unreadCount = getUnreadCount(streamId)
  const activityCount = getActivityCount(streamId)

  const streamIdRef = useRef(streamId)
  streamIdRef.current = streamId

  // A fresh open of a stream forgets its committed-mark dedup, so a fully-read
  // open still heals server-side activity once per open (D5) — the consumer
  // (StreamContent) is not keyed by streamId, so this hook persists across
  // switches.
  useEffect(() => {
    queue.resetCommitted(streamId)
  }, [queue, streamId])

  useEffect(() => {
    // Activity heal at the watermark: an elevated activity count with NO
    // frontier advance available — nothing unread, nothing trailing the read
    // pointer (born-read `member_added` pins the pointer at the tail) — would
    // otherwise be permanently undismissable, because the dismissal signal
    // rides on the mark this hook fires. Anchor the mark at the pointer
    // itself: the server advance is a monotonic no-op, the activity clear
    // runs. Sent partial so no counter is optimistically zeroed off a
    // possibly-stale local 0. Gated on `unreadCount === 0`: with real unread
    // below, the normal frontier path owns the (partial) mark that clears
    // activity, and healing early would race a mark-unread's restored badges.
    const healEventId =
      activityHealEnabled && !lastEventId && activityCount > 0 && unreadCount === 0 && readPointerEventId
        ? readPointerEventId
        : undefined
    const reportEventId = lastEventId ?? healEventId
    const reportPartial = lastEventId ? partial : true
    if (!enabled || !canAutoRead) {
      // The gate closed with a mark still debouncing: drop it, matching the
      // pre-queue semantics — a blur cancels rather than commits, so content
      // glimpsed right before switching windows stays unread (never
      // over-mark). The next attentive pass re-reports the frontier.
      queue.cancel(streamId)
      return
    }
    // No frontier to report leaves a debouncing mark alone: the rows it names
    // were seen while attentive, and the frontier clears for reasons that say
    // nothing about that — the pointer caught up, or turned unknowable while
    // the event window changed source. An explicit unread cancels through the
    // queue itself (`runExplicitUnread`).
    if (!reportEventId) return

    // D5 heal: a fully-read (`!partial`) open still fires one commit even when
    // nothing is locally elevated. `lastEventId` is then the true tail, so the
    // resulting `stream:read` clears server-side activity that arrived with no
    // new message to scroll past (e.g. a reaction while caught up) and couples
    // other devices. The committed record gates it to once per caught-up tail.
    // A PARTIAL (mid-window frontier) open with nothing elevated still no-ops —
    // its `lastEventId` isn't the tail, so emitting `stream:read` would be wrong.
    if (unreadCount === 0 && activityCount === 0 && reportPartial) return

    // Skip if this exact mark was already committed AND no pending activities
    // to clear. Activities can arrive via activity:created while we're viewing
    // the stream (the outbox handler is async), so we must re-fire to clear
    // them even if lastEventId hasn't changed; likewise a partial→full
    // transition at the same event must re-fire to clear the badge. Cancelled
    // (never-sent) marks are not in the committed record, so a blur-parked
    // mark re-reports after refocus.
    const committed = queue.lastCommitted(streamId)
    if (
      committed &&
      committed.lastEventId === reportEventId &&
      committed.partial === reportPartial &&
      activityCount === 0
    ) {
      return
    }

    queue.report(streamId, reportEventId, reportPartial)

    return () => {
      // Leaving the stream flushes its pending mark — the frontier already
      // counted the rows as seen; the debounce is network coalescing, not a
      // dwell requirement. Same-stream re-runs fall through: the next report
      // replaces the pending mark instead.
      if (streamIdRef.current !== streamId) queue.flush(streamId)
    }
  }, [
    enabled,
    streamId,
    lastEventId,
    partial,
    queue,
    unreadCount,
    activityCount,
    canAutoRead,
    readPointerEventId,
    activityHealEnabled,
  ])

  // Unmounting the stream page entirely (navigating to drafts/board) is the
  // other leave path — flush whatever stream was current.
  useEffect(() => {
    return () => {
      queue.flush(streamIdRef.current)
    }
  }, [queue])
}
