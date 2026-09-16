import { sql, type Querier } from "../../db"

/** Applies to a workspace with no ai_budgets row. Matches the column defaults. */
const DEFAULT_MONTHLY_BUDGET_USD = 50
const DEFAULT_OPERATOR_CEILING_USD = 50

interface AIBudgetRow {
  id: string
  workspace_id: string
  monthly_budget_usd: string // NUMERIC comes as string from pg
  alert_threshold_50: boolean
  alert_threshold_80: boolean
  alert_threshold_100: boolean
  created_at: Date
  updated_at: Date
}

interface AIUserQuotaRow {
  id: string
  workspace_id: string
  user_id: string
  monthly_quota_usd: string | null
  created_at: Date
  updated_at: Date
}

interface AIAlertRow {
  id: string
  workspace_id: string
  user_id: string | null
  alert_type: string
  threshold_percent: number
  period_start: Date
  created_at: Date
}

export interface AIBudget {
  id: string
  workspaceId: string
  monthlyBudgetUsd: number
  alertThreshold50: boolean
  alertThreshold80: boolean
  alertThreshold100: boolean
  createdAt: Date
  updatedAt: Date
}

export interface AIUserQuota {
  id: string
  workspaceId: string
  userId: string
  monthlyQuotaUsd: number | null
  createdAt: Date
  updatedAt: Date
}

export interface AIAlert {
  id: string
  workspaceId: string
  userId: string | null
  alertType: string
  thresholdPercent: number
  periodStart: Date
  createdAt: Date
}

export interface UpsertAIBudgetParams {
  id: string
  workspaceId: string
  monthlyBudgetUsd?: number
  alertThreshold50?: boolean
  alertThreshold80?: boolean
  alertThreshold100?: boolean
}

export interface SpendPosition {
  monthlyBudgetUsd: number
  operatorCeilingUsd: number
  workspaceAiDisabled: boolean
  operatorAiDisabled: boolean
  workspaceSpendUsd: number
  /** Null when the request carries no user. */
  user: {
    aiDisabled: boolean
    monthlyQuotaUsd: number | null
    agentAllowanceUsd: number | null
    spendUsd: number
    agentSpendUsd: number
  } | null
}

export interface FindSpendPositionParams {
  workspaceId: string
  userId?: string
  periodStart: Date
  periodEnd: Date
  agentFunctionIds: string[]
}

export interface UpsertAIUserQuotaParams {
  id: string
  workspaceId: string
  userId: string
  monthlyQuotaUsd: number | null
}

export interface InsertAIAlertParams {
  id: string
  workspaceId: string
  userId?: string
  alertType: string
  thresholdPercent: number
  periodStart: Date
}

function parseNullableUsd(value: string | null): number | null {
  return value === null ? null : parseFloat(value)
}

