import { ANALYTICS_CONSENT_GRANTED, ANALYTICS_CONSENT_KEY } from "../../../packages/types/src/preferences"
import { THRESHOLDS } from "../config"
import type { ReadProxyClient } from "../db"
import type { Finding, Window } from "../types"

/**
 * Durable push health from first-party rows only: aggregate counts, never an
 * identifier. Analytics consent does not gate the outcome and backlog parts;
 * the receipt cohort keeps a delivery only while the consent grant it was
 * armed under is still current, and applies the CURRENT root policy.
 */

/**
 * Device deliveries that reached a terminal status in one window, one per
 * device delivery by its final status and terminal reason, never per provider
 * attempt (PostHog `push_send_outcomes` is the per-attempt series).
 */
export interface PushOutcomeCounts {
  accepted: number
  /** The provider's last answer was a definite rejection (4xx, invalid registration). */
  rejected: number
  /** The provider stayed unreachable (network, 429, 5xx) until attempts or the send window ran out. */
  unreachable: number
  /** 404/410: the registration no longer exists at the provider. Normal churn, reported apart. */
  registrationGone: number
  /** The worker could not finish it (abandoned claims, dead-lettered job), whatever earlier attempts returned. */
  workerFailed: number
  /** Ended without a further send: suppressed, superseded, or the window closed before the next attempt. */
  notSent: number
  /** Terminal rows that needed more than one provider attempt. */
  retried: number
}

export interface PushBacklog {
  pending: number
  /** Pending with at least one settled attempt: waiting for a retry. */
  retrying: number
  /** Due, still unsettled, and waiting longer than the threshold. */
  overdue: number
  oldestDueSec: number | null
}

type ReceiptClass =
  | "eligible"
  | "revoked"
  | "not_accepted"
  | "unarmed_send"
  | "consent"
  | "policy"
  | "endpoint_unknown"
  | "collapsed"
  | "collapse_uncertain"

export interface ReceiptCohort {
  /** Matured automatic deliveries in the cohort: the denominator. */
  eligible: number
  /** Of those, the device reported anything: `received` or a terminal stage (a terminal stage proves receipt). */
  confirmed: number
  created: number
  suppressed: number
  creationFailed: number
  /** Matured receipt rows left out, by the first rule that excluded them. */
  excluded: Record<Exclude<ReceiptClass, "eligible">, number>
}

export type ReceiptHealth =
  | { state: "unavailable"; reason: string }
  | { state: "measured"; windowMs: number; current: ReceiptCohort; baseline: ReceiptCohort }

export interface PushReport {
  outcomes: { since: PushOutcomeCounts; prior: PushOutcomeCounts } | null
  backlog: PushBacklog | null
  receipts: ReceiptHealth
  /** Parts the schema cannot answer yet; never reported as zero. */
  unavailable: Array<{ part: "outcomes" | "receipts"; detail: string }>
  findings: Finding[]
}

type Raw = Record<string, unknown>
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))

const emptyOutcomes = (): PushOutcomeCounts => ({
  accepted: 0,
  rejected: 0,
  unreachable: 0,
  registrationGone: 0,
  workerFailed: 0,
  notSent: 0,
  retried: 0,
})

const emptyCohort = (): ReceiptCohort => ({
  eligible: 0,
  confirmed: 0,
  created: 0,
  suppressed: 0,
  creationFailed: 0,
  excluded: {
    revoked: 0,
    not_accepted: 0,
    unarmed_send: 0,
    consent: 0,
    policy: 0,
    endpoint_unknown: 0,
    collapsed: 0,
    collapse_uncertain: 0,
  },
})

/**
 * Where one terminal row lands, by the reason its final settle recorded; the
 * attempt count says nothing about why an attempt that follows it failed.
 * Mirrors PUSH_DELIVERY_STATUSES, decideSettlement and PUSH_INFRASTRUCTURE_FAILURE
 * in apps/backend/src/features/push.
 */
