import { sql, type Querier } from "../../db"
import { agentConfigOverrideId } from "../../lib/id"

interface AgentConfigOverrideRow {
  agent_id: string
  patch: unknown
}

/**
 * A row from `agent_config_overrides` (JSONB is opaque in the DB; validate/apply via
 * `applyBuiltInAgentPatch` in `built-in-agents.ts`).
 */
export interface AgentConfigOverride {
  agentId: string
  patch: unknown
}

/**
 * Data access for `agent_config_overrides`. Reads filter to `status = 'active'`.
 */
export const AgentConfigOverrideRepository = {
  /**
   * Fetch the active override for a single built-in `persona_system_*` id in a workspace, if any.
   */
  async findActiveByWorkspaceAndAgent(
    db: Querier,
    workspaceId: string,
    agentId: string
  ): Promise<AgentConfigOverride | null> {
    const result = await db.query<AgentConfigOverrideRow>(sql`
      SELECT agent_id, patch
      FROM agent_config_overrides
      WHERE workspace_id = ${workspaceId}
        AND agent_id = ${agentId}
        AND status = 'active'
    `)

    const row = result.rows[0]
    return row ? { agentId: row.agent_id, patch: row.patch } : null
  },

  /**
   * List all active overrides for a workspace (used to batch-apply built-in patches).
   */
  async listActiveByWorkspace(db: Querier, workspaceId: string): Promise<AgentConfigOverride[]> {
    const result = await db.query<AgentConfigOverrideRow>(sql`
      SELECT agent_id, patch
      FROM agent_config_overrides
      WHERE workspace_id = ${workspaceId}
        AND status = 'active'
    `)

    return result.rows.map((row) => ({ agentId: row.agent_id, patch: row.patch }))
  },

  /**
   * Merge `patch` keys into the workspace's override row for `agentId`, creating the row if
   * absent. Single-statement JSONB merge so concurrent writers can't lose each other's keys
   * (INV-20). A previously non-active row is revived with `patch` alone — its stale keys are
   * discarded rather than merged.
   */
  async mergePatch(db: Querier, workspaceId: string, agentId: string, patch: Record<string, unknown>): Promise<void> {
    await db.query(sql`
      INSERT INTO agent_config_overrides (id, workspace_id, agent_id, patch, status)
      VALUES (${agentConfigOverrideId()}, ${workspaceId}, ${agentId}, ${JSON.stringify(patch)}::jsonb, 'active')
      ON CONFLICT (workspace_id, agent_id)
      DO UPDATE SET
        patch = CASE
          WHEN agent_config_overrides.status = 'active' THEN agent_config_overrides.patch || EXCLUDED.patch
          ELSE EXCLUDED.patch
        END,
        status = 'active',
        updated_at = NOW()
    `)
  },

  /**
   * Remove `keys` from the workspace's active override patch for `agentId` (reset those
   * fields to the code-backed defaults). No-op when there is no active row.
   */
  async removePatchKeys(db: Querier, workspaceId: string, agentId: string, keys: string[]): Promise<void> {
    await db.query(sql`
      UPDATE agent_config_overrides
      SET patch = patch - ${keys}::text[],
          updated_at = NOW()
      WHERE workspace_id = ${workspaceId}
        AND agent_id = ${agentId}
        AND status = 'active'
    `)
  },
}