function mapRowToBudget(row: AIBudgetRow): AIBudget {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    monthlyBudgetUsd: parseFloat(row.monthly_budget_usd),
    alertThreshold50: row.alert_threshold_50,
    alertThreshold80: row.alert_threshold_80,
    alertThreshold100: row.alert_threshold_100,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapRowToQuota(row: AIUserQuotaRow): AIUserQuota {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    monthlyQuotaUsd: parseNullableUsd(row.monthly_quota_usd),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapRowToAlert(row: AIAlertRow): AIAlert {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    alertType: row.alert_type,
    thresholdPercent: row.threshold_percent,
    periodStart: row.period_start,
    createdAt: row.created_at,
  }
}

const BUDGET_FIELDS = `
  id, workspace_id, monthly_budget_usd,
  alert_threshold_50, alert_threshold_80, alert_threshold_100,
  created_at, updated_at
`

const QUOTA_FIELDS = `id, workspace_id, user_id, monthly_quota_usd, created_at, updated_at`
const ALERT_FIELDS = `id, workspace_id, user_id, alert_type, threshold_percent, period_start, created_at`

export const AIBudgetRepository = {
  async findByWorkspace(db: Querier, workspaceId: string): Promise<AIBudget | null> {
    const result = await db.query<AIBudgetRow>(sql`
      SELECT ${sql.raw(BUDGET_FIELDS)} FROM ai_budgets
      WHERE workspace_id = ${workspaceId}
    `)
    if (!result.rows[0]) return null
    return mapRowToBudget(result.rows[0])
  },

  /**
   * Atomic upsert with partial update semantics: INSERT applies defaults for
   * unprovided fields, UPDATE preserves existing values for them. Avoids
   * find-then-update races (INV-20).
   */
  async upsertPartial(db: Querier, params: UpsertAIBudgetParams): Promise<AIBudget> {
    const monthlyBudgetUsd = params.monthlyBudgetUsd ?? null
    const alertThreshold50 = params.alertThreshold50 ?? null
    const alertThreshold80 = params.alertThreshold80 ?? null
    const alertThreshold100 = params.alertThreshold100 ?? null

    const result = await db.query<AIBudgetRow>(sql`
      INSERT INTO ai_budgets (
        id, workspace_id, monthly_budget_usd,
        alert_threshold_50, alert_threshold_80, alert_threshold_100
      )
      VALUES (
        ${params.id},
        ${params.workspaceId},
        COALESCE(${monthlyBudgetUsd}::numeric, ${DEFAULT_MONTHLY_BUDGET_USD}),
        COALESCE(${alertThreshold50}, true),
        COALESCE(${alertThreshold80}, true),
        COALESCE(${alertThreshold100}, true)
      )
      ON CONFLICT (workspace_id) DO UPDATE SET
        monthly_budget_usd = COALESCE(${monthlyBudgetUsd}, ai_budgets.monthly_budget_usd),
        alert_threshold_50 = COALESCE(${alertThreshold50}, ai_budgets.alert_threshold_50),
        alert_threshold_80 = COALESCE(${alertThreshold80}, ai_budgets.alert_threshold_80),
        alert_threshold_100 = COALESCE(${alertThreshold100}, ai_budgets.alert_threshold_100),
        updated_at = NOW()
      RETURNING ${sql.raw(BUDGET_FIELDS)}
    `)
    return mapRowToBudget(result.rows[0])
  },

  /** The limits and month-to-date spend a spend decision is made against, in one read. */
  async findSpendPosition(db: Querier, params: FindSpendPositionParams): Promise<SpendPosition> {
    const userId = params.userId ?? null
    const result = await db.query<{
      monthly_budget_usd: string
      operator_ceiling_usd: string
      workspace_ai_disabled: boolean
      operator_ai_disabled: boolean
      default_user_agent_allowance_usd: string | null
      user_ai_disabled: boolean
      monthly_quota_usd: string | null
      agent_allowance_usd: string | null
      workspace_spend_usd: string
      user_spend_usd: string
      user_agent_spend_usd: string
    }>(sql`
      SELECT
        COALESCE(b.monthly_budget_usd, ${DEFAULT_MONTHLY_BUDGET_USD}) AS monthly_budget_usd,
        COALESCE(b.operator_ceiling_usd, ${DEFAULT_OPERATOR_CEILING_USD}) AS operator_ceiling_usd,
        COALESCE(b.ai_disabled, false) AS workspace_ai_disabled,
        COALESCE(b.operator_ai_disabled, false) AS operator_ai_disabled,
        b.default_user_agent_allowance_usd,
        COALESCE(q.ai_disabled, false) AS user_ai_disabled,
        q.monthly_quota_usd,
        q.agent_allowance_usd,
        spend.workspace_spend_usd,
        spend.user_spend_usd,
        spend.user_agent_spend_usd
      FROM (
        SELECT
          COALESCE(SUM(cost_usd), 0) AS workspace_spend_usd,
          COALESCE(SUM(cost_usd) FILTER (WHERE user_id = ${userId}), 0) AS user_spend_usd,
          COALESCE(SUM(cost_usd) FILTER (
            WHERE user_id = ${userId} AND function_id = ANY(${params.agentFunctionIds}::text[])
          ), 0) AS user_agent_spend_usd
        FROM ai_usage_records
        WHERE workspace_id = ${params.workspaceId}
          AND created_at >= ${params.periodStart}
          AND created_at < ${params.periodEnd}
      ) spend
      LEFT JOIN ai_budgets b ON b.workspace_id = ${params.workspaceId}
      LEFT JOIN ai_user_quotas q ON q.workspace_id = ${params.workspaceId} AND q.user_id = ${userId}
    `)
    const row = result.rows[0]
    return {
      monthlyBudgetUsd: parseFloat(row.monthly_budget_usd),
      operatorCeilingUsd: parseFloat(row.operator_ceiling_usd),
      workspaceAiDisabled: row.workspace_ai_disabled,
      operatorAiDisabled: row.operator_ai_disabled,
      workspaceSpendUsd: parseFloat(row.workspace_spend_usd),
      user:
        userId === null
          ? null
          : {
              aiDisabled: row.user_ai_disabled,
              monthlyQuotaUsd: parseNullableUsd(row.monthly_quota_usd),
              agentAllowanceUsd:
                parseNullableUsd(row.agent_allowance_usd) ?? parseNullableUsd(row.default_user_agent_allowance_usd),
              spendUsd: parseFloat(row.user_spend_usd),
              agentSpendUsd: parseFloat(row.user_agent_spend_usd),
            },
    }
  },

  async findUserQuota(db: Querier, workspaceId: string, userId: string): Promise<AIUserQuota | null> {
    const result = await db.query<AIUserQuotaRow>(sql`
      SELECT ${sql.raw(QUOTA_FIELDS)} FROM ai_user_quotas
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
    if (!result.rows[0]) return null
    return mapRowToQuota(result.rows[0])
  },

  async listUserQuotas(db: Querier, workspaceId: string): Promise<AIUserQuota[]> {
    const result = await db.query<AIUserQuotaRow>(sql`
      SELECT ${sql.raw(QUOTA_FIELDS)} FROM ai_user_quotas
      WHERE workspace_id = ${workspaceId}
      ORDER BY user_id
    `)
    return result.rows.map(mapRowToQuota)
  },

  async upsertUserQuota(db: Querier, params: UpsertAIUserQuotaParams): Promise<AIUserQuota> {
    const result = await db.query<AIUserQuotaRow>(sql`
      INSERT INTO ai_user_quotas (id, workspace_id, user_id, monthly_quota_usd)
      VALUES (${params.id}, ${params.workspaceId}, ${params.userId}, ${params.monthlyQuotaUsd})
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET
        monthly_quota_usd = EXCLUDED.monthly_quota_usd,
        updated_at = NOW()
      RETURNING ${sql.raw(QUOTA_FIELDS)}
    `)
    return mapRowToQuota(result.rows[0])
  },

  async deleteUserQuota(db: Querier, workspaceId: string, userId: string): Promise<boolean> {
    const result = await db.query(sql`
      DELETE FROM ai_user_quotas
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
    return result.rowCount !== null && result.rowCount > 0
  },

  async findAlert(
    db: Querier,
    workspaceId: string,
    alertType: string,
    periodStart: Date,
    userId?: string
  ): Promise<AIAlert | null> {
    const result = await db.query<AIAlertRow>(sql`
      SELECT ${sql.raw(ALERT_FIELDS)} FROM ai_alerts
      WHERE workspace_id = ${workspaceId}
        AND alert_type = ${alertType}
        AND period_start = ${periodStart}
        AND COALESCE(user_id, '') = COALESCE(${userId ?? null}, '')
    `)
    if (!result.rows[0]) return null
    return mapRowToAlert(result.rows[0])
  },

  async insertAlert(db: Querier, params: InsertAIAlertParams): Promise<AIAlert> {
    const result = await db.query<AIAlertRow>(sql`
      INSERT INTO ai_alerts (id, workspace_id, user_id, alert_type, threshold_percent, period_start)
      VALUES (
        ${params.id},
        ${params.workspaceId},
        ${params.userId ?? null},
        ${params.alertType},
        ${params.thresholdPercent},
        ${params.periodStart}
      )
      RETURNING ${sql.raw(ALERT_FIELDS)}
    `)
    return mapRowToAlert(result.rows[0])
  },

  async listAlerts(
    db: Querier,
    workspaceId: string,
    periodStart: Date,
    options?: { userId?: string }
  ): Promise<AIAlert[]> {
    if (options?.userId) {
      const result = await db.query<AIAlertRow>(sql`
        SELECT ${sql.raw(ALERT_FIELDS)} FROM ai_alerts
        WHERE workspace_id = ${workspaceId}
          AND period_start = ${periodStart}
          AND user_id = ${options.userId}
        ORDER BY created_at DESC
      `)
      return result.rows.map(mapRowToAlert)
    }

    const result = await db.query<AIAlertRow>(sql`
      SELECT ${sql.raw(ALERT_FIELDS)} FROM ai_alerts
      WHERE workspace_id = ${workspaceId}
        AND period_start = ${periodStart}
      ORDER BY created_at DESC
    `)
    return result.rows.map(mapRowToAlert)
  },
}
