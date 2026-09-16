import type {
  AISpendingAttempt,
  AISpendingAttemptRequest,
  AISpendingAttemptState,
  AISpendingPeriod,
  AISpendingReceipt,
  AISpendingStage,
} from "@threahq/types"
import { sql, type Querier } from "../../db"
import { usd } from "@threahq/agent-runtime"

interface PeriodRow {
  id: string
  workspace_id: string
  starts_at: Date
  ends_at: Date
  timezone: string
  settled_usd: string
  committed_usd: string
}

interface AttemptRow {
  id: string
  workspace_id: string
  idempotency_key: string
  period_id: string
  sponsor_user_id: string
  session_id: string | null
  operation_id: string
  purpose: string
  stage: AISpendingStage
  model: string
  provider_route: string
  provider: string
  function_id: string
  max_cost_usd: string
  state: AISpendingAttemptState
  actual_cost_usd: string | null
  receipt: AISpendingReceipt | null
}

interface AccountedAttemptRow extends AttemptRow {
  accounted_period_id: string | null
}

/**
 * A data-modifying CTE runs even when the sibling period UPDATE matched no
 * row, so an attempt transition with no period accounting must abort the
 * transaction rather than return a half-applied row.
 */
function accountedAttempt(row: AccountedAttemptRow | undefined): AISpendingAttempt | null {
  if (!row) return null
  if (row.accounted_period_id === null) {
    throw new Error(`Spend period ${row.period_id} missing for attempt ${row.id} in workspace ${row.workspace_id}`)
  }
  return mapRowToAttempt(row)
}

const PERIOD_FIELDS = `id, workspace_id, starts_at, ends_at, timezone, settled_usd, committed_usd`
const ATTEMPT_FIELDS = `
  id, workspace_id, idempotency_key, period_id, sponsor_user_id, session_id, operation_id,
  purpose, stage, model, provider_route, provider, function_id, max_cost_usd, state, actual_cost_usd, receipt
`

function mapRowToPeriod(row: PeriodRow): AISpendingPeriod {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    settledUsd: usd(row.settled_usd),
    committedUsd: usd(row.committed_usd),
  }
}

function mapRowToAttempt(row: AttemptRow): AISpendingAttempt {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    idempotencyKey: row.idempotency_key,
    periodId: row.period_id,
    sponsorUserId: row.sponsor_user_id,
    sessionId: row.session_id,
    operationId: row.operation_id,
    purpose: row.purpose,
    stage: row.stage,
    model: row.model,
    providerRoute: row.provider_route,
    provider: row.provider,
    functionId: row.function_id,
    maxCostUsd: usd(row.max_cost_usd),
    state: row.state,
    actualCostUsd: row.actual_cost_usd === null ? null : usd(row.actual_cost_usd),
    receipt: row.receipt,
  }
}

export interface InsertPeriodParams {
  id: string
  workspaceId: string
  startsAt: Date
  endsAt: Date
  timezone: string
}

export interface InsertAttemptParams extends AISpendingAttemptRequest {
  id: string
  periodId: string
  createdAt: Date
}

export interface SettleAttemptParams {
  workspaceId: string
  attemptId: string
  actualCostUsd: string
  receipt: AISpendingReceipt
}

export class SpendWorkspaceNotFoundError extends Error {
  readonly code = "WORKSPACE_NOT_FOUND" as const
  constructor(workspaceId: string) {
    super(`Spending workspace ${workspaceId} does not exist`)
  }
}

/**
 * Pure data access for periods and attempts. Every mutation here assumes the
 * caller holds the workspace anchor lock (`lockWorkspace`), which is what
 * makes the period totals and the admission check consistent.
 */
