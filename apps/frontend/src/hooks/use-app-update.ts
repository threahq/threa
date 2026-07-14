import { useEffect, useCallback, useRef, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"
import { usePageActivity } from "./use-page-activity"
import { useSocketReconnectCount } from "@/contexts"
import * as swRecovery from "@/lib/sw-recovery"
import { SW_MSG_SKIP_WAITING } from "@/lib/sw-messages"
import { currentAppVersion } from "@/lib/app-build"

export { currentAppBuiltAt, currentAppInstalledAt, currentAppVersion } from "@/lib/app-build"

export const APP_UPDATE_POLL_INTERVAL_MS = 300_000
const TOAST_ID = "app-update"
const IS_DEV = import.meta.env.DEV

export const WAITING_WORKER_TIMEOUT_MS = 1500
export const RELOAD_FALLBACK_TIMEOUT_MS = 3000
export const CLICK_UPDATE_TIMEOUT_MS = 5000

// True only in the Playwright E2E build (vite `define`, gated on VITE_BACKEND_PORT).
// The update toast uses `duration: Infinity` and renders in the aria-live
// Notifications region, so under Playwright it parks over the composer and
// intercepts pointer events for the rest of the test — every spec that clicks a
// button underneath it flakes. Suppress only the toast in that build; the SW and
// its update pipeline still run (push tests need the registration). typeof-guarded
// because the `define` isn't applied under vitest (see currentAppVersion). Never
// gated in production — the toast is the only signal a new build is parked.
declare const __E2E_BUILD__: boolean

export function isE2eBuild(): boolean {
  return typeof __E2E_BUILD__ === "boolean" && __E2E_BUILD__
}

// Marks that the user clicked Reload, so the first check after the page comes
// back can verify the swap actually happened (running build == server's latest)
// rather than silently re-announcing the same build forever. The window bounds a
// flag the reload somehow never consumed so it can't trip a spurious recovery
// much later in the tab session.
const RELOAD_ATTEMPT_KEY = "app-update-reload-attempt"
const RELOAD_ATTEMPT_WINDOW_MS = 60_000

function markReloadAttempt(): void {
  try {
    sessionStorage.setItem(RELOAD_ATTEMPT_KEY, String(Date.now()))
  } catch {
    // Private mode / storage disabled — reconciliation just won't escalate.
  }
}

function reloadRecentlyAttempted(): boolean {
  try {
    const raw = sessionStorage.getItem(RELOAD_ATTEMPT_KEY)
    if (!raw) return false
    const ts = Number.parseInt(raw, 10)
    return Number.isFinite(ts) && Date.now() - ts < RELOAD_ATTEMPT_WINDOW_MS
  } catch {
    return false
  }
}

function clearReloadAttempt(): void {
  try {
    sessionStorage.removeItem(RELOAD_ATTEMPT_KEY)
  } catch {
    // No-op — see markReloadAttempt.
  }
}

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

function settleWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs)
    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      }
    )
  })
}

function requestRegistrationUpdate(registration: ServiceWorkerRegistration): Promise<boolean> {
  try {
    return settleWithin(
      registration.update().then(() => true),
      CLICK_UPDATE_TIMEOUT_MS,
      false
    )
  } catch {
    return Promise.resolve(false)
  }
}

