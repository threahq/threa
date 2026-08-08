const SAFE_CLASSIFICATION = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const SAFE_ERROR_CODES = new Set([
  "AbortError",
  "TimeoutError",
  "INPUT_ERROR",
  "UPSTREAM_CLOSED",
  "RATE_LIMITED",
  "SAFE_CODE",
  "UNAUTHORIZED",
])

export function safeProviderError(error: unknown): Record<string, string | number> {
  if (!error || typeof error !== "object") return { errorType: typeof error }
  const value = error as Record<string, unknown>
  const safe: Record<string, string | number> = {}
  if (typeof value.name === "string" && SAFE_CLASSIFICATION.test(value.name)) safe.errorName = value.name
  if (typeof value.code === "string") safe.errorCode = SAFE_ERROR_CODES.has(value.code) ? value.code : "other"
  if (typeof value.status === "number" && Number.isFinite(value.status)) safe.errorStatus = value.status
  return safe
}

const SAFE_DISCONNECT_REASONS = new Set([
  "server namespace disconnect",
  "client namespace disconnect",
  "server shutting down",
  "ping timeout",
  "transport close",
  "transport error",
])

export function safeDisconnectReason(reason: unknown): string {
  return typeof reason === "string" && SAFE_DISCONNECT_REASONS.has(reason) ? reason : "other"
}
