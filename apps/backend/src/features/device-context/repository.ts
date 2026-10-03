import { sql, type Querier } from "../../db"
import { parseDeviceContext, SHARE_DEVICE_KEY, type DeviceContext } from "@threahq/types"

interface UserDeviceContextRow {
  layout: string
  os: string
  installed: boolean
}

export const UserDeviceContextRepository = {
  /**
   * Locks the user's row until the transaction ends; false when they're no
   * longer a member. A report holds it shared and an opt-out exclusively, and
   * removal deletes it, so a report lands wholly before or after either.
   */
  async lockUser(db: Querier, workspaceId: string, userId: string, mode: "report" | "opt-out"): Promise<boolean> {
    const result =
      mode === "report"
        ? await db.query(sql`SELECT 1 FROM users WHERE workspace_id = ${workspaceId} AND id = ${userId} FOR KEY SHARE`)
        : await db.query(sql`SELECT 1 FROM users WHERE workspace_id = ${workspaceId} AND id = ${userId} FOR UPDATE`)
    return result.rows.length > 0
  },

  /**
   * Stores the user's latest device unless they turned sharing off. Call it
   * after `lockUser(..., "report")` in the same transaction: the opt-out check
   * reads from this statement's snapshot, which only that lock makes current.
   */
  async upsert(db: Querier, workspaceId: string, userId: string, device: DeviceContext): Promise<void> {
    await db.query(sql`
      INSERT INTO user_device_contexts (workspace_id, user_id, layout, os, installed)
      SELECT ${workspaceId}, ${userId}, ${device.layout}, ${device.os}, ${device.installed}
      WHERE NOT EXISTS (
        SELECT 1 FROM user_preference_overrides
        WHERE user_id = ${userId} AND key = ${SHARE_DEVICE_KEY} AND value = 'false'::jsonb
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
