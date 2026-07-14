import { sql, type Querier } from "../../db"

export type AIUsageOrigin = "system" | "user"

interface AIUsageRecordRow {
  id: string
  workspace_id: string
  user_id: string | null
  session_id: string | null
  function_id: string
  model: string
  provider: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cost_usd: string // NUMERIC comes as string from pg
  origin: AIUsageOrigin
  metadata: Record<string, unknown> | null
  created_at: Date
}

export interface AIUsageRecord {
  id: string
  workspaceId: string
  userId: string | null
  sessionId: string | null
  functionId: string
  model: string
  provider: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costUsd: number
  origin: AIUsageOrigin
  metadata: Record<string, unknown> | null
  createdAt: Date
}

export interface InsertAIUsageRecordParams {
  id: string
  workspaceId: string
  userId?: string
  sessionId?: string
  functionId: string
  model: string
  provider: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costUsd: number
  origin: AIUsageOrigin
  metadata?: Record<string, unknown>
}

export interface UsageSummary {
  totalCostUsd: number
  totalTokens: number
  promptTokens: number
  completionTokens: number
  recordCount: number
}

export interface ModelBreakdown {
  model: string
  totalCostUsd: number
  totalTokens: number
  recordCount: number
}

export interface FunctionBreakdown {
  functionId: string
  totalCostUsd: number
  totalTokens: number
  recordCount: number
}

export interface DayFunctionBreakdown {
  date: string
  functionId: string
  totalCostUsd: number
  totalTokens: number
  recordCount: number
}

export interface UserBreakdown {
  userId: string | null
  totalCostUsd: number
  totalTokens: number
  recordCount: number
}

export interface OriginBreakdown {
  origin: AIUsageOrigin
  totalCostUsd: number
  totalTokens: number
  recordCount: number
}

function mapRowToRecord(row: AIUsageRecordRow): AIUsageRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    sessionId: row.session_id,
    functionId: row.function_id,
    model: row.model,
    provider: row.provider,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    costUsd: parseFloat(row.cost_usd),
    origin: row.origin,
    metadata: row.metadata,
    createdAt: row.created_at,
  }
}

const SELECT_FIELDS = `
  id, workspace_id, user_id, session_id, function_id,
  model, provider, prompt_tokens, completion_tokens,
  total_tokens, cost_usd, origin, metadata, created_at
`

