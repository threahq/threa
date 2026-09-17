import type { Querier } from "@threahq/backend-common"

export interface AISpendControls {
  operatorCeilingUsd: number
  operatorAiDisabled: boolean
}

interface AISpendControlsRow {
  operator_ceiling_usd: string // NUMERIC comes as string from pg
  operator_ai_disabled: boolean
}

export const AISpendControlsRepository = {
  async find(db: Querier, workspaceId: string): Promise<AISpendControls | null> {
    const result = await db.query<AISpendControlsRow>(
      `SELECT operator_ceiling_usd, operator_ai_disabled
       FROM workspace_ai_spend_controls
       WHERE workspace_id = $1`,
      [workspaceId]
    )
    const row = result.rows[0]
    if (!row) return null
    return { operatorCeilingUsd: parseFloat(row.operator_ceiling_usd), operatorAiDisabled: row.operator_ai_disabled }
  },

  /** Race-safe upsert (INV-20) — concurrent operator writes converge on the last one. */
  async upsert(db: Querier, workspaceId: string, controls: AISpendControls): Promise<void> {
    await db.query(
      `INSERT INTO workspace_ai_spend_controls (workspace_id, operator_ceiling_usd, operator_ai_disabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id) DO UPDATE SET
         operator_ceiling_usd = EXCLUDED.operator_ceiling_usd,
         operator_ai_disabled = EXCLUDED.operator_ai_disabled,
         updated_at = NOW()`,
      [workspaceId, controls.operatorCeilingUsd, controls.operatorAiDisabled]
    )
  },
}
