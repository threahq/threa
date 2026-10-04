import { sql, type Querier } from "../../db"
import { parseDeviceContext, SHARE_DEVICE_KEY, type DeviceContext } from "@threahq/types"

export interface DeviceTarget {
  workspaceId: string
  userId: string
}

interface UserDeviceContextRow {
  layout: string
  os: string
  installed: boolean
}

export const UserDeviceContextRepository = {
  /**
   * Locks the user's row for an opt-out until the transaction ends. Reports
   * hold it shared (`lockMembers`) and removal deletes it, so a report lands
   * wholly before or after either.
   */
  async lockUser(db: Querier, workspaceId: string, userId: string): Promise<void> {
    await db.query(sql`SELECT 1 FROM users WHERE workspace_id = ${workspaceId} AND id = ${userId} FOR UPDATE`)
  },

  /** Holds the users' rows shared until the transaction ends and returns those still members. */
  async lockMembers(db: Querier, targets: DeviceTarget[]): Promise<DeviceTarget[]> {
    const result = await db.query<{ workspace_id: string; id: string }>(sql`
      SELECT u.workspace_id, u.id
      FROM users u
      JOIN unnest(${targets.map((t) => t.workspaceId)}::text[], ${targets.map((t) => t.userId)}::text[])
        AS t(workspace_id, user_id) ON u.workspace_id = t.workspace_id AND u.id = t.user_id
      ORDER BY u.workspace_id, u.id
      FOR KEY SHARE OF u
    `)
    return result.rows.map((row) => ({ workspaceId: row.workspace_id, userId: row.id }))
  },

  /**
   * Stores the latest device for each user who hasn't turned sharing off. Call
   * it after `lockMembers` in the same transaction: the opt-out check reads from
   * this statement's snapshot, which only that lock makes current.
   */
  async upsert(db: Querier, targets: DeviceTarget[], device: DeviceContext): Promise<void> {
    if (targets.length === 0) return
    await db.query(sql`
      INSERT INTO user_device_contexts (workspace_id, user_id, layout, os, installed)
      SELECT t.workspace_id, t.user_id, ${device.layout}, ${device.os}, ${device.installed}
      FROM unnest(${targets.map((t) => t.workspaceId)}::text[], ${targets.map((t) => t.userId)}::text[])
        AS t(workspace_id, user_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM user_preference_overrides o
        WHERE o.user_id = t.user_id AND o.key = ${SHARE_DEVICE_KEY} AND o.value = 'false'::jsonb
      )
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET
        layout = EXCLUDED.layout,
        os = EXCLUDED.os,
        installed = EXCLUDED.installed
      WHERE (user_device_contexts.layout, user_device_contexts.os, user_device_contexts.installed)
        IS DISTINCT FROM (EXCLUDED.layout, EXCLUDED.os, EXCLUDED.installed)
    `)
  },

  async find(db: Querier, workspaceId: string, userId: string): Promise<DeviceContext | null> {
    const result = await db.query<UserDeviceContextRow>(sql`
      SELECT layout, os, installed
      FROM user_device_contexts
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
    // A row written by a newer deploy with a value this build doesn't know reads as absent, not as a guess.
    return parseDeviceContext(result.rows[0])
  },

  async delete(db: Querier, workspaceId: string, userId: string): Promise<void> {
    await db.query(sql`
      DELETE FROM user_device_contexts
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
  },
}