export const SpendRepository = {
  async lockWorkspaces(db: Querier, workspaceIds: string[]): Promise<void> {
    await db.query(sql`SELECT id FROM workspaces WHERE id = ANY(${workspaceIds}::text[]) ORDER BY id FOR UPDATE`)
  },

  /** The canonical workspace anchor that serializes admission, settlement, edits and period creation. */
  async lockWorkspace(db: Querier, workspaceId: string): Promise<void> {
    const result = await db.query(sql`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`)
    if (result.rowCount !== 1) throw new SpendWorkspaceNotFoundError(workspaceId)
  },

  async workspaceExists(db: Querier, workspaceId: string): Promise<boolean> {
    const result = await db.query(sql`SELECT 1 FROM workspaces WHERE id = ${workspaceId}`)
    return result.rowCount === 1
  },

  async findPeriodById(db: Querier, workspaceId: string, periodId: string): Promise<AISpendingPeriod | null> {
    const result = await db.query<PeriodRow>(sql`
      SELECT ${sql.raw(PERIOD_FIELDS)} FROM ai_spending_periods
      WHERE workspace_id = ${workspaceId} AND id = ${periodId}
    `)
    return result.rows[0] ? mapRowToPeriod(result.rows[0]) : null
  },

  async findPeriodAt(db: Querier, workspaceId: string, at: Date): Promise<AISpendingPeriod | null> {
    const result = await db.query<PeriodRow>(sql`
      SELECT ${sql.raw(PERIOD_FIELDS)} FROM ai_spending_periods
      WHERE workspace_id = ${workspaceId} AND starts_at <= ${at} AND ends_at > ${at}
    `)
    return result.rows[0] ? mapRowToPeriod(result.rows[0]) : null
  },

  async findLatestPeriod(db: Querier, workspaceId: string): Promise<AISpendingPeriod | null> {
    const result = await db.query<PeriodRow>(sql`
      SELECT ${sql.raw(PERIOD_FIELDS)} FROM ai_spending_periods
      WHERE workspace_id = ${workspaceId}
      ORDER BY ends_at DESC
      LIMIT 1
    `)
    return result.rows[0] ? mapRowToPeriod(result.rows[0]) : null
  },

  async listPeriods(db: Querier, workspaceId: string): Promise<AISpendingPeriod[]> {
    const result = await db.query<PeriodRow>(sql`
      SELECT ${sql.raw(PERIOD_FIELDS)} FROM ai_spending_periods
      WHERE workspace_id = ${workspaceId}
      ORDER BY starts_at ASC
    `)
    return result.rows.map(mapRowToPeriod)
  },

  async insertPeriod(db: Querier, params: InsertPeriodParams): Promise<AISpendingPeriod> {
    const result = await db.query<PeriodRow>(sql`
      INSERT INTO ai_spending_periods (id, workspace_id, starts_at, ends_at, timezone)
      VALUES (${params.id}, ${params.workspaceId}, ${params.startsAt}, ${params.endsAt}, ${params.timezone})
      RETURNING ${sql.raw(PERIOD_FIELDS)}
    `)
    return mapRowToPeriod(result.rows[0]!)
  },

  async findAttemptById(db: Querier, workspaceId: string, attemptId: string): Promise<AISpendingAttempt | null> {
    const result = await db.query<AttemptRow>(sql`
      SELECT ${sql.raw(ATTEMPT_FIELDS)} FROM ai_spending_attempts
      WHERE workspace_id = ${workspaceId} AND id = ${attemptId}
    `)
    return result.rows[0] ? mapRowToAttempt(result.rows[0]) : null
  },

  async findAttemptByKey(db: Querier, workspaceId: string, idempotencyKey: string): Promise<AISpendingAttempt | null> {
    const result = await db.query<AttemptRow>(sql`
      SELECT ${sql.raw(ATTEMPT_FIELDS)} FROM ai_spending_attempts
      WHERE workspace_id = ${workspaceId} AND idempotency_key = ${idempotencyKey}
    `)
    return result.rows[0] ? mapRowToAttempt(result.rows[0]) : null
  },

  /** Inserts the reservation and adds its bound to the period's outstanding commitments, together. */
  async insertReservation(db: Querier, params: InsertAttemptParams): Promise<AISpendingAttempt> {
    const result = await db.query<AttemptRow>(sql`
      WITH committed AS (
        UPDATE ai_spending_periods
        SET committed_usd = committed_usd + ${params.maxCostUsd}::numeric
        WHERE workspace_id = ${params.workspaceId} AND id = ${params.periodId}
        RETURNING id
      )
      INSERT INTO ai_spending_attempts (
        id, workspace_id, idempotency_key, period_id, sponsor_user_id, session_id, operation_id,
        purpose, stage, model, provider_route, provider, function_id, max_cost_usd, state, created_at
      )
      SELECT
        ${params.id}, ${params.workspaceId}, ${params.idempotencyKey}, committed.id, ${params.sponsorUserId},
        ${params.sessionId}, ${params.operationId}, ${params.purpose}, ${params.stage}, ${params.model},
        ${params.providerRoute}, ${params.provider}, ${params.functionId}, ${params.maxCostUsd}::numeric, 'reserved', ${params.createdAt}
      FROM committed
      RETURNING ${sql.raw(ATTEMPT_FIELDS)}
    `)
    const row = result.rows[0]
    if (!row) throw new Error(`Spend period ${params.periodId} missing for workspace ${params.workspaceId}`)
    return mapRowToAttempt(row)
  },

  /** Single-winner CAS on `state`; null when the attempt is not in `from`. */
  async transition(
    db: Querier,
    workspaceId: string,
    attemptId: string,
    from: AISpendingAttemptState,
    to: AISpendingAttemptState
  ): Promise<AISpendingAttempt | null> {
    const result = await db.query<AttemptRow>(sql`
      UPDATE ai_spending_attempts
      SET state = ${to},
          dispatched_at = CASE WHEN ${to} = 'dispatched' THEN NOW() ELSE dispatched_at END,
          updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND id = ${attemptId} AND state = ${from}
      RETURNING ${sql.raw(ATTEMPT_FIELDS)}
    `)
    return result.rows[0] ? mapRowToAttempt(result.rows[0]) : null
  },

  async markUnknown(
    db: Querier,
    workspaceId: string,
    attemptId: string,
    receipt?: AISpendingReceipt
  ): Promise<boolean> {
    const result = await db.query(sql`
      UPDATE ai_spending_attempts
      SET state = 'unknown', receipt = COALESCE(receipt, ${receipt ? JSON.stringify(receipt) : null}::jsonb), updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND id = ${attemptId}
        AND (state = 'dispatched' OR (state = 'unknown' AND receipt IS NULL AND ${receipt !== undefined}))
    `)
    return result.rowCount === 1
  },

  /** Releases a never-dispatched reservation and returns its bound to the period; null unless it was `reserved`. */
  async releaseReservation(db: Querier, workspaceId: string, attemptId: string): Promise<AISpendingAttempt | null> {
    const result = await db.query<AccountedAttemptRow>(sql`
      WITH released AS (
        UPDATE ai_spending_attempts
        SET state = 'released', updated_at = NOW()
        WHERE workspace_id = ${workspaceId} AND id = ${attemptId} AND state = 'reserved'
        RETURNING ${sql.raw(ATTEMPT_FIELDS)}
      ),
      uncommitted AS (
        UPDATE ai_spending_periods p
        SET committed_usd = p.committed_usd - released.max_cost_usd
        FROM released
        WHERE p.workspace_id = released.workspace_id AND p.id = released.period_id
        RETURNING p.id
      )
      SELECT released.*, uncommitted.id AS accounted_period_id
      FROM released LEFT JOIN uncommitted ON uncommitted.id = released.period_id
    `)
    return accountedAttempt(result.rows[0])
  },

  /**
   * Settles a dispatched/unknown attempt at its exact vendor cost: the period's
   * settled total takes the full actual charge, and only the pinned row's own
   * bound leaves the outstanding commitments. Null unless it was settleable.
   */
  async settleAttempt(db: Querier, params: SettleAttemptParams): Promise<AISpendingAttempt | null> {
    const result = await db.query<AccountedAttemptRow>(sql`
      WITH settled AS (
        UPDATE ai_spending_attempts
        SET state = 'settled',
            actual_cost_usd = ${params.actualCostUsd}::numeric,
            receipt = ${JSON.stringify(params.receipt)}::jsonb,
            settled_at = NOW(),
            updated_at = NOW()
        WHERE workspace_id = ${params.workspaceId} AND id = ${params.attemptId}
          AND state IN ('dispatched', 'unknown')
        RETURNING ${sql.raw(ATTEMPT_FIELDS)}
      ),
      accounted AS (
        UPDATE ai_spending_periods p
        SET settled_usd = p.settled_usd + settled.actual_cost_usd,
            committed_usd = p.committed_usd - settled.max_cost_usd
        FROM settled
        WHERE p.workspace_id = settled.workspace_id AND p.id = settled.period_id
        RETURNING p.id
      )
      SELECT settled.*, accounted.id AS accounted_period_id
      FROM settled LEFT JOIN accounted ON accounted.id = settled.period_id
    `)
    return accountedAttempt(result.rows[0])
  },
}
