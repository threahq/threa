import { sql, type Querier } from "../../db"
import { parseDeviceContext, type DeviceContext } from "@threahq/types"

interface UserDeviceContextRow {
  layout: string
  os: string
  installed: boolean
}

export const UserDeviceContextRepository = {
  /** Stores the user's latest device. Returns whether anything changed; an identical report leaves the row untouched. */
  async upsert(db: Querier, workspaceId: string, userId: string, device: DeviceContext): Promise<boolean> {
    const result = await db.query(sql`
      INSERT INTO user_device_contexts (workspace_id, user_id, layout, os, installed)
      VALUES (${workspaceId}, ${userId}, ${device.layout}, ${device.os}, ${device.installed})
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET
        layout = EXCLUDED.layout,
        os = EXCLUDED.os,
        installed = EXCLUDED.installed,
        updated_at = NOW()
      WHERE (user_device_contexts.layout, user_device_contexts.os, user_device_contexts.installed)
        IS DISTINCT FROM (EXCLUDED.layout, EXCLUDED.os, EXCLUDED.installed)
    `)
    return (result.rowCount ?? 0) > 0
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
