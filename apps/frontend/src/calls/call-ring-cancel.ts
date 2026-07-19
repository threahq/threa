// Pure decision helper for the service worker's `call_ring_cancel` push branch,
// extracted so the fallback logic is testable without importing the SW module
// (which touches `self`/`ServiceWorkerGlobalScope` at load).

/** The subset of a `call_ring_cancel` push payload the fallback needs. */
export interface RingCancelData {
  attemptId?: string
  inviterName?: string
}

/** A shown fallback notification, or nothing when a tagged ring was closed. */
export type RingCancelPlan =
  | { show: false }
  | { show: true; title: string; options: NotificationOptions & { renotify?: boolean } }

/**
 * Decide what a `call_ring_cancel` push does given how many tagged ring
 * notifications are currently shown for this attempt.
 *
 * - One or more are shown ⇒ the caller closes them; there is nothing new to show.
 * - None are shown ⇒ the cancel collapsed a ring this device never displayed
 *   (offline topic-collapse: the cancel replaced the queued ring). A push that
 *   results in no visible notification burns the browser's silent-push quota
 *   (Firefox revokes the subscription at 0, iOS after 3), so show a minimal,
 *   silent "Call ended" instead — reusing the ring tag so a late ring push
 *   replaces it, and never vibrating (the ring is over; keep it quiet).
 */
export function planRingCancel(shownCount: number, data: RingCancelData): RingCancelPlan {
  if (shownCount > 0) return { show: false }
  return {
    show: true,
    title: data.inviterName ? `${data.inviterName}'s call ended` : "Call ended",
    options: {
      icon: "/threa-logo-192.png",
      badge: "/threa-logo-192.png",
      tag: data.attemptId ? `call-${data.attemptId}` : "call",
      silent: true,
      renotify: false,
      data: { ...data, kind: "call_ring_cancel" as const },
    },
  }
}
