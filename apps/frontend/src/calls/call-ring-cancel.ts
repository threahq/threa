// Pure decision helper for the service worker's `call_ring_cancel` push branch,
// extracted so the fallback logic is testable without importing the SW module
// (which touches `self`/`ServiceWorkerGlobalScope` at load).

/** The subset of a `call_ring_cancel` push payload the fallback needs. */
export interface RingCancelData {
  attemptId?: string
  inviterName?: string
  /** Why the ring settled; absent on payloads from older backends. */
  outcome?: "accepted" | "declined" | "cancelled" | "expired" | "superseded"
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
 *   (offline topic-collapse: the cancel replaced the queued ring), OR the user
 *   answered from THIS device's ring notification — the click already closed it,
 *   and this cancel is the settle catching up. A push that results in no visible
 *   notification burns the browser's silent-push quota (Firefox revokes the
 *   subscription at 0, iOS after 3), so show a minimal, silent notification —
 *   reusing the ring tag so a late ring push replaces it, and never vibrating.
 *   The copy follows the settle outcome: the user's own act (accepted/declined)
 *   must not read as the caller hanging up — "call ended" right after answering
 *   is the reported confusion this branches on.
 */
export function planRingCancel(shownCount: number, data: RingCancelData): RingCancelPlan {
  if (shownCount > 0) return { show: false }
  let title: string
  if (data.outcome === "accepted") title = "Call answered"
  else if (data.outcome === "declined") title = "Call declined"
  else title = data.inviterName ? `${data.inviterName}'s call ended` : "Call ended"
  return {
    show: true,
    title,
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
