import { sql, type Querier } from "../../db"
import type { SidebarConfig } from "@threa/types"

interface SidebarConfigRow {
  config: SidebarConfig
}

export const SidebarConfigRepository = {
  /**
   * Fetch the stored sidebar config for a user in a workspace.
   * Returns null when the user has never customized it — the service layer
   * falls back to the code-defined default.
   */
  async find(db: Querier, workspaceId: string, userId: string): Promise<SidebarConfig | null> {
    const result = await db.query<SidebarConfigRow>(sql`
      SELECT config
      FROM sidebar_configs
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
    `)
    return result.rows[0]?.config ?? null
  },

  /**
   * Persist the full sidebar config document. Race-safe upsert (INV-20) so
   * concurrent writes from a user's devices converge rather than collide.
   */
  async upsert(db: Querier, workspaceId: string, userId: string, config: SidebarConfig): Promise<void> {
    await db.query(sql`
      INSERT INTO sidebar_configs (workspace_id, user_id, config)
      VALUES (${workspaceId}, ${userId}, ${JSON.stringify(config)}::jsonb)
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET
        config = EXCLUDED.config,
        updated_at = NOW()
    `)
  },
}
