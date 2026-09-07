/**
 * Recovery for stale-deploy states where cached JS/SW refers to asset
 * filenames that no longer exist on the server. Shared by index.html's CSS
 * watchdog and the router error boundary.
 *
 * The sessionStorage counter is shared so both paths together can only reload
 * at most MAX_ATTEMPTS times. The LAST_ATTEMPT_KEY stamp lets the CSS
 * watchdog clear the counter on a healthy load only after a cooldown, so a
 * broken JS chunk (CSS still loads fine!) can't loop past the cap. Keep the
 * 60s cooldown in sync with index.html.
 */

const ATTEMPTS_KEY = "sw-recovery-attempts"
const LAST_ATTEMPT_KEY = "sw-recovery-last"
const MAX_ATTEMPTS = 2

/**
 * Detect dynamic-import failure messages across browsers.
 *   Chromium/Firefox: "Failed to fetch dynamically imported module"
 *   Safari:           "error loading dynamically imported module"
 *   Older Edge:       "Importing a module script failed"
 */
export function isChunkLoadError(error: unknown): boolean {
  let message = ""
  if (error instanceof Error) message = error.message
  else if (typeof error === "string") message = error
  if (!message) return false
  return (
    message.includes("Failed to fetch dynamically imported module") ||
    message.includes("error loading dynamically imported module") ||
    message.includes("Importing a module script failed")
  )
}

/**
 * Pull the asset URL out of a dynamic-import failure message for the manual
 * recovery path (`force: true`). Returns null when the message carries no URL.
 */
export function chunkUrlFromError(error: unknown): string | null {
  let message = ""
  if (error instanceof Error) message = error.message
  else if (typeof error === "string") message = error
  if (!message) return null
  const match = message.match(/https?:\/\/[^\s"')]+\.(?:m?js|css)/)
  return match ? match[0] : null
}

/**
 * Automatic recovery performs a capped plain reload and never destroys the
 * working offline cache. Returns true if recovery was kicked off (a reload
 * will follow), false if the per-session cap has been reached and the caller
 * should fall through to a normal error UI.
 *
 * Pass `force: true` for user-initiated clicks — this is the destructive
 * escape hatch that unregisters the service worker, clears Cache Storage, and
 * force-refetches the app shell and any `bustUrls` with `cache: "reload"`.
 * The attempt cap only exists to prevent auto-recovery loops when recovery
 * itself is broken, not to limit the user's ability to ask for a clean reload.
 *
 * `bustUrls` are only used when `force: true`. The poison this recovers from
 * often lives in the *browser HTTP cache*, not CacheStorage: a hashed
 * `/assets/*.js` URL requested while the edge was mid-deploy gets the SPA
 * `index.html` fallback (200 text/html) stamped with our
 * `immutable, max-age=1yr` header (see public/_headers). That entry never
 * revalidates, so unregister + caches.delete + location.reload() can't shift
 * it — only a `cache: "reload"` fetch bypasses and overwrites it.
 */
export async function runSwRecovery(options?: { force?: boolean; bustUrls?: string[] }): Promise<boolean> {
  if (!options?.force) {
    // Non-destructive automatic path: capped plain reload only. If storage is
    // denied we can't count attempts, so refuse to reload rather than loop.
    try {
      const attempts = Number.parseInt(sessionStorage.getItem(ATTEMPTS_KEY) ?? "0", 10)
      if (attempts >= MAX_ATTEMPTS) return false
      sessionStorage.setItem(ATTEMPTS_KEY, String(attempts + 1))
      sessionStorage.setItem(LAST_ATTEMPT_KEY, String(Date.now()))
    } catch {
      return false
    }
    window.location.reload()
    return true
  }

  // A controlled page can still fetch through its worker after unregistering.
  // Delete CacheStorage before busting HTTP entries so Workbox cannot intercept
  // those fetches with the cached responses being replaced.
  if ("serviceWorker" in navigator) {
    await navigator.serviceWorker
      .getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .catch(() => {})
  }
  if ("caches" in window) {
    await caches
      .keys()
      .then((names) => Promise.all(names.map((n) => caches.delete(n))))
      .catch(() => {})
  }
  // Overwrite any immutable-cached bad responses in the browser HTTP cache.
  // Always bust the app shell; bust the specific failing chunk when we have it.
  // Bounded: a hung bust fetch on a dead connection must not stall the reload
  // that recovery exists to deliver.
  const bustUrls = new Set(["/index.html", ...(options.bustUrls ?? [])])
  await Promise.all(
    [...bustUrls].map((url) => fetch(url, { cache: "reload", signal: AbortSignal.timeout(10_000) }).catch(() => {}))
  )
  window.location.reload()
  return true
}
