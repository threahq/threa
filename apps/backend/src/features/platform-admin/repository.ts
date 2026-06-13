import { sql, type Querier } from "../../db"

/**
 * Regional mirror of control-plane platform-admin grants. Presence of a row
 * means the workspace user is a platform admin. Rows are written only by the
 * control-plane fan-out (`POST /internal/platform-admin`); regional product
 * code reads them at bootstrap time.
 */
export const PlatformAdminAccessRepository = {
  async hasAccess(db: Querier, workspaceId: string, workosUserId: string): Promise<boolean> {
    const result = await db.query(sql`
      SELECT 1 FROM platform_admin_access
      WHERE workspace_id = ${workspaceId} AND workos_user_id = ${workosUserId}
    `)
    return result.rows.length > 0
  },

  /**
   * Apply a control-plane snapshot for one workspace user: grant inserts the
   * row, revoke deletes it. Both branches are single race-safe statements
   * (INV-20) — concurrent syncs converge on the last writer.
   */
  async setAccess(db: Querier, workspaceId: string, workosUserId: string, isPlatformAdmin: boolean): Promise<void> {
    if (isPlatformAdmin) {
      await db.query(sql`
        INSERT INTO platform_admin_access (workspace_id, workos_user_id)
        VALUES (${workspaceId}, ${workosUserId})
        ON CONFLICT (workspace_id, workos_user_id) DO UPDATE SET updated_at = NOW()
      `)
    } else {
      await db.query(sql`
        DELETE FROM platform_admin_access
        WHERE workspace_id = ${workspaceId} AND workos_user_id = ${workosUserId}
      `)
    }
  },
}
