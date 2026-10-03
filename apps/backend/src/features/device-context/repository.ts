import { sql, type Querier } from "../../db"
import { parseDeviceContext, type DeviceContext } from "@threahq/types"

interface UserDeviceContextRow {
  layout: string
  os: string
  installed: boolean
}

export const UserDeviceContextRepository = {
  /**
   * Stores the user's latest device, unless they turned sharing off or are no
   * longer a member: a stale client can still report after either, and the
   * delete that went with it must stay deleted.
   */
  async upsert(db: Querier, workspaceId: string, userId: string, device: DeviceContext): Promise<void> {
    await db.query(sql`
      INSERT INTO user_device_contexts (workspace_id, user_id, layout, os, installed)
      SELECT ${workspaceId}, ${userId}, ${device.layout}, ${device.os}, ${device.installed}
      WHERE EXISTS (SELECT 1 FROM users WHERE workspace_id = ${workspaceId} AND id = ${userId})
        AND NOT EXISTS (
          SELECT 1 FROM user_preference_overrides
          WHERE user_id = ${userId} AND key = 'shareDeviceWithAgents' AND value = 'false'::jsonb
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
