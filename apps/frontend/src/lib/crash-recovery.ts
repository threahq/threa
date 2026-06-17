import { chunkUrlFromError, isChunkLoadError, runSwRecovery } from "@/lib/sw-recovery"

/**
 * Last-resort recovery for uncaught errors that leave the app wedged after the
 * PWA returns from the background.
 *
 * The reported failure: the user opens a link, escapes to the system browser
 * ("Open in Firefox"), and comes back to a dead PWA that needs a manual
 * restart. When the OS hard-kills the renderer there is no JS left to recover
 * (the browser reloads a discarded tab on its own), but the softer variant —
 * the page survives frozen and then throws during the resume burst (socket
 * reprobe → reconnect → bootstrap + catch-up + IDB, all at once) — leaves a
 * broken in-memory app that React error boundaries can't catch, because the
 * throw is async / in an event handler, not in render. That is the case this
 * converts from "needs restart" into "reloads itself".
 *
 * Scope is deliberately tight so this can never nuke a user mid-action:
 *   - chunk-load failures (stale deploy) route into the shared sw-recovery,
 *     covering the async/import path the router error boundary misses;
 *   - any other uncaught error only triggers a reload inside a short window
 *     after a page resume — never during steady foreground use, so in-progress
 *     composer text is never thrown away;
 *   - reloads are loop-guarded, so a crash that reproduces on every load falls
 *     through to the broken app rather than reload-looping forever.
 */

const RESUME_RECOVERY_WINDOW_MS = 12_000
const RELOAD_COUNT_KEY = "crash-reload-count"
const RELOAD_LAST_KEY = "crash-reload-last"
const RELOAD_COUNT_RESET_MS = 60_000
const MAX_RELOADS = 2

let lastResumeAt = 0

/**
 * Errors that fire routinely (or that a reload can't fix) and so must never
 * trigger recovery. A reload only makes sense for a genuine programming fault
 * that wedged the app on resume — not for layout notices, opaque cross-origin
 * errors, aborted in-flight requests, or a network that simply isn't back yet
 * (reloading then just discards state and fails again).
 */
function isIgnorableError(message: string): boolean {
  return (
    message.includes("ResizeObserver loop") ||
    message.startsWith("Script error") ||
    message.includes("AbortError") ||
    message.includes("aborted") ||
    message.includes("Failed to fetch") ||
    message.includes("NetworkError") ||
    message.includes("Load failed")
  )
}

function canReload(): boolean {
  const last = Number.parseInt(sessionStorage.getItem(RELOAD_LAST_KEY) ?? "0", 10)
  // A crash long after the last recovery is unrelated — reset the budget so an
  // old attempt can't block a fresh, genuinely-stuck reload.
  const count =
    Date.now() - last > RELOAD_COUNT_RESET_MS ? 0 : Number.parseInt(sessionStorage.getItem(RELOAD_COUNT_KEY) ?? "0", 10)
  if (count >= MAX_RELOADS) return false
  sessionStorage.setItem(RELOAD_COUNT_KEY, String(count + 1))
  sessionStorage.setItem(RELOAD_LAST_KEY, String(Date.now()))
  return true
}

function recoverFromResumeCrash(): void {
  if (Date.now() - lastResumeAt > RESUME_RECOVERY_WINDOW_MS) return
  if (!canReload()) return
  window.location.reload()
}

/**
 * Best-effort message for an arbitrary thrown value. Covers `Error`,
 * `DOMException` (a real `AbortError` is one, and is NOT `instanceof Error`),
 * and any `{ name, message }` shape — so the ignore filter sees enough text to
 * classify benign rejections instead of treating them as fatal.
 */
function messageOf(value: unknown): string {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    const obj = value as { name?: unknown; message?: unknown }
    return [obj.name, obj.message].filter((part): part is string => typeof part === "string").join(": ")
  }
  return ""
}

function handleError(value: unknown, fallbackMessage: string): void {
  const message = messageOf(value) || fallbackMessage
  if (isChunkLoadError(value) || isChunkLoadError(message)) {
    const bustUrl = chunkUrlFromError(value) ?? chunkUrlFromError(message)
    void runSwRecovery({ bustUrls: bustUrl ? [bustUrl] : undefined })
    return
  }
  if (isIgnorableError(message)) return
  recoverFromResumeCrash()
}

/**
 * Install global crash recovery. Call once at startup, before React mounts.
 * Idempotent guard so a hot-reload or double-import can't stack listeners.
 * Returns a disposer (production ignores it; tests use it to tear down).
 */
let installed = false
export function installCrashRecovery(): () => void {
  if (installed || typeof window === "undefined") return () => {}
  installed = true

  const markResume = () => {
    lastResumeAt = Date.now()
  }
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) markResume()
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") markResume()
  }
  const onError = (event: ErrorEvent) => {
    handleError(event.error ?? event.message, event.message ?? "")
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    handleError(event.reason, "")
  }

  document.addEventListener("resume", markResume)
  window.addEventListener("pageshow", onPageShow)
  document.addEventListener("visibilitychange", onVisibilityChange)
  window.addEventListener("error", onError)
  window.addEventListener("unhandledrejection", onRejection)

  return () => {
    document.removeEventListener("resume", markResume)
    window.removeEventListener("pageshow", onPageShow)
    document.removeEventListener("visibilitychange", onVisibilityChange)
    window.removeEventListener("error", onError)
    window.removeEventListener("unhandledrejection", onRejection)
    installed = false
  }
}
