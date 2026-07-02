import { useEffect } from "react"
import { useParams } from "react-router-dom"
import { useAccountScopeOptional } from "@/auth/account-scope"
import { SW_MSG_QUEUE_BOOTSTRAP_SYNC } from "@/lib/sw-messages"

/**
 * Tell the service worker to queue a Background Sync each time the tab loses
 * focus, so the SW can prefetch the workspace + active stream bootstrap while
 * the tab is closed. The `sync` event in the SW retries on network failure,
 * which the inline fetch path can't do.
 *
 * The message carries the active account's WorkOS user id because the SW has
 * no AccountScope: it needs the id to open the per-account IndexedDB
 * (accountDbName) that the app actually reads. Without it the SW skips the
 * IDB half of the prefetch.
 *
 * Browsers without a controller (first ever load before activation) or without
 * Background Sync support no-op; the resume hook still catches up on next
 * visibility. We deliberately do not debounce — browsers coalesce sync
 * registrations under the same tag, so rapid hide/show only produces a single
 * effective sync.
 */
export function useBackgroundBootstrapSync(): void {
  const { workspaceId, streamId } = useParams<{ workspaceId: string; streamId?: string }>()
  const workosUserId = useAccountScopeOptional()?.activeWorkosUserId ?? null

  useEffect(() => {
    if (!workspaceId) return

    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return
      const sw = navigator.serviceWorker?.controller
      if (!sw) return
      sw.postMessage({
        type: SW_MSG_QUEUE_BOOTSTRAP_SYNC,
        workspaceId,
        streamId: streamId ?? null,
        workosUserId,
      })
    }

    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => document.removeEventListener("visibilitychange", onVisibilityChange)
  }, [workspaceId, streamId, workosUserId])
}
