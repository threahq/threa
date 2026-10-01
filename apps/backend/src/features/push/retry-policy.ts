import { PUSH_PROVIDER_OUTCOMES } from "@threahq/types"
import { PUSH_DELIVERY_STATUSES, type PushDeliverySettlement } from "./delivery-repository"
import type { ProviderResult } from "./outcome"

/** Waits before provider attempts 2–5 after a retryable failure (network, 429, 5xx). */
const PUSH_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 8 * 60_000, 32 * 60_000] as const

/** Provider attempts per device, the initial one included. Infrastructure retries never count. */
export const PUSH_MAX_ATTEMPTS = PUSH_RETRY_DELAYS_MS.length + 1

/**
 * Queue claims of a delivery's jobs that never settled (a crash, a thrown
 * failure, a lost claim) a delivery absorbs before it fails as
 * `infrastructure`. Any of them may already have sent, so a device can see up
 * to this many requests beyond {@link PUSH_MAX_ATTEMPTS}.
 */
export const PUSH_MAX_ABANDONED_CLAIMS = 3

/** Terminal reason for a delivery its infrastructure could not finish: abandoned claims, or a dead-lettered job. */
export const PUSH_INFRASTRUCTURE_FAILURE = "infrastructure"

export interface ProviderAttemptResult extends ProviderResult {
  /** The push service's `Retry-After`, in ms; a lower bound on the next attempt. */
  retryAfterMs: number | null
}

/**
 * Settle one provider attempt. Only `unreachable` retries, on the fixed backoff
 * or the push service's `Retry-After` when that is longer. A retry that cannot
 * happen before `deadline` expires instead: the requested wait is never
 * shortened to fit.
 */
export function decideSettlement(params: {
  result: ProviderAttemptResult
  /** Provider attempts already recorded before this one. */
  attemptsBefore: number
  nowMs: number
  deadline: Date
}): PushDeliverySettlement {
  const { result, attemptsBefore, nowMs, deadline } = params
  const recorded = { attempted: true, outcome: result.outcome, statusCode: result.statusCode }

  switch (result.outcome) {
    case PUSH_PROVIDER_OUTCOMES.ACCEPTED:
      return { kind: "terminal", status: PUSH_DELIVERY_STATUSES.ACCEPTED, reason: null, ...recorded }
    case PUSH_PROVIDER_OUTCOMES.REGISTRATION_GONE:
      return { kind: "terminal", status: PUSH_DELIVERY_STATUSES.REGISTRATION_GONE, reason: null, ...recorded }
    case PUSH_PROVIDER_OUTCOMES.REJECTED:
    case PUSH_PROVIDER_OUTCOMES.INVALID_REGISTRATION:
      return { kind: "terminal", status: PUSH_DELIVERY_STATUSES.REJECTED, reason: result.outcome, ...recorded }
    case PUSH_PROVIDER_OUTCOMES.UNREACHABLE: {
      if (attemptsBefore + 1 >= PUSH_MAX_ATTEMPTS) {
        return { kind: "terminal", status: PUSH_DELIVERY_STATUSES.FAILED, reason: "max_attempts", ...recorded }
      }
      const delayMs = Math.max(PUSH_RETRY_DELAYS_MS[attemptsBefore]!, result.retryAfterMs ?? 0)
      const nextAttemptAt = new Date(nowMs + delayMs)
      if (nextAttemptAt.getTime() >= deadline.getTime()) {
        return { kind: "terminal", status: PUSH_DELIVERY_STATUSES.EXPIRED, reason: "retry_window_closed", ...recorded }
      }
      return { kind: "retry", nextAttemptAt, outcome: result.outcome, statusCode: result.statusCode }
    }
  }
}
