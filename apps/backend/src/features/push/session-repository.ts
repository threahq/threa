import type { Querier } from "../../db"
import { sql } from "../../db"
import { userSessionId } from "../../lib/id"

interface UserSessionRow {
  id: string
  workspace_id: string
  user_id: string
  device_key: string
  last_active_at: Date
  last_focused_at: Date | null
  last_interaction_at: Date | null
  created_at: Date
}

export interface UserSession {
  id: string
  workspaceId: string
  userId: string
  deviceKey: string
  lastActiveAt: Date
  lastFocusedAt: Date | null
  lastInteractionAt: Date | null
  createdAt: Date
}

function mapRowToSession(row: UserSessionRow): UserSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    deviceKey: row.device_key,
    lastActiveAt: row.last_active_at,
    lastFocusedAt: row.last_focused_at,
    lastInteractionAt: row.last_interaction_at,
    createdAt: row.created_at,
  }
}

export const UserSessionRepository = {
  async upsert(
    db: Querier,
    params: {
      workspaceId: string
      userId: string
      deviceKey: string
      focused?: boolean
      interacted?: boolean
    }
  ): Promise<UserSession> {
    const id = userSessionId()
    const focusedAt = params.focused ? new Date() : null
    const interactedAt = params.interacted ? new Date() : null

    const result = await db.query<UserSessionRow>(sql`
      INSERT INTO user_sessions (id, workspace_id, user_id, device_key, last_active_at, last_focused_at, last_interaction_at)
      VALUES (${id}, ${params.workspaceId}, ${params.userId}, ${params.deviceKey}, now(), ${focusedAt}, ${interactedAt})
      ON CONFLICT (workspace_id, user_id, device_key)
      DO UPDATE SET
        last_active_at = now(),
        last_focused_at = COALESCE(${focusedAt}, user_sessions.last_focused_at),
        last_interaction_at = COALESCE(${interactedAt}, user_sessions.last_interaction_at)
      RETURNING *
    `)
    return mapRowToSession(result.rows[0])
  },

  /**
   * Batch upsert sessions in a single SQL statement (INV-56).
   * All entries in a batch share the same focused/interacted state (same browser tab).
   */
  async upsertBatch(
    db: Querier,
    entries: Array<{ workspaceId: string; userId: string; deviceKey: string }>,
    options?: { focused?: boolean; interacted?: boolean }
  ): Promise<void> {
    if (entries.length === 0) return
    if (entries.length === 1) {
      await this.upsert(db, { ...entries[0], focused: options?.focused, interacted: options?.interacted })
      return
    }

    const ids = entries.map(() => userSessionId())
    const workspaceIds = entries.map((e) => e.workspaceId)
    const userIds = entries.map((e) => e.userId)
    const deviceKeys = entries.map((e) => e.deviceKey)
    const focusedAt = options?.focused ? new Date() : null
    const interactedAt = options?.interacted ? new Date() : null

    await db.query(sql`
      INSERT INTO user_sessions (id, workspace_id, user_id, device_key, last_active_at, last_focused_at, last_interaction_at)
      SELECT unnest(${ids}::text[]), unnest(${workspaceIds}::text[]), unnest(${userIds}::text[]), unnest(${deviceKeys}::text[]), now(), ${focusedAt}, ${interactedAt}
      ON CONFLICT (workspace_id, user_id, device_key)
      DO UPDATE SET
        last_active_at = now(),
        last_focused_at = COALESCE(${focusedAt}, user_sessions.last_focused_at),
        last_interaction_at = COALESCE(${interactedAt}, user_sessions.last_interaction_at)
    `)
  },

  async getActiveSessions(db: Querier, workspaceId: string, userId: string, windowMs: number): Promise<UserSession[]> {
    const result = await db.query<UserSessionRow>(sql`
      SELECT * FROM user_sessions
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND last_active_at > now() - (${windowMs}::text || ' milliseconds')::interval
    `)
    return result.rows.map(mapRowToSession)
  },

  /**
   * Return which of the given device keys have had any session activity within
   * the given window across ALL workspaces. Auth sessions are global (single
   * cookie), so a device active in workspace A proves the auth is still valid
   * for workspace B. Cross-workspace by design (INV-8 infra exception, same
   * rationale as cleanupStale).
   */
  async getRecentDeviceKeys(db: Querier, deviceKeys: string[], windowMs: number): Promise<Set<string>> {
    if (deviceKeys.length === 0) return new Set()
    const result = await db.query<{ device_key: string }>(sql`
      SELECT DISTINCT device_key FROM user_sessions
      WHERE device_key = ANY(${deviceKeys})
        AND last_active_at > now() - (${windowMs}::text || ' milliseconds')::interval
    `)
    return new Set(result.rows.map((r) => r.device_key))
  },

  async cleanupStale(db: Querier, olderThanMs: number): Promise<number> {
    const result = await db.query(sql`
      DELETE FROM user_sessions
      WHERE last_active_at < now() - (${olderThanMs}::text || ' milliseconds')::interval
    `)
    return result.rowCount ?? 0
  },
}
