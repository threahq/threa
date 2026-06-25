import { useEffect, useCallback } from "react"
import { toast } from "sonner"
import { usePageActivity } from "./use-page-activity"
import { useSocketReconnectCount } from "@/contexts"
import * as swRecovery from "@/lib/sw-recovery"
import { SW_MSG_SKIP_WAITING } from "@/lib/sw-messages"

const POLL_INTERVAL = 300_000 // 5 minutes
const TOAST_ID = "app-update"
const IS_DEV = import.meta.env.DEV

export const WAITING_WORKER_TIMEOUT_MS = 1500
export const RELOAD_FALLBACK_TIMEOUT_MS = 3000

// The waiting worker we've already announced. Module-level (not a ref, not
// persisted): it survives the AppUpdateChecker remounts that fire on every
// workspace switch — so one ready build is announced once, not on every
// remount — yet resets on a real page load, so a build that was downloaded but
// never applied re-surfaces next launch instead of being silenced forever (the
// persisted-version dedup used to silence it permanently). Keyed on worker
// identity, not a version string: each background install produces a fresh
// `waiting` object, so a genuinely newer build re-announces while the same
// object across remounts does not.
let announcedWaiting: ServiceWorker | null = null

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
 * The background-fetch lifecycle (see `useAppUpdate`) means the toast only
 * appears once a new worker is fully downloaded and parked in `waiting`, so the
 * common path is instant and offline: message the parked worker to `skipWaiting`,
 * reload on `controllerchange`.
 *
 * Both fallbacks escalate to `runSwRecovery` rather than a plain reload, because
 * the SW serves `index.html` cache-first from precache with no network
 * revalidation — a bare `window.location.reload()` while the old worker still
 * controls the page just re-serves the same stale shell. Recovery unregisters
 * the worker and wipes CacheStorage (what `/recover` does), so the reload after
 * it lands the new build. Reached only when no worker is parked (still
 * installing, or a byte-identical bundle) or `controllerchange` never fires.
 */
export async function reloadForUpdate(): Promise<void> {
  const registration = await navigator.serviceWorker?.getRegistration()
  if (!registration) {
    await swRecovery.runSwRecovery({ force: true })
    return
  }

  const waiting = await findWaitingWorker(registration)
  if (!waiting) {
    await swRecovery.runSwRecovery({ force: true })
    return
  }

  let settled = false
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  const reloadOnce = (): void => {
    if (settled) return
    settled = true
    if (fallbackTimer) clearTimeout(fallbackTimer)
    window.location.reload()
  }
  const escalate = (): void => {
    if (settled) return
    settled = true
    void swRecovery.runSwRecovery({ force: true })
  }

  navigator.serviceWorker.addEventListener("controllerchange", reloadOnce, { once: true })
  fallbackTimer = setTimeout(escalate, RELOAD_FALLBACK_TIMEOUT_MS)
  waiting.postMessage({ type: SW_MSG_SKIP_WAITING })
}

/**
 * Surface the update toast for a build that has finished downloading and is
 * parked in `registration.waiting`. No-op when nothing is parked (no update, or
 * a first-ever install which activates without waiting) or when this exact
 * worker was already announced — so Reload is always a one-click, already-local
 * activation, never a race against an in-flight precache.
 */
function announceIfWaiting(registration: ServiceWorkerRegistration): void {
  const waiting = registration.waiting
  if (!waiting || waiting === announcedWaiting) return
  announcedWaiting = waiting
  toast("A new version of Threa is available", {
    id: TOAST_ID,
    duration: Infinity,
    action: {
      label: "Reload",
      onClick: () => void reloadForUpdate(),
    },
  })
}

export function useAppUpdate(): void {
  const { isVisible } = usePageActivity()
  const reconnectCount = useSocketReconnectCount()

  const checkForUpdate = useCallback(async () => {
    if (IS_DEV) return
    const registration = await navigator.serviceWorker?.getRegistration()
    if (!registration) return
    // Drive the background fetch: this downloads + installs + precaches the new
    // build while the current worker keeps serving. The `updatefound` listener
    // below announces once it lands in `waiting`; announce here too for a build
    // that parked before this check (e.g. installed during a prior poll).
    try {
      await registration.update()
    } catch {
      // Network error — retry on the next trigger.
    }
    announceIfWaiting(registration)
  }, [])

  // Announce a build that finishes installing between checks: the browser may
  // park a new worker at any time (another tab's update(), a slow precache
  // completing), so listen for the install rather than only polling.
  useEffect(() => {
    if (IS_DEV) return
    let disposed = false
    let cleanup: (() => void) | null = null
    void navigator.serviceWorker?.getRegistration().then((registration) => {
      if (!registration || disposed) return
      announceIfWaiting(registration)
      const onUpdateFound = () => {
        const installing = registration.installing
        if (!installing) return
        const onStateChange = () => {
          if (installing.state === "installed") {
            installing.removeEventListener("statechange", onStateChange)
            announceIfWaiting(registration)
          }
        }
        installing.addEventListener("statechange", onStateChange)
      }
      registration.addEventListener("updatefound", onUpdateFound)
      cleanup = () => registration.removeEventListener("updatefound", onUpdateFound)
    })
    return () => {
      disposed = true
      cleanup?.()
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