async function findWaitingWorker(registration: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  if (registration.waiting) return registration.waiting

  const alreadyInstalling = await waitForInstallingWorker(registration, WAITING_WORKER_TIMEOUT_MS)
  if (registration.waiting || alreadyInstalling) return registration.waiting ?? alreadyInstalling

  // update() has no timeout of its own; bound user-triggered checks so a stalled
  // mobile network cannot leave the action looking dead indefinitely.
  await requestRegistrationUpdate(registration)
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
  // Record the click so the next page load can verify the swap landed new code
  // and escalate to recovery if it didn't, rather than re-announcing the same
  // build forever. See reconcilePostReload.
  markReloadAttempt()

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

function showUpdateToast(): void {
  if (isE2eBuild()) return
  toast("A new version of Threa is available", {
    id: TOAST_ID,
    duration: Infinity,
    action: {
      label: "Reload",
      onClick: () => void reloadForUpdate(),
    },
  })
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
  showUpdateToast()
}

/**
 * Whether a controllerchange event means another client activated a new build
 * under this page, which should be announced. Not announced:
 * - `hadController` false: the first-ever install claiming the page — the page
 *   already runs the build that worker serves.
 * - `hasController` false: the SW was unregistered (recovery) — a reload follows.
 * - `reloadPending`: this tab's own Reload click; reloadForUpdate is about to
 *   reload onto the new build already.
 */
export function shouldAnnounceControllerSwap(opts: {
  hadController: boolean
  hasController: boolean
  reloadPending: boolean
}): boolean {
  return opts.hadController && opts.hasController && !opts.reloadPending
}

// The server build version we've already shown the stale-page toast for, so a
// persistent skew doesn't re-toast a dismissed announce on every poll. Module
// state for the same lifetime reasons as announcedWaiting.
let announcedStaleVersion: string | null = null

/**
 * Whether to announce that this page itself is the stale artifact: both
 * versions known and different, and not already announced for this target.
 */
export function shouldAnnounceStalePage(
  current: string | null,
  latest: string | null,
  announced: string | null
): boolean {
  return Boolean(current && latest && current !== latest && latest !== announced)
}

/**
 * Announce when the running page is the stale artifact — the complement of the
 * parked-worker announce. After another client activates a new build (its
 * Reload ran skipWaiting), clients.claim() re-points this page at the new
 * worker but the JS heap keeps running the old build, and no worker will ever
 * park in `waiting` again — update() finds the server's sw.js already active.
 * Without this, such a page stays silently stale until a lazy chunk 404s into
 * the cache-wipe recovery. The controllerchange listener announces this
 * instantly when the event is delivered; this check is the safety net for the
 * platforms that drop it (iOS standalone) and for pages frozen through the swap.
 *
 * Only runs when nothing is installing or waiting: a genuinely newer server
 * build announces through the parked-worker path once downloaded. That gate is
 * what separates this from the premature version.json-delta toast this codebase
 * removed — here the new build's precache is already the active one, so Reload
 * is still an instant local activation (plain reload, nothing parked).
 */
async function announceIfPageStale(registration: ServiceWorkerRegistration): Promise<void> {
  if (registration.waiting || registration.installing) return
  // Only while a controller is serving this page: the announce's premise is
  // that Reload is an instant local activation onto the already-active
  // precache. An uncontrolled page has no precache to land on — its version
  // mismatch is a stale server response, not an SW update, and a toast here
  // would route a later (possibly offline) click into reloadOrRecover's
  // no-controller branch: a cache wipe not proven online at wipe time.
  if (!navigator.serviceWorker?.controller) return
  const latest = await fetchLatestVersion()
  if (!shouldAnnounceStalePage(currentAppVersion(), latest, announcedStaleVersion)) return
  // A worker that started installing during the fetch owns the announce.
  if (registration.waiting || registration.installing) return
  announcedStaleVersion = latest
  showUpdateToast()
}

export function useIsServiceWorkerControlled(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const serviceWorker = navigator.serviceWorker
      if (!serviceWorker) return () => {}
      serviceWorker.addEventListener("controllerchange", notify)
      return () => serviceWorker.removeEventListener("controllerchange", notify)
    },
    () => Boolean(navigator.serviceWorker?.controller),
    () => false
  )
}

/**
 * The latest deployed build version from the server, or null if it can't be read.
 * `no-store` bypasses the HTTP cache; `/version.json` is excluded from the SW's
 * navigation handler and matches no other SW route, so this reaches the network.
 */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch("/version.json", { cache: "no-store" })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    return typeof body.version === "string" ? body.version : null
  } catch {
    return null
  }
}

/**
 * Recover only on a CONFIRMED stale build: both versions known and different. A
 * successful version fetch proves we're online, so the cache wipe + refetch can
 * actually land the new build. Any unknown (offline, fetch failed, define
 * missing) returns false — never wipe when we can't verify, or we'd brick an
 * offline launch (the offline-first constraint the whole SW model exists for).
 */
