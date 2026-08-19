/**
 * The pre-join permission taxonomy (plan §Permission UX). A `getUserMedia`
 * rejection carries a `DOMException` whose `name` (and, for the OS-vs-user
 * split, a stable substring of its `message`) is an API contract, not natural
 * language — matching on it is the sanctioned way to tell these apart, and the
 * dock renders distinct copy + retry affordance per class.
 */
export type MediaPermissionErrorKind =
  | "blocked_by_policy"
  | "denied"
  | "no_device"
  | "device_busy"
  | "os_denied"
  | "unknown"

export interface MediaPermissionError {
  kind: MediaPermissionErrorKind
  /** The raw error message, for diagnostics/telemetry — not shown verbatim to the user. */
  message: string
}

function nameOf(err: unknown): string {
  return err && typeof err === "object" && "name" in err ? String((err as { name?: unknown }).name) : ""
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Map a `getUserMedia` rejection to a taxonomy class. The OS-denial and
 * blocked-by-policy cases both surface as `NotAllowedError`, split by the
 * message the engine attaches (`system` for OS privacy denials, `policy` for a
 * Permissions-Policy / feature-policy block); everything else keys on `name`.
 */
export function classifyMediaError(err: unknown): MediaPermissionError {
  const name = nameOf(err)
  const message = messageOf(err)
  const lower = message.toLowerCase()

  if (name === "NotAllowedError" || name === "SecurityError") {
    if (lower.includes("policy") || lower.includes("disallowed") || lower.includes("feature")) {
      return { kind: "blocked_by_policy", message }
    }
    if (lower.includes("system")) return { kind: "os_denied", message }
    return { kind: "denied", message }
  }
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
    return { kind: "no_device", message }
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return { kind: "device_busy", message }
  }
  return { kind: "unknown", message }
}
