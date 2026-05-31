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
 * the cap. The cooldown lives in index.html (it can't import this module);
 * keep the two in sync.
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
 * Unregister the service worker, clear all Cache Storage buckets, then
 * hard-reload. Returns true if recovery was kicked off (a reload will
 * follow), false if the per-session cap has been reached and the caller
 * should fall through to a normal error UI.
 *
 * Pass `force: true` for user-initiated clicks — the attempt cap only
 * exists to prevent auto-recovery loops when recovery itself is broken,
 * not to limit the user's ability to ask for a clean reload.
 */
export async function runSwRecovery(options?: { force?: boolean }): Promise<boolean> {
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
  await Promise.all(tasks).catch(() => {})
  window.location.reload()
  return true
}
