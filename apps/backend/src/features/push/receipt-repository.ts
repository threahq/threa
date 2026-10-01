import {
  PUSH_PROVIDER_OUTCOMES,
  PUSH_RECEIPT_STAGES,
  type PushProviderOutcome,
  type PushReceiptStage,
  type PushReceiptSuppressionReason,
  type PushTestDeviceProgress,
} from "@threahq/types"
import type { Querier } from "../../db"
import { sql } from "../../db"
import { pushReceiptId } from "../../lib/id"

export const PUSH_RECEIPT_SCOPES = {
  /** Automatic delivery: consent-gated at issuance, ingest and export. */
  DELIVERY: "delivery",
  /** Explicit Send test: first-party only, never exported. */
  TEST: "test",
} as const

export type PushReceiptScope = (typeof PUSH_RECEIPT_SCOPES)[keyof typeof PUSH_RECEIPT_SCOPES]

/** A receipt row whose capability can still record a stage. */
export interface LivePushReceipt {
  id: string
  scope: PushReceiptScope
  userId: string
  streamId: string | null
  /** The analytics consent grant a delivery receipt was armed under; null for tests. */
  consentGeneration: string | null
}

export interface TestReceiptDevice {
  subscriptionId: string
  deviceKey: string
  userAgent: string | null
  /** Null: this device's worker cannot report, so no capability is issued. */
  tokenHash: string | null
}

interface TestDeviceRow {
  subscription_id: string
  device_key: string | null
  user_agent: string | null
  provider_outcome: PushProviderOutcome | null
  provider_status_code: number | null
  token_issued: boolean
  received_at: Date | null
  outcome: PushReceiptStage | null
  outcome_reason: PushReceiptSuppressionReason | null
  capability_expires_at: Date
}

/**
 * Accepted, or unreachable: a lost provider response may still have reached the
 * device. A definite rejection or an unsent invalid registration cannot report.
 */
function awaitsReceipt(outcome: PushProviderOutcome | null): boolean {
  return outcome === PUSH_PROVIDER_OUTCOMES.ACCEPTED || outcome === PUSH_PROVIDER_OUTCOMES.UNREACHABLE
}

