import { PUSH_PROVIDER_OUTCOMES, type PushProviderOutcome } from "@threahq/types"

export const PUSH_SEND_KINDS = {
  ACTIVITY: "activity",
  SAVED_REMINDER: "saved_reminder",
  REWRAP_NUDGE: "rewrap_nudge",
  SESSION_EXPIRED: "session_expired",
  TEST: "test",
  CALL_RING: "call_ring",
  CALL_RING_CANCEL: "call_ring_cancel",
} as const

export type PushSendKind = (typeof PUSH_SEND_KINDS)[keyof typeof PUSH_SEND_KINDS]

export const PUSH_SUPPRESSION_REASONS = {
  PUSH_DISABLED: "push_disabled",
  SELF: "self",
  MEMBER_ADDED: "member_added",
  PREF_NONE: "pref_none",
  PAUSED: "paused",
  MENTIONS_MODE: "mentions_mode",
  NO_SUBSCRIPTIONS: "no_subscriptions",
  /** Every device's session expired: those devices got the session-expired push instead. */
  SESSIONS_EXPIRED: "sessions_expired",
} as const

export type PushSuppressionReason = (typeof PUSH_SUPPRESSION_REASONS)[keyof typeof PUSH_SUPPRESSION_REASONS]

export const PUSH_PROVIDER_FAMILIES = {
  FCM: "fcm",
  MOZILLA: "mozilla",
  APPLE: "apple",
  WINDOWS: "windows",
  OTHER: "other",
} as const

export type PushProviderFamily = (typeof PUSH_PROVIDER_FAMILIES)[keyof typeof PUSH_PROVIDER_FAMILIES]

export interface ProviderResult {
  outcome: PushProviderOutcome
  /** The push service's HTTP status; null when no response arrived or its shape is unknown. */
  statusCode: number | null
  /** Short system/driver code (`ETIMEDOUT`, `57P01`) when no HTTP status exists. Never a message. */
  errorCode: string | null
}

function httpStatusOf(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null
  const statusCode = (value as { statusCode?: unknown }).statusCode
  return typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? statusCode
    : null
}

/** Error codes are logged, messages are not: `WebPushError` and pg errors carry endpoints, bodies and row values. */
export function safeErrorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null
  const code = (err as { code?: unknown }).code
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : null
}

function outcomeForStatus(statusCode: number): PushProviderOutcome {
  if (statusCode >= 200 && statusCode < 300) return PUSH_PROVIDER_OUTCOMES.ACCEPTED
  if (statusCode === 404 || statusCode === 410) return PUSH_PROVIDER_OUTCOMES.REGISTRATION_GONE
  if (statusCode === 429 || statusCode >= 500) return PUSH_PROVIDER_OUTCOMES.UNREACHABLE
  return PUSH_PROVIDER_OUTCOMES.REJECTED
}

/**
 * Classify one `webpush.sendNotification` settlement. web-push resolves only on
 * a 2xx, so a resolution without a readable status is still an acceptance with
 * an unknown status. A rejection never counts as accepted: without an HTTP
 * status it is a network failure or timeout.
 */
export function classifyProviderResult(settled: PromiseSettledResult<unknown>): ProviderResult {
  if (settled.status === "fulfilled") {
    const statusCode = httpStatusOf(settled.value)
    return {
      outcome: statusCode === null ? PUSH_PROVIDER_OUTCOMES.ACCEPTED : outcomeForStatus(statusCode),
      statusCode,
      errorCode: null,
    }
  }
  const statusCode = httpStatusOf(settled.reason)
  if (statusCode === null || (statusCode >= 200 && statusCode < 300)) {
    return { outcome: PUSH_PROVIDER_OUTCOMES.UNREACHABLE, statusCode, errorCode: safeErrorCode(settled.reason) }
  }
  return { outcome: outcomeForStatus(statusCode), statusCode, errorCode: null }
}

/** A request that was never built: nothing reached the push service, and resending the same keys fails the same way. */
export const INVALID_REGISTRATION_RESULT: ProviderResult = {
  outcome: PUSH_PROVIDER_OUTCOMES.INVALID_REGISTRATION,
  statusCode: null,
  errorCode: null,
}

export function providerFamily(endpoint: string): PushProviderFamily {
  let host: string
  try {
    host = new URL(endpoint).hostname.toLowerCase()
  } catch {
    return PUSH_PROVIDER_FAMILIES.OTHER
  }
  if (host === "fcm.googleapis.com") return PUSH_PROVIDER_FAMILIES.FCM
  if (host.endsWith(".push.services.mozilla.com")) return PUSH_PROVIDER_FAMILIES.MOZILLA
  if (host.endsWith(".push.apple.com")) return PUSH_PROVIDER_FAMILIES.APPLE
  if (host.endsWith(".notify.windows.com")) return PUSH_PROVIDER_FAMILIES.WINDOWS
  return PUSH_PROVIDER_FAMILIES.OTHER
}