export function shouldRecoverForVersion(current: string | null, latest: string | null): boolean {
  return Boolean(current && latest && current !== latest)
}

/**
 * Decide what a fresh page load owes a prior Reload click. Runs once before any
 * announce, and is the single thing that breaks the "Reload keeps re-showing the
 * toast" loop.
 *
 * The whole point of Reload is the *swap*: activate the downloaded worker and
 * boot onto its new code. That swap can silently fail to take — skipWaiting may
 * not evict a worker that open clients keep parked, controllerchange can be
 * dropped (iOS) or the platform re-serves the old precached shell — and because
 * `announcedWaiting` resets on a real page load, the still-current build just
 * re-announces. The user can then click Reload forever without ever moving builds.
 *
 * So after a Reload click, ask the decisive question directly: is the code
 * running now the latest deployed code? If a successful version fetch says no,
 * the swap didn't happen — escalate to recovery (unregister + cache wipe + fresh
 * fetch), which forces a clean boot onto the new build. If the versions match, or
 * we can't verify (offline), wipe nothing.
 *
 * Returns true when recovery was kicked off (a reload will follow, so the caller
 * should not announce). Recovery is forced, not capped: it only ever fires as the
 * direct result of a user Reload click (the flag is set solely by reloadForUpdate
 * and is single-shot), so it can't auto-loop and the attempt cap buys nothing
 * here. Leaving it capped would let unrelated chunk-load recoveries exhaust the
 * shared counter and silently turn the user's Reload into a no-op — the exact bug
 * this fixes — so this follows runSwRecovery's "user-initiated clicks force"
 * convention.
 */
export async function reconcilePostReload(): Promise<boolean> {
  if (!reloadRecentlyAttempted()) return false
  // Clear synchronously, before the await: the mount effect and checkForUpdate
  // can both reach here, and the loser must see the flag already consumed.
  clearReloadAttempt()
  const current = currentAppVersion()
  const latest = await fetchLatestVersion()
  if (!shouldRecoverForVersion(current, latest)) return false
  return swRecovery.runSwRecovery({ force: true })
}

export type ManualUpdateCheckResult =
  | { status: "current"; latestVersion: string }
  | { status: "ready" | "available"; latestVersion: string | null }
  | { status: "offline"; latestVersion: null }
  | { status: "unavailable"; latestVersion: null }

/** Run the same service-worker update probe as the background checker and report its result. */
export async function checkForAppUpdate(): Promise<ManualUpdateCheckResult> {
  let registration: ServiceWorkerRegistration | undefined
  try {
    registration = await navigator.serviceWorker?.getRegistration()
  } catch {
    registration = undefined
  }
  if (!registration) {
    return navigator.onLine
      ? { status: "unavailable", latestVersion: null }
      : { status: "offline", latestVersion: null }
  }

  const latestPromise = fetchLatestVersion()
  await requestRegistrationUpdate(registration)

  const waiting = registration.waiting ?? (await waitForInstallingWorker(registration, WAITING_WORKER_TIMEOUT_MS))
  const latest = await settleWithin(latestPromise, CLICK_UPDATE_TIMEOUT_MS, null)
  if (waiting) return { status: "ready", latestVersion: latest }
  if (shouldRecoverForVersion(currentAppVersion(), latest)) {
    return { status: "available", latestVersion: latest }
  }
  if (latest && latest === currentAppVersion()) {
    return { status: "current", latestVersion: latest }
  }
  if (!navigator.onLine) return { status: "offline", latestVersion: null }
  return { status: "unavailable", latestVersion: null }
}

export type ManualUpdateState = "idle" | "checking" | ManualUpdateCheckResult["status"]

