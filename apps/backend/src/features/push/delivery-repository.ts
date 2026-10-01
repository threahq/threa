import type { PushProviderOutcome } from "@threahq/types"
import type { Querier } from "../../db"
import { sql } from "../../db"
import { pushDeliveryId, pushDeliveryPlanId } from "../../lib/id"
import type { PUSH_SEND_KINDS } from "./outcome"

export type DurablePushKind =
  | typeof PUSH_SEND_KINDS.ACTIVITY
  | typeof PUSH_SEND_KINDS.SAVED_REMINDER
  | typeof PUSH_SEND_KINDS.REWRAP_NUDGE

export const PUSH_DELIVERY_STATUSES = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  REGISTRATION_GONE: "registration_gone",
  /** Retryable failures exhausted their attempts or their original expiry. */
  FAILED: "failed",
  /** Revalidation dropped it before a send: read, source gone, access lost, prefs, pause. */
  SUPPRESSED: "suppressed",
  /** The send window closed first: before an attempt, or before a retry the push service's wait allows. */
  EXPIRED: "expired",
  /** The subscription was removed or re-keyed after planning. */
  SUPERSEDED: "superseded",
} as const

export type PushDeliveryStatus = (typeof PUSH_DELIVERY_STATUSES)[keyof typeof PUSH_DELIVERY_STATUSES]
export type TerminalPushDeliveryStatus = Exclude<PushDeliveryStatus, typeof PUSH_DELIVERY_STATUSES.PENDING>

export interface PlanPushDeliveryParams {
  workspaceId: string
  userId: string
  kind: DurablePushKind
  /** Outbox event id of the source event; with `userId` it dedupes replays. */
  sourceEventId: bigint
  /** activity id, saved id or root stream id, depending on `kind`. */
  sourceId: string
  /** Saved-reminder generation pinned at fire time; null for other kinds. */
  sourceGeneration: number | null
  /** Original source event time; expiry is derived from it, never from plan time. */
  sourceCreatedAt: Date
  expiresAt: Date
  subscriptions: Array<{ id: string; generation: number }>
}

export interface PlannedPushDevice {
  id: string
  subscriptionId: string
  subscriptionGeneration: number
}

export interface PlannedPushDelivery {
  planId: string
  devices: PlannedPushDevice[]
}

/** A started device attempt. `subscription` is null when the row was deleted or re-keyed since planning. */
export interface StartedPushDelivery {
  id: string
  workspaceId: string
  userId: string
  kind: DurablePushKind
  sourceEventId: bigint
  sourceId: string
  sourceGeneration: number | null
  sourceCreatedAt: Date
  expiresAt: Date
  attempts: number
  /** The version this start wrote: pass back to {@link PushDeliveryRepository.recordSend} and `settle`. */
  version: number
  subscriptionId: string
  subscriptionGeneration: number
  subscription: { endpoint: string; p256dh: string; auth: string; receiptVersion: number | null } | null
}

export type PushDeliverySettlement =
  | {
      kind: "retry"
      nextAttemptAt: Date
      outcome: PushProviderOutcome
      statusCode: number | null
    }
  | {
      kind: "terminal"
      status: TerminalPushDeliveryStatus
      /** Whether this settle follows a provider request (counts toward `attempts`). */
      attempted: boolean
      outcome: PushProviderOutcome | null
      statusCode: number | null
      reason: string | null
    }

export interface SettledPushDelivery {
  id: string
  status: PushDeliveryStatus
  attempts: number
  version: number
}

interface PlannedRow {
  plan_id: string
  id: string | null
  subscription_id: string | null
  subscription_generation: number | null
}

interface StartedRow {
  id: string
  workspace_id: string
  user_id: string
  kind: DurablePushKind
  source_event_id: string
  source_id: string
  source_generation: number | null
  source_created_at: Date
  expires_at: Date
  attempts: number
  version: number
  subscription_id: string
  subscription_generation: number
  endpoint: string | null
  p256dh: string | null
  auth: string | null
  receipt_version: number | null
}

