import { useEffect, useRef, useCallback } from "react"
import { toast } from "sonner"
import { usePageActivity } from "./use-page-activity"
import { useSocketReconnectCount } from "@/contexts"
import { getNotifiedVersion, setNotifiedVersion } from "@/lib/app-update-version"

const POLL_INTERVAL = 300_000 // 5 minutes
const TOAST_ID = "app-update"
const IS_DEV = import.meta.env.DEV

/** Cap how long the Reload action waits for the new SW before reloading anyway. */
export const UPDATE_RELOAD_FALLBACK_MS = 10_000

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
 * Reload onto the new build.
 *
 * The SW serves navigations cache-first from the build-atomic precache, so a
 * plain reload returns whatever build the *currently controlling* SW precached.
 * If the new SW hasn't installed and claimed this page yet, that is still the
 * old build and the version toast just reappears — which is why an
 * unconditional reload needed "a bunch of refreshes".
 *
 * So the guaranteed behaviour is a single time-bounded reload, armed up front
 * and never gated on the SW update settling. On top of that, as a best-effort
 * optimization, force the SW update and reload the moment the new worker takes
 * control (it self-activates via skipWaiting + clients.claim, firing
 * `controllerchange`) so the reload lands on the new build instead of waiting
 * the fallback out. Reloads exactly once; never worse than a bare reload.
 */
export async function reloadForUpdate(): Promise<void> {
  let reloaded = false
  const reloadOnce = (): void => {
    if (reloaded) return
    reloaded = true
    window.location.reload()
  }

  // Any unexpected failure must still reload — this is the user's escape hatch
  // onto the new build, so it can never silently do nothing.
  try {
    const registration = await navigator.serviceWorker?.getRegistration()
    if (!registration) {
      reloadOnce()
      return
    }

    // Subscribe before update() so a fast activate→claim can't fire the event
    // before we are listening.
    navigator.serviceWorker.addEventListener("controllerchange", reloadOnce, { once: true })

    // Arm the time-bounded reload BEFORE awaiting update(). registration.update()
    // can hang indefinitely (stalled SW-script fetch, throttled or offline tab),
    // and every other guarantee here used to sit behind that await — so a hung
    // update() dismissed the toast and then stranded the user on the old build
    // with Reload doing nothing. The reload now always happens within
    // UPDATE_RELOAD_FALLBACK_MS regardless of how update() behaves.
    setTimeout(reloadOnce, UPDATE_RELOAD_FALLBACK_MS)

    // Best effort on top of that fallback: reload the moment the new SW takes
    // control so the reload lands on its precached build instead of waiting the
    // fallback out. Not awaited, so a hung update() can't block the timeout.
    void registration
      .update()
      .then(() => {
        const pending = registration.installing ?? registration.waiting
        if (!pending) {
          // The new SW already installed and took control in the background — a
          // plain reload now serves its precached shell.
          reloadOnce()
          return
        }
        // Backstop for controllerchange in case it does not fire for this
        // client: reload as soon as the new SW reaches `activated`.
        pending.addEventListener("statechange", () => {
          if (pending.state === "activated") reloadOnce()
        })
      })
      .catch(reloadOnce)
  } catch {
    reloadOnce()
  }
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
