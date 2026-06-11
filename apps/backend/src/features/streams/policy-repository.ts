import type { ToolPrivacyPolicy } from "@threa/types"
import type { Querier } from "../../db"
import { sql } from "../../db"

/**
 * Per-stream agent policies (`stream_policies`). A row exists only to RESTRICT:
 * absence means "no restriction", so every stream is unrestricted until a
 * policy is set. Rows are keyed by non-thread root streams — threads inherit
 * their root's policy, mirroring stream access (INV-62) — so callers resolve
 * thread → `rootStreamId` before looking up.
 *
 * Generalized from `e2e_streams.allowed_tool_categories` (agent-runtimes
 * unification Phase 1.4): one policy store for plaintext and E2E streams alike,
 * folded over each host's toolset via `negotiateCapabilities`.
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
}