export const PushDeliveryRepository = {
  /**
   * Plan one source event for one recipient in a single statement: the plan
   * row and every device row land together or not at all. Returns null when
   * the (event, recipient) plan already exists, so a replayed outbox event
   * plans nothing. Call inside the transaction that enqueues the device jobs.
   */
  async insertPlan(db: Querier, params: PlanPushDeliveryParams): Promise<PlannedPushDelivery | null> {
    const planId = pushDeliveryPlanId()
    const deviceIds = params.subscriptions.map(() => pushDeliveryId())
    const result = await db.query<PlannedRow>(sql`
      WITH plan AS (
        INSERT INTO push_delivery_plans (
          id, workspace_id, user_id, kind, source_event_id, source_id,
          source_generation, source_created_at, expires_at
        ) VALUES (
          ${planId},
          ${params.workspaceId},
          ${params.userId},
          ${params.kind},
          ${params.sourceEventId.toString()}::bigint,
          ${params.sourceId},
          ${params.sourceGeneration},
          ${params.sourceCreatedAt},
          ${params.expiresAt}
        )
        ON CONFLICT (workspace_id, source_event_id, user_id) DO NOTHING
        RETURNING id
      ),
      devices AS (
        INSERT INTO push_deliveries (id, workspace_id, plan_id, subscription_id, subscription_generation)
        SELECT d.id, ${params.workspaceId}, plan.id, d.subscription_id, d.generation
        FROM plan
        CROSS JOIN unnest(
          ${deviceIds}::text[],
          ${params.subscriptions.map((s) => s.id)}::text[],
          ${params.subscriptions.map((s) => s.generation)}::int[]
        ) AS d(id, subscription_id, generation)
        RETURNING id, plan_id, subscription_id, subscription_generation
      )
      SELECT plan.id AS plan_id, devices.id, devices.subscription_id, devices.subscription_generation
      FROM plan
      LEFT JOIN devices ON devices.plan_id = plan.id
    `)
    if (result.rows.length === 0) return null
    return {
      planId: result.rows[0]!.plan_id,
      devices: result.rows.flatMap((row) =>
        row.id === null
          ? []
          : [{ id: row.id, subscriptionId: row.subscription_id!, subscriptionGeneration: row.subscription_generation! }]
      ),
    }
  },

  /**
   * Start one provider attempt on a pending device delivery. Call only in a
   * transaction that holds the attempt's queue claim: the queue claim owns
   * execution, this only rejects work already finished (settled, a later
   * attempt, retention-deleted) and moves `version`. The subscription is
   * joined at the planned generation only.
   *
   * `version` counts attempt starts and settles (each +1), so `version - 1`
   * of an accepted row is the start that accepted, and a settled row at
   * version 2 had exactly one start. Receipt monitoring relies on both.
   */
  async startAttempt(
    db: Querier,
    params: { workspaceId: string; deliveryId: string; attempt: number }
  ): Promise<StartedPushDelivery | null> {
    const result = await db.query<StartedRow>(sql`
      WITH started AS (
        UPDATE push_deliveries SET version = version + 1, updated_at = NOW()
        WHERE id = ${params.deliveryId}
          AND workspace_id = ${params.workspaceId}
          AND status = 'pending'
          AND attempts = ${params.attempt}
        RETURNING id, workspace_id, plan_id, subscription_id, subscription_generation, attempts, version
      )
      SELECT
        c.id, c.workspace_id, p.user_id, p.kind, p.source_event_id::text AS source_event_id, p.source_id,
        p.source_generation, p.source_created_at, p.expires_at, c.attempts, c.version,
        c.subscription_id, c.subscription_generation, s.endpoint, s.p256dh, s.auth, s.receipt_version
      FROM started c
      JOIN push_delivery_plans p ON p.id = c.plan_id AND p.workspace_id = c.workspace_id
      LEFT JOIN push_subscriptions s
        ON s.id = c.subscription_id
        AND s.workspace_id = c.workspace_id
        AND s.user_id = p.user_id
        AND s.generation = c.subscription_generation
    `)
    const row = result.rows[0]
    if (!row) return null
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      userId: row.user_id,
      kind: row.kind,
      sourceEventId: BigInt(row.source_event_id),
      sourceId: row.source_id,
      sourceGeneration: row.source_generation,
      sourceCreatedAt: row.source_created_at,
      expiresAt: row.expires_at,
      attempts: row.attempts,
      version: row.version,
      subscriptionId: row.subscription_id,
      subscriptionGeneration: row.subscription_generation,
      subscription:
        row.endpoint === null
          ? null
          : { endpoint: row.endpoint, p256dh: row.p256dh!, auth: row.auth!, receiptVersion: row.receipt_version },
    }
  },

  /**
   * Record a started attempt's result, guarded by the start's version. A retry
   * keeps the row pending with `attempts + 1` and a `next_attempt_at`, so only
   * the job for that next attempt number can start it. Returns null when the
   * row moved on; callers enqueue the next job in the same transaction only on
   * success.
   */
  async settle(
    db: Querier,
    params: { workspaceId: string; deliveryId: string; version: number; settlement: PushDeliverySettlement }
  ): Promise<SettledPushDelivery | null> {
    const s = params.settlement
    const isRetry = s.kind === "retry"
    const status = isRetry ? PUSH_DELIVERY_STATUSES.PENDING : s.status
    const attempted = isRetry || s.attempted
    const result = await db.query<SettledPushDelivery>(sql`
      UPDATE push_deliveries SET
        status = ${status},
        attempts = attempts + ${attempted ? 1 : 0},
        version = version + 1,
        next_attempt_at = ${isRetry ? s.nextAttemptAt : null},
        last_outcome = COALESCE(${s.outcome}, last_outcome),
        last_status_code = CASE WHEN ${attempted} THEN ${s.statusCode} ELSE last_status_code END,
        terminal_reason = ${isRetry ? null : s.reason},
        accepted_at = CASE WHEN ${status === PUSH_DELIVERY_STATUSES.ACCEPTED} THEN NOW() ELSE accepted_at END,
        updated_at = NOW()
      WHERE id = ${params.deliveryId}
        AND workspace_id = ${params.workspaceId}
        AND version = ${params.version}
        AND status = 'pending'
      RETURNING id, status, attempts, version
    `)
    return result.rows[0] ?? null
  },

  /**
   * Record what the started attempt is about to send (topic, whether it
   * carries a receipt capability, the endpoint's hash) as the last write
   * before the send, guarded by the start's version so a later start's record
   * is never overwritten. `sent_at` is a lower bound on when the send began.
   */
  async recordSend(
    db: Querier,
    params: {
      workspaceId: string
      deliveryId: string
      version: number
      sent: { topic: string | null; withReceipt: boolean; endpointHash: string }
    }
  ): Promise<boolean> {
    const { sent } = params
    const result = await db.query(sql`
      UPDATE push_deliveries SET
        sent_topic = ${sent.topic},
        sent_with_receipt = ${sent.withReceipt},
        sent_claim_version = ${params.version},
        sent_at = NOW(),
        sent_endpoint_hash = ${sent.endpointHash},
        updated_at = NOW()
      WHERE id = ${params.deliveryId}
        AND workspace_id = ${params.workspaceId}
        AND version = ${params.version}
        AND status = 'pending'
    `)
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Fail the attempt a dead-lettered job was running, as `infrastructure`,
   * unless the delivery already settled or moved to a later attempt. Moves
   * `version` by a start and a settle, like any settle of an unsent attempt.
   */
  async failDeadLettered(
    db: Querier,
    params: { workspaceId: string; deliveryId: string; attempt: number; reason: string }
  ): Promise<boolean> {
    const result = await db.query(sql`
      UPDATE push_deliveries SET
        status = ${PUSH_DELIVERY_STATUSES.FAILED},
        version = version + 2,
        next_attempt_at = NULL,
        terminal_reason = ${params.reason},
        updated_at = NOW()
      WHERE id = ${params.deliveryId}
        AND workspace_id = ${params.workspaceId}
        AND status = 'pending'
        AND attempts = ${params.attempt}
    `)
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Retention: delete plans (and their device rows) whose original expiry is
   * before `expiredBefore`. Pass a cutoff well past the longest TTL so no plan
   * that can still send is touched. Returns the number of plans deleted.
   */
  async deleteExpiredPlans(db: Querier, params: { expiredBefore: Date; limit: number }): Promise<number> {
    const result = await db.query(sql`
      WITH doomed AS (
        SELECT id, workspace_id FROM push_delivery_plans
        WHERE expires_at < ${params.expiredBefore}
        ORDER BY expires_at
        LIMIT ${params.limit}
        FOR UPDATE SKIP LOCKED
      ),
      doomed_devices AS (
        DELETE FROM push_deliveries d
        USING doomed
        WHERE d.plan_id = doomed.id AND d.workspace_id = doomed.workspace_id
      )
      DELETE FROM push_delivery_plans p
      USING doomed
      WHERE p.id = doomed.id
    `)
    return result.rowCount ?? 0
  },
}