function outcomeBucket(status: string, reason: string | null): keyof Omit<PushOutcomeCounts, "retried"> | null {
  switch (status) {
    case "accepted":
      return "accepted"
    case "rejected":
      return "rejected"
    case "registration_gone":
      return "registrationGone"
    case "failed":
      return reason === "max_attempts" ? "unreachable" : "workerFailed"
    case "expired":
      return reason === "retry_window_closed" ? "unreachable" : "notSent"
    case "suppressed":
    case "superseded":
      return "notSent"
    default:
      return null
  }
}

const SCHEMA_SQL = `
  SELECT to_regclass('push_deliveries') IS NOT NULL AS deliveries,
         to_regclass('push_receipts') IS NOT NULL AS receipts,
         (
           SELECT count(*) = 5 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'push_deliveries'
              AND column_name IN ('sent_topic', 'sent_with_receipt', 'sent_claim_version', 'sent_at', 'sent_endpoint_hash')
         ) AS sent_columns,
         (
           SELECT count(*) = 2 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND (table_name, column_name) IN (
                ('push_receipts', 'consent_generation'), ('user_preference_overrides', 'value_generation')
              )
         ) AS consent_columns`

/**
 * Terminal rows by settle time. A terminal row is never written again (start,
 * send record and settle all require `pending`), so its `updated_at` is the
 * settle. Pending rows are excluded: starts and send records move their `updated_at`.
 */
const OUTCOMES_SQL = `
  SELECT CASE WHEN updated_at >= $1 THEN 'since' ELSE 'prior' END AS win,
         status,
         terminal_reason AS reason,
         count(*) AS deliveries,
         count(*) FILTER (WHERE attempts > 1) AS retried
    FROM push_deliveries
   WHERE status <> 'pending' AND updated_at >= $2 AND updated_at < $3
   GROUP BY 1, 2, 3`

const BACKLOG_SQL = `
  SELECT count(*) AS pending,
         count(*) FILTER (WHERE attempts > 0) AS retrying,
         count(*) FILTER (
           WHERE COALESCE(next_attempt_at, created_at) <= NOW() - ($1 * INTERVAL '1 second')
         ) AS overdue,
         EXTRACT(EPOCH FROM (NOW() - min(COALESCE(next_attempt_at, created_at)) FILTER (
           WHERE COALESCE(next_attempt_at, created_at) <= NOW()
         )))::int AS oldest_due_sec
    FROM push_deliveries
   WHERE status = 'pending'`

/**
 * Matured automatic receipt cohorts. A delivery matures when its receipt
 * capability expires (original expiry + grace): after that no report can land,
 * so both windows are closed and comparable. `cutoff` never runs ahead of the
 * database clock. Each row takes the first exclusion that applies:
 *
 * - revoked: consent or root policy was withdrawn at a report
 * - not_accepted: armed on some attempt, but the delivery did not end accepted
 * - unarmed_send: the accepting attempt start (always `version - 1`: each start
 *   and each settle moves `version` by one) did not record a send with a
 *   capability; a replica that predates recording leaves an earlier start's
 *   record behind
 * - consent: the analytics consent grant the receipt was armed under is not
 *   the user's current grant (withdrawn, reset or granted again since), or
 *   the row predates grant tracking
 * - policy: the stream, or the root it inherits from (INV-62), is gone, or the
 *   root is end-to-end encrypted now
 * - endpoint_unknown: this delivery has a topic but its accepting start did
 *   not record an endpoint, so replacement cannot be checked
 * - collapsed: a same-topic send to the same endpoint was accepted, and
 *   passed its last check no earlier than this delivery's acceptance and before
 *   its expiry, so the provider may have replaced it
 * - collapse_uncertain: another send to the same endpoint, same topic or topic
 *   unknown, or any send whose endpoint is unknown (an old-build send, or one
 *   not recorded yet), may have reached the provider while this one could
 *   still be replaced, in an order the ledger cannot tell. A send that provably
 *   finished before this one was sent, started after it expired, never reached
 *   a send, or was rejected outright on its only start replaces nothing.
 *   Missing metadata cannot prove an abandoned start used a recording writer:
 *   even a new-code crash followed by an unsent settlement can exclude nearby
 *   workspace deliveries. These incident-correlated exclusions can hide a
 *   receipt shortfall; the eligible rate is not a fleet-wide reliability rate.
 *
 * The provider replaces by endpoint and topic, and topics carry no recipient,
 * so identity is the endpoint recorded at send, never the subscription row:
 * one endpoint can back several rows (two accounts in one browser, a re-enable
 * after an opt-out) and a re-registration keeps the endpoint. Current
 * subscription rows are never joined: deleting one would rewrite history.
 *
 * The collapse checks look across the whole ledger, not just the window.
 * Membership never depends on whether the device reported, so numerator and
 * denominator are the same cohort.
 */
