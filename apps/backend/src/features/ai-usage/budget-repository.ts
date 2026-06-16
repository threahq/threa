import { sql, type Querier } from "../../db"

interface AIBudgetRow {
  id: string
  workspace_id: string
  monthly_budget_usd: string // NUMERIC comes as string from pg
  alert_threshold_50: boolean
  alert_threshold_80: boolean
  alert_threshold_100: boolean
  degradation_enabled: boolean
  hard_limit_enabled: boolean
  hard_limit_percent: number
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
  degradationEnabled: boolean
  hardLimitEnabled: boolean
  hardLimitPercent: number
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
  degradationEnabled?: boolean
  hardLimitEnabled?: boolean
  hardLimitPercent?: number
}

export interface UpdateAIBudgetParams {
  monthlyBudgetUsd?: number
  alertThreshold50?: boolean
  alertThreshold80?: boolean
  alertThreshold100?: boolean
  degradationEnabled?: boolean
  hardLimitEnabled?: boolean
  hardLimitPercent?: number
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

function mapRowToBudget(row: AIBudgetRow): AIBudget {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    monthlyBudgetUsd: parseFloat(row.monthly_budget_usd),
    alertThreshold50: row.alert_threshold_50,
    alertThreshold80: row.alert_threshold_80,
    alertThreshold100: row.alert_threshold_100,
    degradationEnabled: row.degradation_enabled,
    hardLimitEnabled: row.hard_limit_enabled,
    hardLimitPercent: row.hard_limit_percent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapRowToQuota(row: AIUserQuotaRow): AIUserQuota {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    monthlyQuotaUsd: row.monthly_quota_usd ? parseFloat(row.monthly_quota_usd) : null,
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
  degradation_enabled, hard_limit_enabled, hard_limit_percent,
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

  async upsert(db: Querier, params: UpsertAIBudgetParams): Promise<AIBudget> {
    const result = await db.query<AIBudgetRow>(sql`
      INSERT INTO ai_budgets (
        id, workspace_id, monthly_budget_usd,
        alert_threshold_50, alert_threshold_80, alert_threshold_100,
        degradation_enabled, hard_limit_enabled, hard_limit_percent
      )
      VALUES (
        ${params.id},
        ${params.workspaceId},
        ${params.monthlyBudgetUsd ?? 50.0},
        ${params.alertThreshold50 ?? true},
        ${params.alertThreshold80 ?? true},
        ${params.alertThreshold100 ?? true},
        ${params.degradationEnabled ?? true},
        ${params.hardLimitEnabled ?? false},
        ${params.hardLimitPercent ?? 150}
      )
      ON CONFLICT (workspace_id) DO UPDATE SET
        monthly_budget_usd = EXCLUDED.monthly_budget_usd,
        alert_threshold_50 = EXCLUDED.alert_threshold_50,
        alert_threshold_80 = EXCLUDED.alert_threshold_80,
        alert_threshold_100 = EXCLUDED.alert_threshold_100,
        degradation_enabled = EXCLUDED.degradation_enabled,
        hard_limit_enabled = EXCLUDED.hard_limit_enabled,
        hard_limit_percent = EXCLUDED.hard_limit_percent,
        updated_at = NOW()
      RETURNING ${sql.raw(BUDGET_FIELDS)}
    `)
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
    const degradationEnabled = params.degradationEnabled ?? null
    const hardLimitEnabled = params.hardLimitEnabled ?? null
    const hardLimitPercent = params.hardLimitPercent ?? null

    const result = await db.query<AIBudgetRow>(sql`
      INSERT INTO ai_budgets (
        id, workspace_id, monthly_budget_usd,
        alert_threshold_50, alert_threshold_80, alert_threshold_100,
        degradation_enabled, hard_limit_enabled, hard_limit_percent
      )
      VALUES (
        ${params.id},
        ${params.workspaceId},
        COALESCE(${monthlyBudgetUsd}, 50.0),
        COALESCE(${alertThreshold50}, true),
        COALESCE(${alertThreshold80}, true),
        COALESCE(${alertThreshold100}, true),
        COALESCE(${degradationEnabled}, true),
        COALESCE(${hardLimitEnabled}, false),
        COALESCE(${hardLimitPercent}, 150)
      )
      ON CONFLICT (workspace_id) DO UPDATE SET
        monthly_budget_usd = COALESCE(${monthlyBudgetUsd}, ai_budgets.monthly_budget_usd),
        alert_threshold_50 = COALESCE(${alertThreshold50}, ai_budgets.alert_threshold_50),
        alert_threshold_80 = COALESCE(${alertThreshold80}, ai_budgets.alert_threshold_80),
        alert_threshold_100 = COALESCE(${alertThreshold100}, ai_budgets.alert_threshold_100),
        degradation_enabled = COALESCE(${degradationEnabled}, ai_budgets.degradation_enabled),
        hard_limit_enabled = COALESCE(${hardLimitEnabled}, ai_budgets.hard_limit_enabled),
        hard_limit_percent = COALESCE(${hardLimitPercent}, ai_budgets.hard_limit_percent),
        updated_at = NOW()
      RETURNING ${sql.raw(BUDGET_FIELDS)}
    `)
    return mapRowToBudget(result.rows[0])
  },

  async update(db: Querier, workspaceId: string, params: UpdateAIBudgetParams): Promise<AIBudget | null> {
    const updates: string[] = []
    const values: unknown[] = []
    let paramIndex = 1

    if (params.monthlyBudgetUsd !== undefined) {
      updates.push(`monthly_budget_usd = $${paramIndex++}`)
      values.push(params.monthlyBudgetUsd)
    }
    if (params.alertThreshold50 !== undefined) {
      updates.push(`alert_threshold_50 = $${paramIndex++}`)
      values.push(params.alertThreshold50)
    }
    if (params.alertThreshold80 !== undefined) {
      updates.push(`alert_threshold_80 = $${paramIndex++}`)
      values.push(params.alertThreshold80)
    }
    if (params.alertThreshold100 !== undefined) {
      updates.push(`alert_threshold_100 = $${paramIndex++}`)
      values.push(params.alertThreshold100)
    }
    if (params.degradationEnabled !== undefined) {
      updates.push(`degradation_enabled = $${paramIndex++}`)
      values.push(params.degradationEnabled)
    }
    if (params.hardLimitEnabled !== undefined) {
      updates.push(`hard_limit_enabled = $${paramIndex++}`)
      values.push(params.hardLimitEnabled)
    }
    if (params.hardLimitPercent !== undefined) {
      updates.push(`hard_limit_percent = $${paramIndex++}`)
      values.push(params.hardLimitPercent)
    }

    if (updates.length === 0) {
      return this.findByWorkspace(db, workspaceId)
    }

    updates.push(`updated_at = NOW()`)
    values.push(workspaceId)

    const query = `
      UPDATE ai_budgets
      SET ${updates.join(", ")}
      WHERE workspace_id = $${paramIndex}
      RETURNING ${BUDGET_FIELDS}
    `

    const result = await db.query<AIBudgetRow>(query, values)
    if (!result.rows[0]) return null
    return mapRowToBudget(result.rows[0])
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