export const AIUsageRepository = {
  async insert(db: Querier, params: InsertAIUsageRecordParams): Promise<AIUsageRecord> {
    const result = await db.query<AIUsageRecordRow>(sql`
      INSERT INTO ai_usage_records (
        id, workspace_id, user_id, session_id, function_id,
        model, provider, prompt_tokens, completion_tokens,
        total_tokens, cost_usd, origin, metadata
      )
      VALUES (
        ${params.id},
        ${params.workspaceId},
        ${params.userId ?? null},
        ${params.sessionId ?? null},
        ${params.functionId},
        ${params.model},
        ${params.provider},
        ${params.promptTokens},
        ${params.completionTokens},
        ${params.totalTokens},
        ${params.costUsd},
        ${params.origin},
        ${params.metadata ? JSON.stringify(params.metadata) : null}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRowToRecord(result.rows[0])
  },

  async findById(db: Querier, id: string): Promise<AIUsageRecord | null> {
    const result = await db.query<AIUsageRecordRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM ai_usage_records
      WHERE id = ${id}
    `)
    if (!result.rows[0]) return null
    return mapRowToRecord(result.rows[0])
  },

  async getWorkspaceUsage(db: Querier, workspaceId: string, periodStart: Date, periodEnd: Date): Promise<UsageSummary> {
    const result = await db.query<{
      total_cost_usd: string | null
      total_tokens: string | null
      prompt_tokens: string | null
      completion_tokens: string | null
      record_count: string
    }>(sql`
      SELECT
        COALESCE(SUM(cost_usd), 0) as total_cost_usd,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) as completion_tokens,
        COUNT(*) as record_count
      FROM ai_usage_records
      WHERE workspace_id = ${workspaceId}
        AND created_at >= ${periodStart}
        AND created_at < ${periodEnd}
    `)

    const row = result.rows[0]
    return {
      totalCostUsd: parseFloat(row.total_cost_usd ?? "0"),
      totalTokens: parseInt(row.total_tokens ?? "0", 10),
      promptTokens: parseInt(row.prompt_tokens ?? "0", 10),
      completionTokens: parseInt(row.completion_tokens ?? "0", 10),
      recordCount: parseInt(row.record_count, 10),
    }
  },

  async getUserUsage(
    db: Querier,
    workspaceId: string,
    userId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<UsageSummary> {
    const result = await db.query<{
      total_cost_usd: string | null
      total_tokens: string | null
      prompt_tokens: string | null
      completion_tokens: string | null
      record_count: string
    }>(sql`
      SELECT
        COALESCE(SUM(cost_usd), 0) as total_cost_usd,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) as completion_tokens,
        COUNT(*) as record_count
      FROM ai_usage_records
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND created_at >= ${periodStart}
        AND created_at < ${periodEnd}
    `)

    const row = result.rows[0]
    return {
      totalCostUsd: parseFloat(row.total_cost_usd ?? "0"),
      totalTokens: parseInt(row.total_tokens ?? "0", 10),
      promptTokens: parseInt(row.prompt_tokens ?? "0", 10),
      completionTokens: parseInt(row.completion_tokens ?? "0", 10),
      recordCount: parseInt(row.record_count, 10),
    }
  },

  async getUsageByModel(
    db: Querier,
    workspaceId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<ModelBreakdown[]> {
    const result = await db.query<{
      model: string
      total_cost_usd: string
      total_tokens: string
      record_count: string
    }>(sql`
      SELECT
        model,
        SUM(cost_usd) as total_cost_usd,
        SUM(total_tokens) as total_tokens,
        COUNT(*) as record_count
      FROM ai_usage_records
      WHERE workspace_id = ${workspaceId}
        AND created_at >= ${periodStart}
        AND created_at < ${periodEnd}
      GROUP BY model
      ORDER BY total_cost_usd DESC
    `)

    return result.rows.map((row) => ({
      model: row.model,
      totalCostUsd: parseFloat(row.total_cost_usd),
      totalTokens: parseInt(row.total_tokens, 10),
      recordCount: parseInt(row.record_count, 10),
    }))
  },

  async getUsageByFunction(
    db: Querier,
    workspaceId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<FunctionBreakdown[]> {
    const result = await db.query<{
      function_id: string
      total_cost_usd: string
      total_tokens: string
      record_count: string
    }>(sql`
      SELECT
        function_id,
        SUM(cost_usd) as total_cost_usd,
        SUM(total_tokens) as total_tokens,
        COUNT(*) as record_count
      FROM ai_usage_records
      WHERE workspace_id = ${workspaceId}
        AND created_at >= ${periodStart}
        AND created_at < ${periodEnd}
      GROUP BY function_id
      ORDER BY total_cost_usd DESC
    `)

    return result.rows.map((row) => ({
      functionId: row.function_id,
      totalCostUsd: parseFloat(row.total_cost_usd),
      totalTokens: parseInt(row.total_tokens, 10),
      recordCount: parseInt(row.record_count, 10),
    }))
  },

  async getUsageByDay(
    db: Querier,
    workspaceId: string,
    periodStart: Date,
    periodEnd: Date,
    timezone: string
  ): Promise<DayFunctionBreakdown[]> {
    const result = await db.query<{
      date: string
      function_id: string
      total_cost_usd: string
      total_tokens: string
      record_count: string
    }>(sql`
      SELECT
        to_char(created_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') as date,
        function_id,
        SUM(cost_usd) as total_cost_usd,
        SUM(total_tokens) as total_tokens,
        COUNT(*) as record_count
      FROM ai_usage_records
      WHERE workspace_id = ${workspaceId}
        AND created_at >= ${periodStart}
        AND created_at < ${periodEnd}
      GROUP BY date, function_id
      ORDER BY date ASC
    `)

    return result.rows.map((row) => ({
      date: row.date,
      functionId: row.function_id,
      totalCostUsd: parseFloat(row.total_cost_usd),
      totalTokens: parseInt(row.total_tokens, 10),
      recordCount: parseInt(row.record_count, 10),
    }))
  },

  async getUsageByUser(db: Querier, workspaceId: string, periodStart: Date, periodEnd: Date): Promise<UserBreakdown[]> {
    const result = await db.query<{
      user_id: string | null
      total_cost_usd: string
      total_tokens: string
      record_count: string
    }>(sql`
      SELECT
        user_id,
        SUM(cost_usd) as total_cost_usd,
        SUM(total_tokens) as total_tokens,
        COUNT(*) as record_count
      FROM ai_usage_records
      WHERE workspace_id = ${workspaceId}
        AND created_at >= ${periodStart}
        AND created_at < ${periodEnd}
      GROUP BY user_id
      ORDER BY total_cost_usd DESC
    `)

    return result.rows.map((row) => ({
      userId: row.user_id,
      totalCostUsd: parseFloat(row.total_cost_usd),
      totalTokens: parseInt(row.total_tokens, 10),
      recordCount: parseInt(row.record_count, 10),
    }))
  },

  async listRecent(
    db: Querier,
    workspaceId: string,
    options?: { limit?: number; userId?: string }
  ): Promise<AIUsageRecord[]> {
    const limit = options?.limit ?? 50
    const conditions: string[] = [`workspace_id = $1`]
    const values: unknown[] = [workspaceId]
    let paramIndex = 2

    if (options?.userId) {
      conditions.push(`user_id = $${paramIndex++}`)
      values.push(options.userId)
    }

    values.push(limit)

    const query = `
      SELECT ${SELECT_FIELDS} FROM ai_usage_records
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${paramIndex}
    `

    const result = await db.query<AIUsageRecordRow>(query, values)
    return result.rows.map(mapRowToRecord)
  },

  async getUsageByOrigin(
    db: Querier,
    workspaceId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<OriginBreakdown[]> {
    const result = await db.query<{
      origin: AIUsageOrigin
      total_cost_usd: string
      total_tokens: string
      record_count: string
    }>(sql`
      SELECT
        origin,
        SUM(cost_usd) as total_cost_usd,
        SUM(total_tokens) as total_tokens,
        COUNT(*) as record_count
      FROM ai_usage_records
      WHERE workspace_id = ${workspaceId}
        AND created_at >= ${periodStart}
        AND created_at < ${periodEnd}
      GROUP BY origin
      ORDER BY total_cost_usd DESC
    `)

    return result.rows.map((row) => ({
      origin: row.origin,
      totalCostUsd: parseFloat(row.total_cost_usd),
      totalTokens: parseInt(row.total_tokens, 10),
      recordCount: parseInt(row.record_count, 10),
    }))
  },
}