const RECEIPTS_SQL = `
  WITH bounds AS (
    SELECT LEAST($1::timestamptz, NOW()) AS cutoff, $2 * INTERVAL '1 millisecond' AS span
  ),
  base AS (
    SELECT
      CASE WHEN r.capability_expires_at >= b.cutoff - b.span THEN 'current' ELSE 'baseline' END AS cohort,
      CASE
        WHEN r.revoked_at IS NOT NULL OR r.token_hash IS NULL THEN 'revoked'
        WHEN d.id IS NULL OR d.status <> 'accepted' THEN 'not_accepted'
        WHEN d.sent_claim_version IS DISTINCT FROM d.version - 1 OR d.sent_with_receipt IS DISTINCT FROM true
          THEN 'unarmed_send'
        WHEN NOT EXISTS (
          SELECT 1 FROM user_preference_overrides o
           WHERE o.user_id = r.user_id AND o.key = $3 AND o.value = to_jsonb($4::text)
             AND o.value_generation = r.consent_generation
        ) THEN 'consent'
        WHEN r.stream_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM streams s
            JOIN streams root ON root.workspace_id = s.workspace_id AND root.id = COALESCE(s.root_stream_id, s.id)
           WHERE s.workspace_id = r.workspace_id AND s.id = r.stream_id
             AND NOT EXISTS (
               SELECT 1 FROM e2e_streams e WHERE e.workspace_id = root.workspace_id AND e.stream_id = root.id
             )
        ) THEN 'policy'
        WHEN d.sent_topic IS NULL THEN 'eligible'
        WHEN d.sent_endpoint_hash IS NULL THEN 'endpoint_unknown'
        WHEN EXISTS (
          SELECT 1 FROM push_deliveries y
           WHERE y.workspace_id = d.workspace_id
             AND y.sent_endpoint_hash = d.sent_endpoint_hash
             AND y.id <> d.id
             AND y.status = 'accepted'
             AND y.sent_claim_version = y.version - 1
             AND y.sent_topic = d.sent_topic
             AND y.sent_at >= d.updated_at
             AND y.sent_at < p.expires_at
        ) THEN 'collapsed'
        WHEN EXISTS (
          SELECT 1 FROM push_deliveries y
           WHERE y.workspace_id = d.workspace_id
             AND (y.sent_endpoint_hash IS NULL OR y.sent_endpoint_hash = d.sent_endpoint_hash)
             AND y.id <> d.id
             AND (y.sent_claim_version IS NULL OR y.sent_topic = d.sent_topic)
             AND y.created_at < p.expires_at
             AND NOT (y.status <> 'pending' AND y.updated_at <= d.sent_at)
             AND NOT (
               y.status <> 'pending' AND y.version = 2
               AND (y.attempts = 0 OR y.status IN ('rejected', 'registration_gone'))
             )
        ) THEN 'collapse_uncertain'
        ELSE 'eligible'
      END AS class,
      (r.received_at IS NOT NULL OR r.outcome IS NOT NULL) AS confirmed,
      r.outcome
    FROM bounds b
    JOIN push_receipts r
      ON r.scope = 'delivery'
     AND r.capability_expires_at < b.cutoff
     AND r.capability_expires_at >= b.cutoff - 2 * b.span
    LEFT JOIN push_deliveries d ON d.workspace_id = r.workspace_id AND d.id = r.delivery_id
    LEFT JOIN push_delivery_plans p ON p.workspace_id = d.workspace_id AND p.id = d.plan_id
  )
  SELECT cohort, class,
         count(*) AS deliveries,
         count(*) FILTER (WHERE confirmed) AS confirmed,
         count(*) FILTER (WHERE outcome = 'notification_created') AS created,
         count(*) FILTER (WHERE outcome = 'suppressed') AS suppressed,
         count(*) FILTER (WHERE outcome = 'creation_failed') AS creation_failed
    FROM base
   GROUP BY cohort, class`

