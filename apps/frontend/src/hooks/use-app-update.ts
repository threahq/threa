import { useEffect, useRef, useCallback } from "react"
import { toast } from "sonner"
import { usePageActivity } from "./use-page-activity"
import { useSocketReconnectCount } from "@/contexts"
import { getNotifiedVersion, setNotifiedVersion } from "@/lib/app-update-version"
import { SW_MSG_SKIP_WAITING } from "@/lib/sw-messages"

const POLL_INTERVAL = 300_000 // 5 minutes
const TOAST_ID = "app-update"
const IS_DEV = import.meta.env.DEV

/**
 * Cap how long the Reload action waits for the parked SW to take control before
 * reloading anyway. `controllerchange` is near-instant after skipWaiting; this
 * only guards against a wedged/absent worker so Reload can never hang.
 */
export const RELOAD_FALLBACK_TIMEOUT_MS = 3000

/**
 * Tell the browser to check for a new service worker. A newer sw.js installs and
 * then parks in `waiting` (it no longer skipWaiting()s on its own), so this only
 * stages the update — reloadForUpdate activates it on the user's click.
 */
async function triggerSwUpdate(): Promise<void> {
  const registration = await navigator.serviceWorker?.getRegistration()
  if (!registration) return
  await registration.update()
}

/**
 * Reload onto the new build.
 *
 * The new SW installs but parks in `waiting` so this tab keeps its own build's
 * worker + precache (and can always load its own chunks). On the user's click we
 * post SW_MSG_SKIP_WAITING to the waiting worker; it activates and claims the
 * page, which fires `controllerchange`, and we reload — landing on the new
 * build's precached shell and chunks in one atomic step. The fallback timeout
 * reloads anyway if the worker never claims.
 *
 * No waiting worker (first load, SW unsupported, or already activated) means a
 * plain reload already lands on the current build.
 */
export async function reloadForUpdate(): Promise<void> {
  const registration = await navigator.serviceWorker?.getRegistration()
  if (!registration) {
    window.location.reload()
    return
  }

  let waiting = registration.waiting
  if (!waiting) {
    // The toast can fire before the new sw.js finishes installing; nudge the
    // update and re-check so a quick click still finds the parked worker rather
    // than plain-reloading back onto the current build.
    try {
      await registration.update()
    } catch {
      // Offline or update failed — fall through to a plain reload below.
    }
    waiting = registration.waiting
  }

  if (!waiting) {
    window.location.reload()
    return
  }

  let reloaded = false
  const reloadOnce = (): void => {
    if (reloaded) return
    reloaded = true
    window.location.reload()
  }
  navigator.serviceWorker.addEventListener("controllerchange", reloadOnce, { once: true })
  setTimeout(reloadOnce, RELOAD_FALLBACK_TIMEOUT_MS)
  waiting.postMessage({ type: SW_MSG_SKIP_WAITING })
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

  useEffect(() => {
    if (IS_DEV) return
    const id = setInterval(checkForUpdate, POLL_INTERVAL)
    return () => clearInterval(id)
  }, [checkForUpdate])

  useEffect(() => {
    if (isVisible && !IS_DEV) {
      checkForUpdate()
    }
  }, [isVisible, checkForUpdate])

  useEffect(() => {
    if (reconnectCount > 0 && !IS_DEV) {
      checkForUpdate()
    }
  }, [reconnectCount, checkForUpdate])
}
