import type { ToolPrivacyPolicy } from "@threahq/types"
import type { Querier } from "../../db"
import { sql } from "../../db"

/**
 * Per-stream agent policies (`stream_policies`). A row exists only to RESTRICT:
 * absence means "no restriction", so every stream is unrestricted until a
 * policy is set. Rows are keyed by non-thread root streams — threads inherit
 * their root's policy, mirroring stream access (INV-62) — so callers resolve
 * thread → `rootStreamId` before looking up.
 */
export const StreamPoliciesRepository = {
  /**
   * The stream's tool-privacy policy: the categories the agent may use, or
   * `null` for "no restriction" (no row). Category values are validated in
   * code, not by the schema (INV-3).
   */
  async getToolPolicy(db: Querier, workspaceId: string, streamId: string): Promise<ToolPrivacyPolicy> {
    const result = await db.query<{ allowed_tool_categories: string[] }>(sql`
      SELECT allowed_tool_categories
      FROM stream_policies
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
    `)
    return (result.rows[0]?.allowed_tool_categories as ToolPrivacyPolicy) ?? null
  },

  /**
   * Set or clear a stream's tool-privacy policy. `null` means "no restriction",
   * which this store expresses by row ABSENCE — so a null policy DELETEs any
   * existing row rather than writing a NULL (the column is `NOT NULL`). A
   * non-null policy is upserted race-safely (INV-20); note `[]` ("no tools at
   * all") is a real, persisted policy, distinct from the deleted/null case.
   * Keyed by the non-thread root stream, mirroring `getToolPolicy` — callers
   * resolve thread → `rootStreamId` before writing.
   */
  async setToolPolicy(db: Querier, workspaceId: string, streamId: string, policy: ToolPrivacyPolicy): Promise<void> {
    if (policy === null) {
      await db.query(sql`
        DELETE FROM stream_policies
        WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
      `)
      return
    }
    // `stream_id` is the PK, so the conflict target can't carry `workspace_id`;
    // the `WHERE` on the update path asserts the existing row's workspace matches
    // the caller's (INV-8). A mismatch — which the access checks upstream already
    // prevent — updates zero rows and fails loudly here (INV-11) instead of
    // silently mutating another workspace's policy.
    const result = await db.query(sql`
      INSERT INTO stream_policies (stream_id, workspace_id, allowed_tool_categories, updated_at)
      VALUES (${streamId}, ${workspaceId}, ${policy}, NOW())
      ON CONFLICT (stream_id)
      DO UPDATE SET allowed_tool_categories = EXCLUDED.allowed_tool_categories, updated_at = NOW()
      WHERE stream_policies.workspace_id = EXCLUDED.workspace_id
    `)
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error(`stream_policies workspace mismatch for stream ${streamId}`)
    }
  },
}