export async function probePush(db: ReadProxyClient, window: Window): Promise<PushReport> {
  const [schema] = await db.rows<Raw>(SCHEMA_SQL)
  const hasDeliveries = schema?.deliveries === true
  const hasReceipts =
    hasDeliveries && schema?.receipts === true && schema?.sent_columns === true && schema?.consent_columns === true
  const unavailable: PushReport["unavailable"] = []
  if (!hasDeliveries)
    unavailable.push({ part: "outcomes", detail: "device outcomes and backlog: push_deliveries missing" })
  if (!hasReceipts)
    unavailable.push({
      part: "receipts",
      detail: "receipt cohorts: push_receipts, push_deliveries.sent_* or consent generations missing",
    })

  const windowMs = THRESHOLDS.pushReceiptCohortWindowMs
  const [outcomeRows, backlogRows, receiptRows] = await Promise.all([
    hasDeliveries ? db.rows<Raw>(OUTCOMES_SQL, [window.since, window.priorStart, window.now]) : null,
    hasDeliveries ? db.rows<Raw>(BACKLOG_SQL, [THRESHOLDS.pushBacklogOverdueSec]) : null,
    hasReceipts
      ? db.rows<Raw>(RECEIPTS_SQL, [window.now, windowMs, ANALYTICS_CONSENT_KEY, ANALYTICS_CONSENT_GRANTED])
      : null,
  ])

  const report: Omit<PushReport, "findings"> = {
    outcomes: outcomeRows ? foldOutcomes(outcomeRows) : null,
    backlog: backlogRows
      ? {
          pending: n(backlogRows[0]?.pending),
          retrying: n(backlogRows[0]?.retrying),
          overdue: n(backlogRows[0]?.overdue),
          oldestDueSec: backlogRows[0]?.oldest_due_sec == null ? null : n(backlogRows[0].oldest_due_sec),
        }
      : null,
    receipts: receiptRows
      ? { state: "measured", windowMs, ...foldCohorts(receiptRows) }
      : { state: "unavailable", reason: "schema not migrated" },
    unavailable,
  }
  return { ...report, findings: evaluatePush(report) }
}

export function foldOutcomes(rows: Raw[]): { since: PushOutcomeCounts; prior: PushOutcomeCounts } {
  const out = { since: emptyOutcomes(), prior: emptyOutcomes() }
  for (const row of rows) {
    const counts = row.win === "since" ? out.since : out.prior
    const bucket = outcomeBucket(String(row.status), row.reason == null ? null : String(row.reason))
    if (bucket) counts[bucket] += n(row.deliveries)
    counts.retried += n(row.retried)
  }
  return out
}

export function foldCohorts(rows: Raw[]): { current: ReceiptCohort; baseline: ReceiptCohort } {
  const out = { current: emptyCohort(), baseline: emptyCohort() }
  for (const row of rows) {
    const cohort = row.cohort === "current" ? out.current : out.baseline
    const cls = String(row.class) as ReceiptClass
    if (cls === "eligible") {
      cohort.eligible += n(row.deliveries)
      cohort.confirmed += n(row.confirmed)
      cohort.created += n(row.created)
      cohort.suppressed += n(row.suppressed)
      cohort.creationFailed += n(row.creation_failed)
    } else if (cls in cohort.excluded) {
      cohort.excluded[cls] += n(row.deliveries)
    }
  }
  return out
}

/** Wilson score interval (95%): honest bounds for a proportion from a small sample. */
export function wilson(successes: number, trials: number): { lower: number; upper: number } {
  if (trials <= 0) return { lower: 0, upper: 1 }
  const z = 1.96
  const p = successes / trials
  const denominator = 1 + (z * z) / trials
  const centre = p + (z * z) / (2 * trials)
  const margin = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))
  return { lower: Math.max(0, (centre - margin) / denominator), upper: Math.min(1, (centre + margin) / denominator) }
}

