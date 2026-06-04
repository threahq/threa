import { useEffect } from "react"
import { recordInteractionPresence } from "@/lib/sw-presence"
import type { PageInteractionTracker } from "@/hooks/use-page-interaction"

/**
 * Throttle for writing the device-presence timestamp the service worker reads
 * to gate push suppression. A single write captures "last interaction" accurate
 * to within this interval — well under the SW's presence window — so we don't
 * touch Cache Storage on every pointer move.
 */
const PRESENCE_WRITE_THROTTLE_MS = 10_000

/**
 * Records this device's recent interaction (via the shared page interaction
 * tracker) so the service worker can gate push suppression on activity, not
 * focus alone — a focused-but-abandoned tab stops silencing notifications.
 *
 * Independent of socket/connection state: push delivery matters even when the
 * socket is down (flaky mobile). Seeded immediately when the window is focused
 * so the stream you just opened is treated as watched right away.
 */
export function useSwPresence(pageInteraction: PageInteractionTracker): void {
  useEffect(() => {
    if (typeof window === "undefined" || !("caches" in window)) return
    let lastWriteAt = 0
    const write = () => {
      const now = Date.now()
      if (now - lastWriteAt < PRESENCE_WRITE_THROTTLE_MS) return
      lastWriteAt = now
      void recordInteractionPresence(now)
    }
    if (document.hasFocus()) write()
    return pageInteraction.subscribe(write)
  }, [pageInteraction])
}
