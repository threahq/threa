import { sql, type Querier } from "../../db"
import { agentConfigOverrideId } from "../../lib/id"

interface AgentConfigOverrideRow {
  agent_id: string
  patch: unknown
}

interface AgentConfigOverrideDetailRow {
  patch: unknown
  updated_at: Date
}

/**
 * A row from `agent_config_overrides` (JSONB is opaque in the DB; validate/apply via
 * `applyBuiltInAgentPatch` in `built-in-agents.ts`).
 */
export interface AgentConfigOverride {
  agentId: string
  patch: unknown
}

/** The active override plus the timestamp the optimistic-concurrency check keys on. */
export interface AgentConfigOverrideDetail {
  patch: unknown
  updatedAt: string
}

export interface UpsertAgentConfigOverrideParams {
  workspaceId: string
  agentId: string
  patch: unknown
  /** The `updated_at` the caller last read; `null` asserts no override exists yet. */
  expectedUpdatedAt: string | null
}

export type UpsertAgentConfigOverrideResult =
  | { outcome: "written"; updatedAt: string }
  | { outcome: "conflict"; current: AgentConfigOverrideDetail | null }

/**
 * Read helpers for `agent_config_overrides`. All methods filter to `status = 'active'`.
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
   * Fetch the active override's patch and its `updated_at` (the optimistic
   * concurrency token), or `null` if none. `updatedAt` is serialized to ISO so
   * it round-trips through the API as the `expectedUpdatedAt` the client echoes.
   */
  async findActiveDetailByWorkspaceAndAgent(
    db: Querier,
    workspaceId: string,
    agentId: string
  ): Promise<AgentConfigOverrideDetail | null> {
    const result = await db.query<AgentConfigOverrideDetailRow>(sql`
      SELECT patch, updated_at
      FROM agent_config_overrides
      WHERE workspace_id = ${workspaceId}
        AND agent_id = ${agentId}
        AND status = 'active'
    `)

    const row = result.rows[0]
    return row ? { patch: row.patch, updatedAt: row.updated_at.toISOString() } : null
  },

  /**
   * Upsert the active override with optimistic concurrency. MUST run inside a
   * transaction: the update path takes a row lock (`FOR UPDATE`) and the insert
   * path relies on the unique constraint (`ON CONFLICT DO NOTHING`), so
   * concurrent admins can't clobber each other (INV-20).
   *
   * The lock/update filter `status = 'active'`, matching the reads: this path
   * only touches the active override and never resurrects a disabled one. With
   * `UNIQUE(workspace_id, agent_id)`, a non-active row (a future step-2
   * disable) occupies the slot, so re-activation must be its own explicit path,
   * not a side effect of saving an edit.
   *
   * `expectedUpdatedAt` must equal the current row's `updated_at` (or be `null`
   * to assert no active row exists); any divergence returns `conflict` with the
   * fresh row so the caller can surface a 409.
   */
  async upsertActive(db: Querier, params: UpsertAgentConfigOverrideParams): Promise<UpsertAgentConfigOverrideResult> {
    const { workspaceId, agentId, patch, expectedUpdatedAt } = params

    const existing = await db.query<AgentConfigOverrideDetailRow>(sql`
      SELECT patch, updated_at
      FROM agent_config_overrides
      WHERE workspace_id = ${workspaceId}
        AND agent_id = ${agentId}
        AND status = 'active'
      FOR UPDATE
    `)
    const current = existing.rows[0]

    if (current) {
      const currentUpdatedAt = current.updated_at.toISOString()
      if (expectedUpdatedAt !== currentUpdatedAt) {
        return { outcome: "conflict", current: { patch: current.patch, updatedAt: currentUpdatedAt } }
      }

      const updated = await db.query<{ updated_at: Date }>(sql`
        UPDATE agent_config_overrides
        SET patch = ${JSON.stringify(patch)}::jsonb
        WHERE workspace_id = ${workspaceId}
          AND agent_id = ${agentId}
          AND status = 'active'
        RETURNING updated_at
      `)
      return { outcome: "written", updatedAt: updated.rows[0]!.updated_at.toISOString() }
    }

    if (expectedUpdatedAt !== null) {
      // Caller expected a specific version but the row is gone — treat as a
      // conflict rather than silently creating a new override.
      return { outcome: "conflict", current: null }
    }

    const inserted = await db.query<{ updated_at: Date }>(sql`
      INSERT INTO agent_config_overrides (id, workspace_id, agent_id, patch, status)
      VALUES (${agentConfigOverrideId()}, ${workspaceId}, ${agentId}, ${JSON.stringify(patch)}::jsonb, 'active')
      ON CONFLICT (workspace_id, agent_id) DO NOTHING
      RETURNING updated_at
    `)
    const insertedRow = inserted.rows[0]
    if (insertedRow) {
      return { outcome: "written", updatedAt: insertedRow.updated_at.toISOString() }
    }

    // Lost the insert race to a concurrent creator; report their row as current.
    const raced = await this.findActiveDetailByWorkspaceAndAgent(db, workspaceId, agentId)
    return { outcome: "conflict", current: raced }
  },
}