/** Device deliveries whose final status is a provider result (the transport rate's denominator). */
export function providerSettled(counts: PushOutcomeCounts): number {
  return counts.accepted + providerFailed(counts) + counts.registrationGone
}

/** Final statuses the provider caused: rejected outright, or unreachable until attempts or the window ran out. */
export function providerFailed(counts: PushOutcomeCounts): number {
  return counts.rejected + counts.unreachable
}

export function hasReceiptSample(cohort: ReceiptCohort): boolean {
  return cohort.eligible >= THRESHOLDS.pushReceiptMinSample
}

export const pct = (value: number) => `${Math.round(value * 100)}%`

export function evaluatePush(report: Omit<PushReport, "findings">): Finding[] {
  const findings: Finding[] = []
  for (const { part, detail } of report.unavailable) {
    findings.push({ level: "warn", id: `push.unavailable.${part}`, message: `push ${detail}; unavailable, not zero` })
  }

  if (report.outcomes) {
    const { since, prior } = report.outcomes
    const settled = providerSettled(since)
    const failed = providerFailed(since)
    const rate = settled ? failed / settled : 0
    if (settled >= THRESHOLDS.pushTransportMinSample && rate >= THRESHOLDS.pushTransportFailureRate) {
      findings.push({
        level: "warn",
        id: "push.transport",
        message: `push: ${failed}/${settled} device deliveries ended in provider failure since baseline (${pct(rate)}: rejected ${since.rejected}, unreachable ${since.unreachable}; prior ${providerFailed(prior)}/${providerSettled(prior)})`,
      })
    }
    if (since.workerFailed > 0) {
      findings.push({
        level: "warn",
        id: "push.worker_failed",
        message: `push: ${since.workerFailed} device deliveries failed because the worker could not finish them since baseline (prior ${prior.workerFailed})`,
      })
    }
  }

  if (report.backlog && report.backlog.overdue > 0) {
    findings.push({
      level: "warn",
      id: "push.backlog",
      message: `push: ${report.backlog.overdue} device deliveries due and unsettled for over ${THRESHOLDS.pushBacklogOverdueSec}s (oldest ${report.backlog.oldestDueSec}s)`,
    })
  }

  if (report.receipts.state === "measured") {
    const { current, baseline } = report.receipts
    if (hasReceiptSample(current)) {
      const now = wilson(current.confirmed, current.eligible)
      const ratio = current.confirmed / current.eligible
      if (now.upper < THRESHOLDS.pushReceiptFloor) {
        findings.push({
          level: "warn",
          id: "push.receipts.shortfall",
          message: `push receipts: only ${current.confirmed}/${current.eligible} matured deliveries confirmed by the device (${pct(ratio)}, 95% upper ${pct(now.upper)} < ${pct(THRESHOLDS.pushReceiptFloor)}); unconfirmed, not proven lost`,
        })
      }
      if (hasReceiptSample(baseline)) {
        const before = wilson(baseline.confirmed, baseline.eligible)
        const baselineRatio = baseline.confirmed / baseline.eligible
        if (now.upper < before.lower && baselineRatio - ratio >= THRESHOLDS.pushReceiptDropPoints) {
          findings.push({
            level: "warn",
            id: "push.receipts.drop",
            message: `push receipts: confirmation fell to ${pct(ratio)} (${current.confirmed}/${current.eligible}) from ${pct(baselineRatio)} (${baseline.confirmed}/${baseline.eligible}) in the previous matured window`,
          })
        }
      }
      if (current.confirmed >= THRESHOLDS.pushReceiptMinSample) {
        const failedRate = current.creationFailed / current.confirmed
        if (failedRate >= THRESHOLDS.pushCreationFailedRate) {
          findings.push({
            level: "warn",
            id: "push.receipts.creation_failed",
            message: `push receipts: ${current.creationFailed}/${current.confirmed} confirmed deliveries reported notification creation failed (${pct(failedRate)})`,
          })
        }
      }
    }
  }
  return findings
}
