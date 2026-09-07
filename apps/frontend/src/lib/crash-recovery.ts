import { isChunkLoadError, runSwRecovery } from "@/lib/sw-recovery"

/**
 * Last-resort recovery for uncaught errors that wedge the PWA after it resumes
 * from the background. React error boundaries miss async/event-handler throws,
 * so this converts "needs manual restart" into "reloads itself".
 *
 * Scope is tight: chunk-load failures route into shared sw-recovery; other
 * errors only reload within a short post-resume window and are capped so a
 * reproducible crash does not loop forever.
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
  try {
    const last = Number.parseInt(sessionStorage.getItem(RELOAD_LAST_KEY) ?? "0", 10)
    // A crash long after the last recovery is unrelated — reset the budget so an
    // old attempt can't block a fresh, genuinely-stuck reload.
    const count =
      Date.now() - last > RELOAD_COUNT_RESET_MS
        ? 0
        : Number.parseInt(sessionStorage.getItem(RELOAD_COUNT_KEY) ?? "0", 10)
    if (count >= MAX_RELOADS) return false
    sessionStorage.setItem(RELOAD_COUNT_KEY, String(count + 1))
    sessionStorage.setItem(RELOAD_LAST_KEY, String(Date.now()))
    return true
  } catch {
    // Storage denied; without a counter we can't cap reloads, so decline.
    return false
  }
}

function handleError(value: unknown, fallbackMessage: string): void {
  let message = ""
  if (typeof value === "string") message = value
  else if (value && typeof value === "object") {
    const obj = value as { name?: unknown; message?: unknown }
    message = [obj.name, obj.message].filter((part): part is string => typeof part === "string").join(": ")
  }
  message ||= fallbackMessage
  if (isChunkLoadError(value) || isChunkLoadError(message)) {
    // Route stale-deploy chunk failures into the shared recovery. The automatic
    // path is a capped plain reload that preserves the offline cache; the
    // force-refetch escape hatch is reserved for explicit user action.
    void runSwRecovery()
    return
  }
  if (isIgnorableError(message)) return
  if (Date.now() - lastResumeAt > RESUME_RECOVERY_WINDOW_MS) return
  if (!canReload()) return
  window.location.reload()
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
