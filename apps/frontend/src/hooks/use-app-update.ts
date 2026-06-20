import { useEffect, useRef, useCallback } from "react"
import { toast } from "sonner"
import { usePageActivity } from "./use-page-activity"
import { useSocketReconnectCount } from "@/contexts"
import { getNotifiedVersion, setNotifiedVersion } from "@/lib/app-update-version"
import { SW_MSG_SKIP_WAITING } from "@/lib/sw-messages"

const POLL_INTERVAL = 300_000 // 5 minutes
const TOAST_ID = "app-update"
const IS_DEV = import.meta.env.DEV

export const WAITING_WORKER_TIMEOUT_MS = 1500
export const RELOAD_FALLBACK_TIMEOUT_MS = 3000

async function triggerSwUpdate(): Promise<void> {
  const registration = await navigator.serviceWorker?.getRegistration()
  if (!registration) return
  await registration.update()
}

function waitForInstallingWorker(
  registration: ServiceWorkerRegistration,
  timeoutMs: number
): Promise<ServiceWorker | null> {
  const worker = registration.installing
  if (!worker) return Promise.resolve(null)
  if (worker.state === "installed" || worker.state === "activated")
    return Promise.resolve(registration.waiting ?? worker)
  if (worker.state === "redundant") return Promise.resolve(null)

  return new Promise((resolve) => {
    const finish = (value: ServiceWorker | null) => {
      clearTimeout(timer)
      worker.removeEventListener("statechange", onStateChange)
      resolve(value)
    }
    const onStateChange = () => {
      if (worker.state === "installed" || worker.state === "activated") finish(registration.waiting ?? worker)
      if (worker.state === "redundant") finish(null)
    }
    const timer = setTimeout(() => finish(registration.waiting), timeoutMs)
    worker.addEventListener("statechange", onStateChange)
  })
}

async function findWaitingWorker(registration: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  if (registration.waiting) return registration.waiting

  const alreadyInstalling = await waitForInstallingWorker(registration, WAITING_WORKER_TIMEOUT_MS)
  if (registration.waiting || alreadyInstalling) return registration.waiting ?? alreadyInstalling

  try {
    await registration.update()
  } catch {
    return null
  }
  if (registration.waiting) return registration.waiting
  return waitForInstallingWorker(registration, WAITING_WORKER_TIMEOUT_MS)
}

/**
 * Reload onto the new build.
 *
 * New service workers install but stay parked in `waiting`, so an open tab keeps
 * the worker and precache that match its running bundle. On the user's click we
 * activate the parked worker, reload on `controllerchange`, and fall back to a
 * plain reload if the worker never claims.
 */
export async function reloadForUpdate(): Promise<void> {
  const registration = await navigator.serviceWorker?.getRegistration()
  if (!registration) {
    window.location.reload()
    return
  }

  const waiting = await findWaitingWorker(registration)
  if (!waiting) {
    window.location.reload()
    return
  }

  let reloaded = false
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  const reloadOnce = (): void => {
    if (reloaded) return
    reloaded = true
    if (fallbackTimer) clearTimeout(fallbackTimer)
    window.location.reload()
  }

  navigator.serviceWorker.addEventListener("controllerchange", reloadOnce, { once: true })
  fallbackTimer = setTimeout(reloadOnce, RELOAD_FALLBACK_TIMEOUT_MS)
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
