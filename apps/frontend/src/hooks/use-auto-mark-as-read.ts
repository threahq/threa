import { useEffect, useRef } from "react"
import { useUnreadCounts } from "./use-unread-counts"
import { useActivityCounts } from "./use-activity-counts"
import { usePageActivity } from "./use-page-activity"
import { computeAutoReadAttention } from "@/lib/auto-read-attention"
import { useIsMobile } from "./use-mobile"
import { useCoarsePointer } from "./use-pointer"

interface UseAutoMarkAsReadOptions {
  enabled?: boolean
  debounceMs?: number
  /**
   * When true, `lastEventId` is the bottom of what the viewer has seen, not the
   * tail of the loaded window — unread messages remain below the fold. The read
   * pointer advances to `lastEventId`, but the unread badge is NOT optimistically
   * zeroed; the server `stream:read` round-trip sets the true remaining count
   * (Slack-style progressive read). Defaults false: mark fully read as before.
   */
  partial?: boolean
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
 * Hook that automatically marks a stream as read when viewing it.
 * Debounces the mark-as-read call to avoid excessive API calls when rapidly switching streams.
 *
 * Checks unread counts, mention counts, AND activity counts — the mark-as-read API
 * clears all of these, so this must fire when any is elevated (e.g., activity arrives
 * via the outbox handler while viewing the stream).
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
  const { enabled = true, debounceMs = 500, partial = false } = options
  const { markAsRead, getUnreadCount } = useUnreadCounts(workspaceId)
  const { getActivityCount } = useActivityCounts(workspaceId)
  const canAutoRead = useAutoReadAttention()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The mark the running debounce timer would send, so teardown can FLUSH it
  // instead of dropping it. The debounce is network coalescing, not a dwell
  // requirement: the frontier already said "seen", so a stream switch or
  // unmount inside the window must still commit the mark — cancelling it was
  // the glance-triage bug (open an unread stream, glance, move on within a
  // second → the stream stayed unread on the server, invisibly, because the
  // local viewing-pin had already zeroed the badge).
  const pendingRef = useRef<{ streamId: string; lastEventId: string; partial: boolean } | null>(null)
  const lastMarkedRef = useRef<string | null>(null)
  // Track the partial-ness of the last mark so a partial→full transition at the
  // SAME event (viewer scrolled partway, then on to the tail) re-fires to clear
  // the badge optimistically instead of waiting on the server round-trip.
  const lastMarkedPartialRef = useRef<boolean | null>(null)

  // Use refs to avoid stale closure in setTimeout callback
  const streamIdRef = useRef(streamId)
  const lastEventIdRef = useRef(lastEventId)
  const partialRef = useRef(partial)
  streamIdRef.current = streamId
  lastEventIdRef.current = lastEventId
  partialRef.current = partial
  const markAsReadRef = useRef(markAsRead)
  markAsReadRef.current = markAsRead

  // Unmount flush: navigating off the stream page entirely (drafts, board)
  // unmounts the consumer with the debounce still pending — commit it.
  // Defined ABOVE the debounce effect: React runs unmount cleanups in
  // definition order, and the debounce effect's own cleanup clears pendingRef.
  useEffect(() => {
    return () => {
      const pending = pendingRef.current
      pendingRef.current = null
      if (pending) markAsReadRef.current(pending.streamId, pending.lastEventId, { partial: pending.partial })
    }
  }, [])

  // The consumer (StreamContent) is not keyed by streamId, so this hook persists
  // across stream switches. Clear the dedup refs per stream — otherwise a prior
  // stream's marked event/partial-ness could suppress the first auto-mark in the
  // next stream.
  useEffect(() => {
    lastMarkedRef.current = null
    lastMarkedPartialRef.current = null
  }, [streamId])

  useEffect(() => {
    if (!enabled || !lastEventId || !canAutoRead) return

    const unreadCount = getUnreadCount(streamId)
    const activityCount = getActivityCount(streamId)

    // D5 heal: a fully-read (`!partial`) open still fires `markAsRead` once even
    // when nothing is locally elevated. `lastEventId` is then the true tail, so
    // the resulting `stream:read` clears server-side activity that arrived with no
    // new message to scroll past (e.g. a reaction while caught up) and couples
    // other devices. The dedup ref below gates it to once per caught-up tail. A
    // PARTIAL (mid-window frontier) open with nothing elevated still no-ops —
    // its `lastEventId` isn't the tail, so emitting `stream:read` would be wrong.
    if (unreadCount === 0 && activityCount === 0 && partial) return

    // Skip if already marked this event at the same partial-ness AND no pending
    // activities to clear. Activities can arrive via activity:created while we're
    // viewing the stream (the outbox handler is async), so we must re-fire to
    // clear them even if lastEventId hasn't changed; likewise a partial→full
    // transition at the same event must re-fire to clear the badge.
    if (lastMarkedRef.current === lastEventId && lastMarkedPartialRef.current === partial && activityCount === 0) return

    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }

    timerRef.current = setTimeout(() => {
      // Read current values at execution time, not capture time, so re-arms
      // within the same stream always send the newest frontier.
      const currentStreamId = streamIdRef.current
      const currentLastEventId = lastEventIdRef.current
      pendingRef.current = null
      if (currentLastEventId) {
        markAsRead(currentStreamId, currentLastEventId, { partial: partialRef.current })
        lastMarkedRef.current = currentLastEventId
        lastMarkedPartialRef.current = partialRef.current
      }
    }, debounceMs)
    pendingRef.current = { streamId, lastEventId, partial }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
      const pending = pendingRef.current
      pendingRef.current = null
      // A stream switch mid-debounce flushes the old stream's mark (the
      // frontier had already counted it as seen); same-stream re-arms and the
      // attention gate dropping (blur) keep the existing cancel semantics —
      // the next arming run re-captures the freshest frontier.
      if (pending && pending.streamId !== streamIdRef.current) {
        markAsRead(pending.streamId, pending.lastEventId, { partial: pending.partial })
      }
    }
  }, [enabled, streamId, lastEventId, partial, debounceMs, markAsRead, getUnreadCount, getActivityCount, canAutoRead])
}
