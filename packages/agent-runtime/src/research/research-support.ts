import type { SourceType, TraceSource } from "@threa/types"

/**
 * Compose an {@link AbortSignal} that fires when an optional parent signal aborts
 * OR a timeout elapses, whichever comes first — with leak-safe teardown.
 *
 * Shared by the bounded researchers (workspace + general), which both need a
 * per-operation signal that respects a parent stop signal and a wall-clock
 * deadline. Built manually (not `AbortSignal.any` + `AbortSignal.timeout`) so it
 * can abort synchronously when the timeout is already non-positive — the awaiting
 * call then rejects immediately instead of consuming its full budget.
 */
export interface ComposedAbortSignal {
  signal: AbortSignal
  /** Clears the timeout timer and the parent listener. Call in a `finally`. */
  cleanup: () => void
}

export function composeAbortSignal(params: {
  /** Parent signal (e.g. session stop). Its abort propagates to the composed signal. */
  parent?: AbortSignal
  /**
   * Milliseconds until the timeout arm fires. `<= 0` aborts synchronously;
   * `Infinity` disables the timer (parent-only).
   */
  timeoutMs: number
  /** Label for the timeout's `TimeoutError`, for diagnosability. */
  timeoutReason: string
}): ComposedAbortSignal {
  const { parent, timeoutMs, timeoutReason } = params
  const controller = new AbortController()

  const abortTimeout = () => {
    try {
      controller.abort(new DOMException(timeoutReason, "TimeoutError"))
    } catch {
      // DOMException isn't available in every runtime; fall back to a plain Error.
      controller.abort(new Error(timeoutReason))
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  if (timeoutMs <= 0) {
    abortTimeout()
  } else if (timeoutMs !== Infinity) {
    timer = setTimeout(abortTimeout, timeoutMs)
  }

  let parentListener: (() => void) | null = null
  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason)
    } else {
      parentListener = () => controller.abort(parent.reason)
      parent.addEventListener("abort", parentListener, { once: true })
    }
  }

  const cleanup = () => {
    if (timer !== null) clearTimeout(timer)
    if (parentListener && parent) parent.removeEventListener("abort", parentListener)
  }

  return { signal: controller.signal, cleanup }
}

/** Map the wider TraceSource type space onto the SourceItem type space. */
export function normalizeSourceType(type: string): SourceType {
  if (type === "github") return "github"
  if (type === "web") return "web"
  // workspace, workspace_message, workspace_memo → workspace
  return "workspace"
}

/** Read a trimmed non-empty string field off an unknown tool input. */
export function readStringField(input: unknown, field: string): string | undefined {
  if (input && typeof input === "object" && field in input) {
    const value = (input as Record<string, unknown>)[field]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}
