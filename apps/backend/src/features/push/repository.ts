import type { Querier } from "../../db"
import { sql } from "../../db"
import { pushSubscriptionId } from "../../lib/id"

interface PushSubscriptionRow {
  id: string
  workspace_id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  device_key: string
  user_agent: string | null
  generation: number
  receipt_version: number | null
  created_at: Date
  updated_at: Date
}

export interface PushSubscription {
  id: string
  workspaceId: string
  userId: string
  endpoint: string
  p256dh: string
  auth: string
  deviceKey: string
  userAgent: string | null
  /** Trigger-maintained; bumps only when the device binding (endpoint, keys, device key, owner) changes. */
  generation: number
  /** Receipt protocol of the device's active service worker at its last handshake; null = unknown, never issued a capability. */
  receiptVersion: number | null
  createdAt: Date
  /**
   * Bumped on every (idempotent) re-registration via {@link insert}, which is
   * the only write path to this table. Push delivery reads it as "last time an
   * authenticated client confirmed this device" so a subscription survives a
   * backend socket-session timeout and only expires after genuine inactivity.
   */
  updatedAt: Date
}

export interface InsertPushSubscriptionParams {
  workspaceId: string
  userId: string
  endpoint: string
  p256dh: string
  auth: string
  deviceKey: string
  userAgent?: string
  /** Omitted by old frontends and by handshakes whose active worker predates receipts: stored as unknown. */
  receiptVersion?: number
}

