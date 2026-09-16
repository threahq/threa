import {
  AI_SPENDING_COVERAGE,
  type AISpendingLimits,
  type AISpendingPolicy,
  type AISpendingPolicyInput,
} from "@threahq/types"
import { sql, type Querier } from "../../db"
import { compareUsd, usd } from "@threahq/agent-runtime"

interface PolicyRow {
  workspace_id: string
  version: number
  status: string
  agent_cutoff_usd: string | null
  enrichment_cutoff_usd: string | null
  core_cutoff_usd: string | null
  embedding_cutoff_usd: string | null
  operator_ceiling_usd: string | null
  coverage_profile: string | null
  emergency_latched: boolean
  status_changed_at: Date
  status_changed_by: string | null
  updated_by: string | null
}

const POLICY_FIELDS = `
  workspace_id, version, status,
  agent_cutoff_usd, enrichment_cutoff_usd, core_cutoff_usd, embedding_cutoff_usd,
  operator_ceiling_usd, coverage_profile, emergency_latched,
  status_changed_at, status_changed_by, updated_by
`

/** A stored policy that no valid write could have produced; readers fail closed on it. */
export class MalformedSpendPolicyError extends Error {
  readonly code = "MALFORMED_SPEND_POLICY" as const
  constructor(workspaceId: string, detail: string) {
    super(`Spending policy for ${workspaceId} is malformed: ${detail}`)
  }
}

/** Limits in the order they must not decrease: each stage cutoff, then the operator ceiling. */
export function orderedLimitValues(limits: AISpendingLimits): string[] {
  return [
    limits.agentCutoffUsd,
    limits.enrichmentCutoffUsd,
    limits.coreCutoffUsd,
    limits.embeddingCutoffUsd,
    limits.operatorCeilingUsd,
  ]
}

export function limitsAreOrdered(limits: AISpendingLimits): boolean {
  const values = orderedLimitValues(limits)
  return values.every((value, index) => index === 0 || compareUsd(values[index - 1]!, value) <= 0)
}

function mapLimits(row: PolicyRow): AISpendingLimits | null {
  const amounts = [
    row.agent_cutoff_usd,
    row.enrichment_cutoff_usd,
    row.core_cutoff_usd,
    row.embedding_cutoff_usd,
    row.operator_ceiling_usd,
  ]
  if (amounts.every((amount) => amount === null)) return null
  if (amounts.some((amount) => amount === null)) {
    throw new MalformedSpendPolicyError(row.workspace_id, "limits are partially set")
  }
  return {
    agentCutoffUsd: usd(row.agent_cutoff_usd!),
    enrichmentCutoffUsd: usd(row.enrichment_cutoff_usd!),
    coreCutoffUsd: usd(row.core_cutoff_usd!),
    embeddingCutoffUsd: usd(row.embedding_cutoff_usd!),
    operatorCeilingUsd: usd(row.operator_ceiling_usd!),
  }
}

function mapCoverage(row: PolicyRow): typeof AI_SPENDING_COVERAGE.profile | null {
  if (row.coverage_profile === null) return null
  if (row.coverage_profile !== AI_SPENDING_COVERAGE.profile) {
    throw new MalformedSpendPolicyError(row.workspace_id, `unknown coverage profile ${row.coverage_profile}`)
  }
  return row.coverage_profile
}

function mapRowToPolicy(row: PolicyRow): AISpendingPolicy {
  const state = {
    workspaceId: row.workspace_id,
    version: row.version,
    emergencyLatched: row.emergency_latched,
    statusChangedAt: row.status_changed_at,
    statusChangedBy: row.status_changed_by,
    updatedBy: row.updated_by,
  }
  const limits = mapLimits(row)
  const coverageProfile = mapCoverage(row)
  switch (row.status) {
    case "unprotected":
    case "disabled":
      return { ...state, status: row.status, limits, coverageProfile }
    case "enforced":
      if (!limits || !coverageProfile) {
        throw new MalformedSpendPolicyError(row.workspace_id, "enforced without limits and acknowledged coverage")
      }
      if (!limitsAreOrdered(limits)) {
        throw new MalformedSpendPolicyError(row.workspace_id, "enforced limits are out of order")
      }
      return { ...state, status: "enforced", limits, coverageProfile }
    default:
      throw new MalformedSpendPolicyError(row.workspace_id, `unknown status ${row.status}`)
  }
}

/** Limit columns an edit writes: all five when enforcing, untouched (kept for display) when disabling. */
function limitParams(input: AISpendingPolicyInput): (string | null)[] {
  if (input.status !== "enforced") return [null, null, null, null, null]
  return orderedLimitValues(input.limits)
}

