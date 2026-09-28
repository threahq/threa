import { PUSH_PROVIDER_OUTCOMES } from "@threahq/types"
import type { AnalyticsReporter } from "@threahq/backend-common"
import { logger } from "../../lib/logger"
import { pushSendOutcomesTotal, pushSuppressedTotal } from "../../lib/observability"
import {
  PUSH_PROVIDER_FAMILIES,
  PUSH_SEND_KINDS,
  PUSH_SUPPRESSION_REASONS,
  type ProviderResult,
  type PushProviderFamily,
  type PushSendKind,
  type PushSuppressionReason,
} from "./outcome"

const DEFAULT_FLUSH_INTERVAL_MS = 60_000

export const PUSH_HEALTH_DISTINCT_ID = "service:push"
export const PUSH_HEALTH_EVENTS = {
  SEND_OUTCOMES: "push_send_outcomes",
  SUPPRESSED: "push_suppressed",
  RECEIPTS: "push_receipts",
} as const

/** Receipt capability lifecycle, counted without scope, stage or any identifier. */
export const PUSH_RECEIPT_RESULTS = {
  ISSUED: "issued",
  /** Issuing failed (consent read or row write); the push went out without a capability. */
  ISSUE_FAILED: "issue_failed",
  RECORDED: "recorded",
  /** Consent or root E2E policy no longer allowed the automatic receipt; it was dropped. */
  REVOKED: "revoked",
  /** Unknown, expired, revoked or other-workspace capability. */
  UNMATCHED: "unmatched",
} as const

export type PushReceiptResult = (typeof PUSH_RECEIPT_RESULTS)[keyof typeof PUSH_RECEIPT_RESULTS]
const RECEIPT_RESULTS = new Set<string>(Object.values(PUSH_RECEIPT_RESULTS))

const KINDS = new Set<string>(Object.values(PUSH_SEND_KINDS))
const OUTCOMES = new Set<string>(Object.values(PUSH_PROVIDER_OUTCOMES))
const PROVIDERS = new Set<string>(Object.values(PUSH_PROVIDER_FAMILIES))
const REASONS = new Set<string>(Object.values(PUSH_SUPPRESSION_REASONS))

/** VAPID auth rejected: every send to that push service fails until config is fixed (INV-11 alarm). */
const VAPID_REJECTION_STATUSES = new Set([401, 403])

export interface PushSendOutcome extends ProviderResult {
  kind: PushSendKind
  provider: PushProviderFamily
}

/**
 * Consent-independent push health: prom counters, scrubbed log lines, and
 * windowed counts sent to PostHog as service events. Every label is a bounded
 * enum; nothing identifies a user, workspace, device, endpoint or delivery, so
 * the aggregate is safe to ship for users who denied analytics. Recording and
 * flushing swallow their own failures — telemetry never breaks a push.
 */
export class PushTelemetry {
  private readonly reporter: AnalyticsReporter
  private readonly flushIntervalMs: number
  private outcomeCounts = new Map<string, number>()
  private suppressedCounts = new Map<string, number>()
  private receiptCounts = new Map<string, number>()
  private windowStartedAt = Date.now()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: { reporter: AnalyticsReporter; flushIntervalMs?: number }) {
    this.reporter = deps.reporter
    this.flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  }

  start(): void {
    if (this.timer) return
    this.windowStartedAt = Date.now()
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs)
    this.timer.unref?.()
  }

  /** Stops the window timer and flushes what it holds; call before the reporter shuts down. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.flush()
  }

  recordSuppressed(kind: PushSendKind, reason: PushSuppressionReason): void {
    try {
      if (!KINDS.has(kind) || !REASONS.has(reason)) return
      pushSuppressedTotal.inc({ kind, reason })
      increment(this.suppressedCounts, `${kind}|${reason}`)
      logger.debug({ kind, reason }, "Push suppressed")
    } catch {
      // Telemetry must not fail a delivery.
    }
  }

  recordSendOutcome(result: PushSendOutcome): void {
    try {
      const { kind, provider, outcome, statusCode, errorCode } = result
      if (!KINDS.has(kind) || !OUTCOMES.has(outcome) || !PROVIDERS.has(provider)) return
      pushSendOutcomesTotal.inc({ kind, outcome, provider })
      increment(this.outcomeCounts, `${kind}|${outcome}|${provider}`)
      logOutcome({ kind, provider, outcome, statusCode, errorCode })
    } catch {
      // Telemetry must not fail a delivery.
    }
  }

  recordReceipt(result: PushReceiptResult): void {
    try {
      if (!RECEIPT_RESULTS.has(result)) return
      increment(this.receiptCounts, result)
    } catch {
      // Telemetry must not fail a delivery.
    }
  }

  flush(): void {
    const outcomes = this.outcomeCounts
    const suppressed = this.suppressedCounts
    const receipts = this.receiptCounts
    const windowSeconds = Math.max(0, Math.round((Date.now() - this.windowStartedAt) / 1000))
    this.outcomeCounts = new Map()
    this.suppressedCounts = new Map()
    this.receiptCounts = new Map()
    this.windowStartedAt = Date.now()

    for (const [key, count] of outcomes) {
      const [kind, outcome, provider] = key.split("|")
      this.capture(PUSH_HEALTH_EVENTS.SEND_OUTCOMES, { kind, outcome, provider, count, window_seconds: windowSeconds })
    }
    for (const [key, count] of suppressed) {
      const [kind, reason] = key.split("|")
      this.capture(PUSH_HEALTH_EVENTS.SUPPRESSED, { kind, reason, count, window_seconds: windowSeconds })
    }
    for (const [result, count] of receipts) {
      this.capture(PUSH_HEALTH_EVENTS.RECEIPTS, { result, count, window_seconds: windowSeconds })
    }
  }

  private capture(event: string, properties: Record<string, unknown>): void {
    try {
      this.reporter.captureEvent({
        distinctId: PUSH_HEALTH_DISTINCT_ID,
        event,
        properties: { ...properties, $process_person_profile: false },
      })
    } catch {
      // The reporter already guards its transport; this guards a faulty implementation.
    }
  }
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function logOutcome(fields: PushSendOutcome): void {
  switch (fields.outcome) {
    case PUSH_PROVIDER_OUTCOMES.ACCEPTED:
      return
    case PUSH_PROVIDER_OUTCOMES.REGISTRATION_GONE:
      logger.info(fields, "Push registration gone; evicting subscription")
      return
    case PUSH_PROVIDER_OUTCOMES.REJECTED:
      if (fields.statusCode !== null && VAPID_REJECTION_STATUSES.has(fields.statusCode)) {
        logger.error(
          fields,
          "Push service rejected VAPID auth — delivery to this push service is broken until VAPID config is fixed"
        )
        return
      }
      logger.warn(fields, "Push service rejected push")
      return
    case PUSH_PROVIDER_OUTCOMES.UNREACHABLE:
      logger.warn(fields, "Push service unreachable")
      return
    case PUSH_PROVIDER_OUTCOMES.INVALID_REGISTRATION:
      logger.warn(fields, "Push registration keys unusable; not sent")
      return
  }
}