function mapRowToSubscription(row: PushSubscriptionRow): PushSubscription {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    deviceKey: row.device_key,
    userAgent: row.user_agent,
    generation: row.generation,
    receiptVersion: row.receipt_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const PushSubscriptionRepository = {
  async insert(db: Querier, params: InsertPushSubscriptionParams): Promise<PushSubscription> {
    const id = pushSubscriptionId()
    const result = await db.query<PushSubscriptionRow>(sql`
      INSERT INTO push_subscriptions (
        id, workspace_id, user_id, endpoint, p256dh, auth, device_key, user_agent, receipt_version
      )
      VALUES (
        ${id},
        ${params.workspaceId},
        ${params.userId},
        ${params.endpoint},
        ${params.p256dh},
        ${params.auth},
        ${params.deviceKey},
        ${params.userAgent ?? null},
        ${params.receiptVersion ?? null}
      )
      ON CONFLICT (workspace_id, user_id, endpoint)
      DO UPDATE SET
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        device_key = EXCLUDED.device_key,
        user_agent = EXCLUDED.user_agent,
        receipt_version = EXCLUDED.receipt_version,
        updated_at = now()
      RETURNING *
    `)
    return mapRowToSubscription(result.rows[0])
  },

  async deleteByEndpoint(db: Querier, workspaceId: string, userId: string, endpoint: string): Promise<boolean> {
    const result = await db.query(sql`
      DELETE FROM push_subscriptions
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND endpoint = ${endpoint}
    `)
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Delete only rows still at the observed generation, so a delayed eviction
   * cannot remove a registration that was re-keyed after it was read.
   * Returns the ids actually deleted.
   */
  async deleteByIdsAtGeneration(
    db: Querier,
    workspaceId: string,
    pins: Array<{ id: string; generation: number }>
  ): Promise<string[]> {
    if (pins.length === 0) return []
    const result = await db.query<{ id: string }>(sql`
      DELETE FROM push_subscriptions s
      USING unnest(${pins.map((p) => p.id)}::text[], ${pins.map((p) => p.generation)}::int[]) AS pin(id, generation)
      WHERE s.workspace_id = ${workspaceId}
        AND s.id = pin.id
        AND s.generation = pin.generation
      RETURNING s.id
    `)
    return result.rows.map((row) => row.id)
  },

  /**
   * Delete one registration only while it is at `generation` and still stale:
   * not re-registered and no heartbeat for its device key within `staleForMs`
   * (the session-liveness rule, evaluated by this statement, so a sign-in that
   * lands while the caller works keeps the row). Returns whether it was deleted.
   */
  async deleteStaleAtGeneration(
    db: Querier,
    params: { workspaceId: string; id: string; generation: number; staleForMs: number }
  ): Promise<boolean> {
    const result = await db.query(
      // eslint-disable-next-line threa/workspace-scoped-sql -- only the user_sessions probe is cross-workspace (the device key is a user-agent hash, shared by every workspace the browser is active in); s stays pinned to params.workspaceId
      sql`
      DELETE FROM push_subscriptions s
      WHERE s.workspace_id = ${params.workspaceId}
        AND s.id = ${params.id}
        AND s.generation = ${params.generation}
        AND s.updated_at <= NOW() - (${params.staleForMs}::text || ' milliseconds')::interval
        AND NOT EXISTS (
          SELECT 1 FROM user_sessions us
          WHERE us.device_key = s.device_key
            AND us.last_active_at > NOW() - (${params.staleForMs}::text || ' milliseconds')::interval
        )
    `
    )
    return (result.rowCount ?? 0) > 0
  },

  /** Check if a subscription already exists for this user+endpoint (used for cap-safe upserts). */
  async existsByEndpoint(db: Querier, workspaceId: string, userId: string, endpoint: string): Promise<boolean> {
    const result = await db.query<{ exists: boolean }>(sql`
      SELECT EXISTS(
        SELECT 1 FROM push_subscriptions
        WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND endpoint = ${endpoint}
      ) AS exists
    `)
    return result.rows[0].exists
  },

  /**
   * Lock and count user subscriptions to prevent concurrent cap violations (INV-20).
   * FOR UPDATE can't be combined with aggregate functions in PostgreSQL,
   * so we lock the rows first and count in application code.
   */
  async countByUserForUpdate(db: Querier, workspaceId: string, userId: string): Promise<number> {
    const result = await db.query<{ id: string }>(sql`
      SELECT id FROM push_subscriptions
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
      FOR UPDATE
    `)
    return result.rows.length
  },

  async deleteOldestByUser(db: Querier, workspaceId: string, userId: string): Promise<void> {
    await db.query(sql`
      DELETE FROM push_subscriptions
      WHERE workspace_id = ${workspaceId} AND id = (
        SELECT id FROM push_subscriptions
        WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
        ORDER BY updated_at ASC
        LIMIT 1
      )
    `)
  },

  /**
   * Delete all push subscriptions matching an endpoint for a given user across all workspaces.
   * Used during logout to clean up backend records for a browser-scoped subscription.
   * Scoped to the user via workos_user_id → users join to maintain authorization boundaries
   * (INV-8 infra exception: same pattern as cross-workspace session cleanup).
   */
  async deleteByEndpointForUser(db: Querier, endpoint: string, workosUserId: string): Promise<number> {
    const result = await db.query(
      // eslint-disable-next-line threa/workspace-scoped-sql -- logout cleans up the browser's subscription in every workspace the WorkOS identity belongs to
      sql`
      DELETE FROM push_subscriptions ps
      USING users u
      WHERE u.workspace_id = ps.workspace_id
        AND u.id = ps.user_id
        AND u.workos_user_id = ${workosUserId}
        AND ps.endpoint = ${endpoint}
    `
    )
    return result.rowCount ?? 0
  },

  async findById(db: Querier, workspaceId: string, id: string): Promise<PushSubscription | null> {
    const result = await db.query<PushSubscriptionRow>(sql`
      SELECT * FROM push_subscriptions
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `)
    return result.rows[0] ? mapRowToSubscription(result.rows[0]) : null
  },

  async findByUserId(db: Querier, workspaceId: string, userId: string): Promise<PushSubscription[]> {
    const result = await db.query<PushSubscriptionRow>(sql`
      SELECT * FROM push_subscriptions
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
      ORDER BY created_at DESC
    `)
    return result.rows.map(mapRowToSubscription)
  },
}