export const SpendPolicyRepository = {
  async listUnprotectedWorkspaceIds(db: Querier, workspaceIds: string[]): Promise<string[]> {
    if (workspaceIds.length === 0) return []
    const result = await db.query<{ workspace_id: string }>(sql`
      SELECT workspace_id FROM ai_spending_policies
      WHERE workspace_id = ANY(${workspaceIds}::text[]) AND status = 'unprotected' AND NOT emergency_latched
    `)
    return result.rows.map((row) => row.workspace_id)
  },

  async findByWorkspace(db: Querier, workspaceId: string): Promise<AISpendingPolicy | null> {
    const result = await db.query<PolicyRow>(sql`
      SELECT ${sql.raw(POLICY_FIELDS)} FROM ai_spending_policies
      WHERE workspace_id = ${workspaceId}
    `)
    return result.rows[0] ? mapRowToPolicy(result.rows[0]) : null
  },

  /**
   * Records explicit `unprotected` for existing workspaces that have no policy.
   * Never touches an existing row, so a retry or backfill cannot reset a
   * protected policy or clear a latch. Returns how many rows were created.
   */
  async insertUnprotected(db: Querier, workspaceIds: string[]): Promise<number> {
    if (workspaceIds.length === 0) return 0
    const result = await db.query(sql`
      INSERT INTO ai_spending_policies (workspace_id, version, status)
      SELECT id, 1, 'unprotected' FROM workspaces WHERE id = ANY(${workspaceIds})
      ON CONFLICT (workspace_id) DO NOTHING
    `)
    return result.rowCount ?? 0
  },

  /** Workspace registry scan for the provisioning backfill; ordered for stable chunking. */
  async listWorkspaceIdsWithoutPolicy(db: Querier): Promise<string[]> {
    const result = await db.query<{ id: string }>(sql`
      SELECT w.id FROM workspaces w
      WHERE NOT EXISTS (SELECT 1 FROM ai_spending_policies p WHERE p.workspace_id = w.id)
      ORDER BY w.id
    `)
    return result.rows.map((row) => row.id)
  },

  /** Operator creation of a policy that was never provisioned; null when one already exists (INV-20). */
  async insert(db: Querier, input: AISpendingPolicyInput): Promise<AISpendingPolicy | null> {
    const [agent, enrichment, core, embedding, ceiling] = limitParams(input)
    const coverageProfile = input.status === "enforced" ? input.coverageProfile : null
    const result = await db.query<PolicyRow>(sql`
      INSERT INTO ai_spending_policies (
        workspace_id, version, status,
        agent_cutoff_usd, enrichment_cutoff_usd, core_cutoff_usd, embedding_cutoff_usd,
        operator_ceiling_usd, coverage_profile, status_changed_by, updated_by
      )
      VALUES (
        ${input.workspaceId}, 1, ${input.status},
        ${agent}, ${enrichment}, ${core}, ${embedding},
        ${ceiling}, ${coverageProfile}, ${input.operatorWorkosUserId}, ${input.operatorWorkosUserId}
      )
      ON CONFLICT (workspace_id) DO NOTHING
      RETURNING ${sql.raw(POLICY_FIELDS)}
    `)
    return result.rows[0] ? mapRowToPolicy(result.rows[0]) : null
  },

  /**
   * Version-guarded edit (INV-66); null when `expectedVersion` is stale.
   * Status metadata moves only when the status actually changes. Never touches
   * `emergency_latched`, so an ordinary edit cannot clear a latch.
   */
  async updateAtVersion(db: Querier, input: AISpendingPolicyInput): Promise<AISpendingPolicy | null> {
    const enforced = input.status === "enforced"
    const [agent, enrichment, core, embedding, ceiling] = limitParams(input)
    const coverageProfile = enforced ? input.coverageProfile : null
    const result = await db.query<PolicyRow>(sql`
      UPDATE ai_spending_policies SET
        agent_cutoff_usd = CASE WHEN ${enforced} THEN ${agent}::numeric ELSE agent_cutoff_usd END,
        enrichment_cutoff_usd = CASE WHEN ${enforced} THEN ${enrichment}::numeric ELSE enrichment_cutoff_usd END,
        core_cutoff_usd = CASE WHEN ${enforced} THEN ${core}::numeric ELSE core_cutoff_usd END,
        embedding_cutoff_usd = CASE WHEN ${enforced} THEN ${embedding}::numeric ELSE embedding_cutoff_usd END,
        operator_ceiling_usd = CASE WHEN ${enforced} THEN ${ceiling}::numeric ELSE operator_ceiling_usd END,
        coverage_profile = CASE WHEN ${enforced} THEN ${coverageProfile} ELSE coverage_profile END,
        status_changed_at = CASE WHEN status <> ${input.status} THEN NOW() ELSE status_changed_at END,
        status_changed_by = CASE WHEN status <> ${input.status} THEN ${input.operatorWorkosUserId} ELSE status_changed_by END,
        status = ${input.status},
        updated_by = ${input.operatorWorkosUserId},
        version = version + 1,
        updated_at = NOW()
      WHERE workspace_id = ${input.workspaceId} AND version = ${input.expectedVersion}
      RETURNING ${sql.raw(POLICY_FIELDS)}
    `)
    return result.rows[0] ? mapRowToPolicy(result.rows[0]) : null
  },

  async latchEmergency(db: Querier, workspaceId: string): Promise<void> {
    await db.query(sql`
      UPDATE ai_spending_policies
      SET emergency_latched = TRUE, version = version + 1, updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND emergency_latched = FALSE
    `)
  },
}