export const PushReceiptRepository = {
  /**
   * Row-lock a delivery's receipt, if it has one, ahead of reading the consent
   * grant to arm it under: ingest locks the receipt before the grant too, so
   * both take the same order.
   */
  async lockDelivery(db: Querier, params: { workspaceId: string; deliveryId: string }): Promise<void> {
    await db.query(sql`
      SELECT 1 FROM push_receipts
      WHERE workspace_id = ${params.workspaceId} AND delivery_id = ${params.deliveryId}
      FOR UPDATE
    `)
  },

  /**
   * Arm the receipt for one automatic device delivery with a fresh capability
   * under the user's current consent grant. Each attempt sends a new token, so
   * the row keeps only the latest hash; stages an earlier attempt's token
   * already recorded stay. A revoked receipt, or one armed under a grant that
   * has since changed, is not re-armed: returns false and the attempt carries
   * no capability.
   */
  async armDelivery(
    db: Querier,
    params: {
      workspaceId: string
      userId: string
      deliveryId: string
      subscriptionId: string
      streamId: string | null
      tokenHash: string
      consentGeneration: string
      capabilityExpiresAt: Date
      retainUntil: Date
    }
  ): Promise<boolean> {
    const result = await db.query(sql`
      INSERT INTO push_receipts (
        id, workspace_id, user_id, scope, delivery_id, subscription_id, stream_id,
        token_hash, consent_generation, capability_expires_at, retain_until
      ) VALUES (
        ${pushReceiptId()},
        ${params.workspaceId},
        ${params.userId},
        ${PUSH_RECEIPT_SCOPES.DELIVERY},
        ${params.deliveryId},
        ${params.subscriptionId},
        ${params.streamId},
        ${params.tokenHash},
        ${params.consentGeneration},
        ${params.capabilityExpiresAt},
        ${params.retainUntil}
      )
      ON CONFLICT (workspace_id, delivery_id) WHERE delivery_id IS NOT NULL
      DO UPDATE SET
        token_hash = EXCLUDED.token_hash,
        stream_id = EXCLUDED.stream_id,
        capability_expires_at = EXCLUDED.capability_expires_at,
        retain_until = GREATEST(push_receipts.retain_until, EXCLUDED.retain_until),
        updated_at = NOW()
      WHERE push_receipts.revoked_at IS NULL
        AND push_receipts.user_id = EXCLUDED.user_id
        AND push_receipts.consent_generation = EXCLUDED.consent_generation
    `)
    return (result.rowCount ?? 0) > 0
  },

  /** One row per device of an explicit test, written before any send so an early receipt finds it. */
  async insertTestDevices(
    db: Querier,
    params: {
      workspaceId: string
      userId: string
      testId: string
      devices: TestReceiptDevice[]
      capabilityExpiresAt: Date
      retainUntil: Date
    }
  ): Promise<void> {
    if (params.devices.length === 0) return
    await db.query(sql`
      INSERT INTO push_receipts (
        id, workspace_id, user_id, scope, test_id, subscription_id, device_key, user_agent,
        token_hash, capability_expires_at, retain_until
      )
      SELECT d.id, ${params.workspaceId}, ${params.userId}, ${PUSH_RECEIPT_SCOPES.TEST}, ${params.testId},
        d.subscription_id, d.device_key, d.user_agent, d.token_hash,
        ${params.capabilityExpiresAt}, ${params.retainUntil}
      FROM unnest(
        ${params.devices.map(() => pushReceiptId())}::text[],
        ${params.devices.map((d) => d.subscriptionId)}::text[],
        ${params.devices.map((d) => d.deviceKey)}::text[],
        ${params.devices.map((d) => d.userAgent)}::text[],
        ${params.devices.map((d) => d.tokenHash)}::text[]
      ) AS d(id, subscription_id, device_key, user_agent, token_hash)
    `)
  },

  async recordTestProviderOutcomes(
    db: Querier,
    params: {
      workspaceId: string
      testId: string
      results: Array<{ subscriptionId: string; outcome: PushProviderOutcome; statusCode: number | null }>
    }
  ): Promise<void> {
    if (params.results.length === 0) return
    await db.query(sql`
      UPDATE push_receipts r SET
        provider_outcome = x.outcome,
        provider_status_code = x.status_code,
        updated_at = NOW()
      FROM unnest(
        ${params.results.map((r) => r.subscriptionId)}::text[],
        ${params.results.map((r) => r.outcome)}::text[],
        ${params.results.map((r) => r.statusCode)}::int[]
      ) AS x(subscription_id, outcome, status_code)
      WHERE r.workspace_id = ${params.workspaceId}
        AND r.test_id = ${params.testId}
        AND r.subscription_id = x.subscription_id
    `)
  },

  /**
   * The unexpired, unrevoked receipt this capability belongs to, in this
   * workspace only, row-locked until the caller's transaction ends so a
   * concurrent re-arm or revoke cannot land between the read and the write.
   */
  async findLive(db: Querier, params: { workspaceId: string; tokenHash: string }): Promise<LivePushReceipt | null> {
    const result = await db.query<{
      id: string
      scope: PushReceiptScope
      user_id: string
      stream_id: string | null
      consent_generation: string | null
    }>(sql`
      SELECT id, scope, user_id, stream_id, consent_generation FROM push_receipts
      WHERE workspace_id = ${params.workspaceId}
        AND token_hash = ${params.tokenHash}
        AND revoked_at IS NULL
        AND capability_expires_at > NOW()
      FOR UPDATE
    `)
    const row = result.rows[0]
    return row
      ? {
          id: row.id,
          scope: row.scope,
          userId: row.user_id,
          streamId: row.stream_id,
          consentGeneration: row.consent_generation,
        }
      : null
  },

  /**
   * Record a stage, guarded by the capability it came with. Monotonic and
   * order-independent: `received` sets its time once; a terminal stage fills
   * an empty outcome, and `notification_created` replaces a failure or
   * suppression (a retry's notification can follow an earlier attempt's), but
   * nothing replaces it. Replays change nothing.
   */
  async recordStage(
    db: Querier,
    params: {
      workspaceId: string
      tokenHash: string
      stage: PushReceiptStage
      reason: PushReceiptSuppressionReason | null
    }
  ): Promise<boolean> {
    const isReceived = params.stage === PUSH_RECEIPT_STAGES.RECEIVED
    const isCreated = params.stage === PUSH_RECEIPT_STAGES.NOTIFICATION_CREATED
    const created = PUSH_RECEIPT_STAGES.NOTIFICATION_CREATED
    // SET expressions all read the row as it was before this update.
    const result = await db.query(sql`
      UPDATE push_receipts SET
        received_at = CASE WHEN ${isReceived} THEN COALESCE(received_at, NOW()) ELSE received_at END,
        outcome = CASE
          WHEN NOT ${isReceived} AND (outcome IS NULL OR (${isCreated} AND outcome <> ${created}))
          THEN ${params.stage} ELSE outcome END,
        outcome_reason = CASE
          WHEN NOT ${isReceived} AND (outcome IS NULL OR (${isCreated} AND outcome <> ${created}))
          THEN ${params.reason} ELSE outcome_reason END,
        outcome_at = CASE
          WHEN NOT ${isReceived} AND (outcome IS NULL OR (${isCreated} AND outcome <> ${created}))
          THEN NOW() ELSE outcome_at END,
        updated_at = NOW()
      WHERE workspace_id = ${params.workspaceId}
        AND token_hash = ${params.tokenHash}
        AND revoked_at IS NULL
        AND capability_expires_at > NOW()
    `)
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Consent or E2E policy no longer allows this automatic receipt: drop the
   * capability and anything it recorded, and mark the delivery revoked so it
   * leaves every receipt cohort.
   */
  async revoke(db: Querier, params: { workspaceId: string; id: string; tokenHash: string }): Promise<void> {
    await db.query(sql`
      UPDATE push_receipts SET
        token_hash = NULL,
        received_at = NULL,
        outcome = NULL,
        outcome_reason = NULL,
        outcome_at = NULL,
        revoked_at = NOW(),
        updated_at = NOW()
      WHERE workspace_id = ${params.workspaceId}
        AND id = ${params.id}
        AND token_hash = ${params.tokenHash}
    `)
  },

  /** The caller's own unexpired test, or null: another user's or an expired test id reads exactly like a missing one. */
  async findTestProgress(
    db: Querier,
    params: { workspaceId: string; userId: string; testId: string }
  ): Promise<{ expiresAt: Date; devices: PushTestDeviceProgress[] } | null> {
    const result = await db.query<TestDeviceRow>(sql`
      SELECT
        subscription_id, device_key, user_agent, provider_outcome, provider_status_code,
        token_hash IS NOT NULL AS token_issued, received_at, outcome, outcome_reason, capability_expires_at
      FROM push_receipts
      WHERE workspace_id = ${params.workspaceId}
        AND user_id = ${params.userId}
        AND test_id = ${params.testId}
        AND scope = ${PUSH_RECEIPT_SCOPES.TEST}
        AND retain_until > NOW()
      ORDER BY subscription_id
    `)
    if (result.rows.length === 0) return null
    return {
      expiresAt: result.rows[0]!.capability_expires_at,
      devices: result.rows.map((row) => ({
        subscriptionId: row.subscription_id,
        deviceKey: row.device_key ?? "",
        userAgent: row.user_agent,
        outcome: row.provider_outcome,
        statusCode: row.provider_status_code,
        receipt: {
          expected: row.token_issued && awaitsReceipt(row.provider_outcome),
          stage: row.outcome ?? (row.received_at ? PUSH_RECEIPT_STAGES.RECEIVED : null),
          reason: row.outcome_reason,
        },
      })),
    }
  },

  /** Retention: delete rows past `retain_until`, oldest first, in one bounded batch. Returns rows deleted. */
  async deleteExpired(db: Querier, params: { limit: number }): Promise<number> {
    const result = await db.query(sql`
      DELETE FROM push_receipts r
      USING (
        SELECT id FROM push_receipts
        WHERE retain_until < NOW()
        ORDER BY retain_until
        LIMIT ${params.limit}
        FOR UPDATE SKIP LOCKED
      ) doomed
      WHERE r.id = doomed.id
    `)
    return result.rowCount ?? 0
  },
}
