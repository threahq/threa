import { useEffect, useRef, useState } from "react"

/** How long an older-page fetch must be in flight before skeleton rows render,
 *  so a fast response never flashes them. */
export const OLDER_SKELETON_APPEAR_DELAY_MS = 150

/** Grace period after the fetch settles for the prepend to land (IDB live-query
 *  propagation runs a couple of renders behind the query). Past it the tracker
 *  clears so a failed or empty page can't leave skeletons hanging. */
export const OLDER_SKELETON_SETTLE_GRACE_MS = 1000

/**
 * Whether skeleton placeholder rows render at the head of the timeline while
 * an older page is in flight.
 *
 * `trackedOldestEventId` is the oldest rendered event id captured when the
 * fetch started (null = no fetch tracked, which also covers top-of-history:
 * with `hasOlderEvents` false no fetch ever starts, so nothing is tracked).
 * Comparing it against the CURRENT oldest id — instead of `isFetchingOlder`,
 * which flips false a render or two before the IDB live query re-emits with
 * the new page — makes removal land in the same render as the prepend: the
 * skeletons leave and the real rows arrive in one items-array swap, one
 * `shift` computation, with no intermediate frame where the list is N rows
 * shorter (INV-21).
 */
export function shouldShowOlderSkeletons(args: {
  trackedOldestEventId: string | null
  currentOldestEventId: string | null
  appearDelayElapsed: boolean
}): boolean {
  if (args.trackedOldestEventId === null || !args.appearDelayElapsed) return false
  return args.currentOldestEventId === args.trackedOldestEventId
}

/**
 * Tracks each older fetch from its start: captures the oldest rendered event
 * id, shows skeletons once the fetch outlives the appear delay, and hides them
 * the moment the oldest id changes — the same render the prepend lands, which
 * `prependLanded` reports.
 */
export function useOlderSkeletons(args: { oldestEventId: string | null; isFetchingOlder: boolean; enabled: boolean }): {
  showSkeletons: boolean
  prependLanded: boolean
} {
  const { oldestEventId, isFetchingOlder, enabled } = args
  const oldestEventIdRef = useRef(oldestEventId)
  oldestEventIdRef.current = oldestEventId
  const [trackedId, setTrackedId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  // Arm the tracker whenever a fetch is in flight and nothing is tracked.
  // Gated on the tracker being empty (not just the isFetchingOlder rising
  // edge) so it self-re-arms when a prepend lands mid-fetch: with
  // back-to-back pages, fetch N+1 can start before fetch N's rows have
  // propagated out of IDB, so a rising-edge capture would record the stale
  // pre-page-N head — page N landing would then retire the tracker and leave
  // fetch N+1 with no skeleton coverage. Instead the landed cleanup below
  // clears the tracker and this effect immediately re-arms it against the
  // new head while the fetch is still in flight.
  useEffect(() => {
    if (!isFetchingOlder || !enabled || trackedId !== null) return
    setTrackedId(oldestEventIdRef.current)
  }, [isFetchingOlder, enabled, trackedId])

  // Appear delay counts only while the fetch is in flight: a response that
  // settles first (an empty final page lands well under the delay) must
  // never show skeletons during the settle grace.
  useEffect(() => {
    if (trackedId === null) {
      setReady(false)
      return
    }
    if (!isFetchingOlder) return
    const timer = window.setTimeout(() => setReady(true), OLDER_SKELETON_APPEAR_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [trackedId, isFetchingOlder])

  // The prepend landed (or the stream switched): visibility already dropped in
  // that same render via shouldShowOlderSkeletons; this just retires the
  // tracker so the next fetch starts clean.
  const prependLanded = trackedId !== null && oldestEventId !== trackedId
  useEffect(() => {
    if (prependLanded) setTrackedId(null)
  }, [prependLanded])

  // Fetch settled without a prepend (failed request, or the final page was
  // empty): give the IDB live query a grace window, then clear so skeletons
  // can't hang. A new fetch re-arms via the effect above.
  useEffect(() => {
    if (trackedId === null || isFetchingOlder) return
    const timer = window.setTimeout(() => setTrackedId(null), OLDER_SKELETON_SETTLE_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [trackedId, isFetchingOlder])

  const showSkeletons =
    enabled &&
    shouldShowOlderSkeletons({
      trackedOldestEventId: trackedId,
      currentOldestEventId: oldestEventId,
      appearDelayElapsed: ready,
    })
  return { showSkeletons, prependLanded }
}
