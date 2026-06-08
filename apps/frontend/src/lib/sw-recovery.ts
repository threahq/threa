/**
 * Recovery for stale-deploy states where cached JS/SW refers to asset
 * filenames that no longer exist on the server. Shared by:
 *
 * - index.html's inline "styles didn't load after 3s" watchdog, and
 * - the router error boundary, when a lazy route's dynamic import 404s.
 *
 * The sessionStorage counter is shared (same key) so both paths together
 * can only reload at most MAX_ATTEMPTS times before falling through to the
 * normal error UI — otherwise a persistent failure could loop forever.
 *
 * Every increment also stamps LAST_ATTEMPT_KEY with the current time. The
 * index.html watchdog only clears the counter on a healthy load when that
 * stamp is older than its reset cooldown — so a broken JS chunk (CSS still
 * loads fine!) can't keep zeroing the counter on every reload and loop past
 * the cap. The reset cooldown (60s) is enforced in index.html, which owns the
 * only read of the stamp — it can't import this module, so keep the two in
 * sync.
 */

const ATTEMPTS_KEY = "sw-recovery-attempts"
const LAST_ATTEMPT_KEY = "sw-recovery-last"
const MAX_ATTEMPTS = 2

/**
 * Detect the various dynamic-import failure messages across browsers.
 * After a deploy, old JS running in a user's tab tries to import() a chunk
 * whose content-hashed filename was replaced in the new build — producing:
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
 * Pull the asset URL out of a dynamic-import failure message, e.g.
 *   "Failed to fetch dynamically imported module: https://app.threa.io/assets/x-AbC123.js"
 * Returns null when the message carries no URL (some Safari variants).
 *
 * The URL is what recovery force-refetches with `cache: "reload"` — see the
 * `bustUrls` rationale in runSwRecovery.
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
 * Unregister the service worker, clear all Cache Storage buckets, then
 * hard-reload. Returns true if recovery was kicked off (a reload will
 * follow), false if the per-session cap has been reached and the caller
 * should fall through to a normal error UI.
 *
 * Pass `force: true` for user-initiated clicks — the attempt cap only
 * exists to prevent auto-recovery loops when recovery itself is broken,
 * not to limit the user's ability to ask for a clean reload.
 *
 * `bustUrls` are force-refetched with `cache: "reload"` before the reload.
 * The poison this recovers from often lives in the *browser HTTP cache*, not
 * CacheStorage: a hashed `/assets/*.js` URL requested while the edge was
 * mid-deploy gets the SPA `index.html` fallback (200 text/html) stamped with
 * our `immutable, max-age=1yr` header (see public/_headers). That entry never
 * revalidates, so unregister + caches.delete + location.reload() can't shift
 * it — only a `cache: "reload"` fetch bypasses and overwrites it.
 */
export async function runSwRecovery(options?: { force?: boolean; bustUrls?: string[] }): Promise<boolean> {
  if (!options?.force) {
    const attempts = Number.parseInt(sessionStorage.getItem(ATTEMPTS_KEY) ?? "0", 10)
    if (attempts >= MAX_ATTEMPTS) return false
    sessionStorage.setItem(ATTEMPTS_KEY, String(attempts + 1))
    sessionStorage.setItem(LAST_ATTEMPT_KEY, String(Date.now()))
  }

  const tasks: Promise<unknown>[] = []
  if ("serviceWorker" in navigator) {
    tasks.push(navigator.serviceWorker.getRegistrations().then((regs) => Promise.all(regs.map((r) => r.unregister()))))
  }
  if ("caches" in window) {
    tasks.push(caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))))
  }
  // Overwrite any immutable-cached bad responses in the browser HTTP cache.
  // Always bust the app shell; bust the specific failing chunk when we have it.
  const bustUrls = new Set(["/index.html", ...(options?.bustUrls ?? [])])
  for (const url of bustUrls) {
    tasks.push(fetch(url, { cache: "reload" }).catch(() => {}))
  }
  await Promise.all(tasks).catch(() => {})
  window.location.reload()
  return true
}