export function useManualAppUpdate(): {
  state: ManualUpdateState
  latestVersion: string | null
  lastCheckedAt: Date | null
  check: () => Promise<void>
  reload: () => Promise<void>
} {
  const [state, setState] = useState<ManualUpdateState>("idle")
  const [latestVersion, setLatestVersion] = useState<string | null>(null)
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null)

  const check = useCallback(async () => {
    setState("checking")
    try {
      const result = await checkForAppUpdate()
      setLatestVersion(result.latestVersion)
      setState(result.status)
    } catch {
      setLatestVersion(null)
      setState(navigator.onLine ? "unavailable" : "offline")
    } finally {
      setLastCheckedAt(new Date())
    }
  }, [])

  return {
    state,
    latestVersion,
    lastCheckedAt,
    check,
    reload: reloadForUpdate,
  }
}

export function useAppUpdate(): void {
  const { isVisible } = usePageActivity()
  const reconnectCount = useSocketReconnectCount()

  // Share one in-flight reconciliation across the mount effect and checkForUpdate
  // (both fire on a visible load). reconcilePostReload clears its single-shot flag
  // before awaiting the version fetch, so without a shared promise the second
  // caller sees no flag, skips recovery, and re-announces the waiting worker while
  // the first is still recovering. A ref (not module state) keeps it per hook
  // instance, per INV-9; the sessionStorage flag is the across-remount guard.
  const reconcileRef = useRef<Promise<boolean> | null>(null)
  const reconcileOnce = useCallback(() => (reconcileRef.current ??= reconcilePostReload()), [])

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
    // Reconcile before announcing so a Reload that didn't swap in new code
    // escalates to recovery instead of re-announcing the same build.
    if (await reconcileOnce()) return
    announceIfWaiting(registration)
    await announceIfPageStale(registration)
  }, [reconcileOnce])

  // Announce a build that finishes installing between checks: the browser may
  // park a new worker at any time (another tab's update(), a slow precache
  // completing), so listen for the install rather than only polling.
  useEffect(() => {
    if (IS_DEV) return
    const sw = navigator.serviceWorker
    if (!sw) return
    let disposed = false
    let cleanup: (() => void) | null = null
    // A controller swap this tab didn't request means another client (a second
    // tab, or the installed PWA next to a browser tab) activated a new build
    // under us. This page keeps running its old JS, and since the new build is
    // already active no worker will ever park in `waiting` for it again — so
    // announce here, the only signal this page gets. Reload then takes the
    // plain-reload path (controller exists, nothing parked) and lands the
    // already-active build, offline included.
    let hadController = Boolean(sw.controller)
    const onControllerChange = () => {
      const announce = shouldAnnounceControllerSwap({
        hadController,
        hasController: Boolean(sw.controller),
        reloadPending: reloadRecentlyAttempted(),
      })
      hadController = Boolean(sw.controller)
      if (announce) showUpdateToast()
    }
    sw.addEventListener("controllerchange", onControllerChange)
    void sw.getRegistration().then(async (registration) => {
      if (!registration || disposed) return
      // A prior Reload click that didn't swap in new code escalates to recovery
      // here; a reload follows, so don't announce on top of it.
      if (await reconcileOnce()) return
      if (disposed) return
      announceIfWaiting(registration)
      // Track per-install statechange listeners so unmount (workspace switch
      // remounts AppUpdateChecker) tears them down too — otherwise a worker
      // mid-install at unmount would fire after teardown, and a worker that
      // ends `redundant` (superseded by a newer build) would never self-remove.
      const installCleanups: Array<() => void> = []
      const trackInstalling = (installing: ServiceWorker | null): void => {
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
      // A worker already mid-install at mount (the app opened while the SW was
      // still downloading the new build) fired `updatefound` before this effect
      // attached — track it directly so it still announces the moment it parks,
      // not on the next poll/focus.
      trackInstalling(registration.installing)
      const onUpdateFound = () => trackInstalling(registration.installing)
      registration.addEventListener("updatefound", onUpdateFound)
      cleanup = () => {
        registration.removeEventListener("updatefound", onUpdateFound)
        for (const remove of installCleanups) remove()
      }
    })
    return () => {
      disposed = true
      sw.removeEventListener("controllerchange", onControllerChange)
      cleanup?.()
    }
  }, [reconcileOnce])

  useEffect(() => {
    if (IS_DEV) return
    const id = setInterval(checkForUpdate, APP_UPDATE_POLL_INTERVAL_MS)
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
