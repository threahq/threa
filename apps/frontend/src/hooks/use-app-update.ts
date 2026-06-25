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
 * Offline-first is the binding constraint: a plain reload can never be worse
 * than staying put, because the SW serves the shell from precache with zero
 * network. So every fallback here is a plain reload — never the cache-wiping
 * recovery — unless there is genuinely nothing local to serve (no controller at
 * all), where a fresh network fetch is the only way forward anyway. Wiping
 * CacheStorage to chase freshness would strand a user on a flaky connection
 * (and iOS standalone routinely drops `controllerchange` after `skipWaiting`,
 * which previously tripped that wipe on a worker that had actually activated).
 */
export async function reloadForUpdate(): Promise<void> {
  // A reload lands the new build whenever something can already control the
  // page (the parked worker activated, or another tab already swapped it in).
  // Only when nothing controls us is recovery — unregister + cache wipe + fresh
  // fetch — the right tool, since there is no cached shell to go stale anyway.
  const reloadOrRecover = (): void => {
    if (navigator.serviceWorker?.controller) window.location.reload()
    else void swRecovery.runSwRecovery({ force: true })
  }

  const registration = await navigator.serviceWorker?.getRegistration()
  if (!registration) {
    reloadOrRecover()
    return
  }

  const waiting = await findWaitingWorker(registration)
  if (!waiting) {
    // The build we toasted for is gone: another tab activated it (the controller
    // is the new worker, so a reload lands it) or it raced away. Reload, never wipe.
    reloadOrRecover()
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

  navigator.serviceWorker.addEventListener("controllerchange", reloadOnce, { once: true })
  // If controllerchange never fires (iOS standalone drops it after skipWaiting),
  // reload anyway: the worker has usually activated, so the reload lands the new
  // build from cache; if it hasn't, we reload onto the cached old shell
  // offline-safely and the next check re-parks + re-announces it.
  fallbackTimer = setTimeout(reloadOnce, RELOAD_FALLBACK_TIMEOUT_MS)
  waiting.postMessage({ type: SW_MSG_SKIP_WAITING })
}

/**
 * Whether to announce the given waiting worker. True only for a build that is
 * both fully parked (`waiting` set) and not the exact worker we already
 * announced — so a first-ever install (no waiting worker, activates straight
 * away) and the remount/refocus re-checks against an already-announced build
 * stay silent, while a genuinely newer build (a fresh `waiting` object) still
 * announces. Identity, not a version string: that is what makes the toast fire
 * only when Reload would be a one-click local activation, never a race against
 * an in-flight precache, and never the premature version.json-delta toast this
 * replaced.
 */
export function shouldAnnounceWaiting(
  waiting: ServiceWorker | null | undefined,
  announced: ServiceWorker | null
): boolean {
  return Boolean(waiting) && waiting !== announced
}

/**
 * Surface the update toast for a build that has finished downloading and is
 * parked in `registration.waiting`. Gated by `shouldAnnounceWaiting`, so Reload
 * is always a one-click, already-local activation.
 */
function announceIfWaiting(registration: ServiceWorkerRegistration): void {
  const waiting = registration.waiting
  if (!shouldAnnounceWaiting(waiting, announcedWaiting)) return
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
      // Track per-install statechange listeners so unmount (workspace switch
      // remounts AppUpdateChecker) tears them down too — otherwise a worker
      // mid-install at unmount would fire after teardown, and a worker that
      // ends `redundant` (superseded by a newer build) would never self-remove.
      const installCleanups: Array<() => void> = []
      const onUpdateFound = () => {
        const installing = registration.installing
        if (!installing) return
        const onStateChange = () => {
          if (installing.state === "installed" || installing.state === "redundant") {
            installing.removeEventListener("statechange", onStateChange)
          }
          if (installing.state === "installed" && !disposed) announceIfWaiting(registration)
        }
        installing.addEventListener("statechange", onStateChange)
        installCleanups.push(() => installing.removeEventListener("statechange", onStateChange))
      }
      registration.addEventListener("updatefound", onUpdateFound)
      cleanup = () => {
        registration.removeEventListener("updatefound", onUpdateFound)
        for (const remove of installCleanups) remove()
      }
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
