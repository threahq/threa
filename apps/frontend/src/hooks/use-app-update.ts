import { useEffect, useRef, useCallback } from "react"
import { toast } from "sonner"
import { usePageActivity } from "./use-page-activity"
import { useSocketReconnectCount } from "@/contexts"
import { getNotifiedVersion, setNotifiedVersion } from "@/lib/app-update-version"
import { SW_MSG_RELOAD_FRESH } from "@/lib/sw-messages"

const POLL_INTERVAL = 300_000 // 5 minutes
const TOAST_ID = "app-update"
const IS_DEV = import.meta.env.DEV

/**
 * Cap how long the Reload action waits for the SW to acknowledge the
 * network-fresh request before reloading anyway. The ack is near-instant; this
 * only guards against a wedged SW so Reload can never hang.
 */
export const RELOAD_FRESH_ACK_TIMEOUT_MS = 1500

/**
 * Tell the browser to check for a new service worker. The SW's install handler
 * calls skipWaiting() unconditionally, so it activates immediately — no need
 * to post a message or check registration.waiting.
 */
async function triggerSwUpdate(): Promise<void> {
  const registration = await navigator.serviceWorker?.getRegistration()
  if (!registration) return
  await registration.update()
}

/**
 * Ask the controlling SW to serve the next navigation from the network, then
 * resolve once it acks (or the timeout elapses). The ack guarantees the SW has
 * set its one-shot flag before we trigger the navigation, so the reload that
 * follows is the one served fresh.
 */
function requestFreshNav(controller: ServiceWorker): Promise<void> {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(resolve, RELOAD_FRESH_ACK_TIMEOUT_MS)
    channel.port1.onmessage = () => {
      clearTimeout(timer)
      resolve()
    }
    try {
      controller.postMessage({ type: SW_MSG_RELOAD_FRESH }, [channel.port2])
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

/**
 * Reload onto the new build.
 *
 * The SW serves navigations cache-first from the build-atomic precache, so a
 * plain reload returns whatever build the *currently controlling* SW precached
 * — and right after a deploy that is still the old build, so the version toast
 * just reappears. Waiting for the new SW to install and claim before reloading
 * is racy (a slow/throttled install reloads onto the old shell anyway), so
 * instead we ask the controlling SW to serve this one navigation from the
 * network. The reload then fetches the freshly-deployed index.html (and its new
 * hashed assets) directly, landing on the new build in one click regardless of
 * SW-update timing. The new SW installs in the background as usual.
 *
 * No controller (first load before the SW claims) means the navigation already
 * hits the network, so a plain reload is correct.
 */
export async function reloadForUpdate(): Promise<void> {
  const controller = navigator.serviceWorker?.controller
  if (controller) {
    await requestFreshNav(controller)
  }
  window.location.reload()
}

/**
 * Whether to surface the update toast. True only for a build that is both newer
 * than what's running and not one we've already notified the user about — so a
 * remount or a refocus/reconnect/poll on an already-announced deploy stays
 * silent, while a genuinely newer build (whose version matches neither the
 * running bundle nor the persisted marker) still notifies.
 */
export function shouldNotifyUpdate(
  serverVersion: string,
  runningVersion: string,
  notifiedVersion: string | null
): boolean {
  return Boolean(serverVersion) && serverVersion !== runningVersion && serverVersion !== notifiedVersion
}

export function useAppUpdate(): void {
  const { isVisible } = usePageActivity()
  const reconnectCount = useSocketReconnectCount()
  // In-memory fallback so dedup still holds for this mount when localStorage is
  // unavailable (private mode / disabled) — the persisted marker is the
  // cross-mount/session guard; this keeps the no-storage path no worse than
  // the previous per-mount ref.
  const toastedVersionRef = useRef<string | null>(null)

  const checkForUpdate = useCallback(async () => {
    if (IS_DEV) return

    try {
      // Trigger SW update check in parallel with version check
      triggerSwUpdate().catch(() => {})

      const res = await fetch("/version.json", { cache: "no-cache" })
      if (!res.ok) return

      const { version } = (await res.json()) as { version: string }
      if (toastedVersionRef.current !== version && shouldNotifyUpdate(version, __APP_VERSION__, getNotifiedVersion())) {
        toastedVersionRef.current = version
        setNotifiedVersion(version)
        toast("A new version of Threa is available", {
          id: TOAST_ID,
          duration: Infinity,
          action: {
            label: "Reload",
            onClick: () => void reloadForUpdate(),
          },
        })
      }
    } catch {
      // Network error — silently skip this check
    }
  }, [])

  // Periodic polling
  useEffect(() => {
    if (IS_DEV) return
    const id = setInterval(checkForUpdate, POLL_INTERVAL)
    return () => clearInterval(id)
  }, [checkForUpdate])

  // Check when tab becomes visible
  useEffect(() => {
    if (isVisible && !IS_DEV) {
      checkForUpdate()
    }
  }, [isVisible, checkForUpdate])

  // Check on socket reconnect
  useEffect(() => {
    if (reconnectCount > 0 && !IS_DEV) {
      checkForUpdate()
    }
  }, [reconnectCount, checkForUpdate])
}
