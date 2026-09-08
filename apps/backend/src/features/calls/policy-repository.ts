import type { CallMediaTransport, CallTransportPolicyReason } from "@threahq/types"
import type { Querier } from "../../db"
import { sql } from "../../db"

export interface CallTransportPolicyState {
  id: string
  workspaceId: string
  callId: string
  admittedCount: number
  desiredTransport: CallMediaTransport
  eligibilityDeadline: Date | null
  eligibilityGeneration: number
  sourceTransportGeneration: number
  explicitHoldTarget: CallMediaTransport | null
  explicitHoldAdmittedCount: number | null
  latestReason: CallTransportPolicyReason
  version: number
}

const COLUMNS = `id, workspace_id, call_id, admitted_count, desired_transport, eligibility_deadline,
  eligibility_generation, source_transport_generation, explicit_hold_target, explicit_hold_admitted_count,
  latest_reason, version`

function map(row: Record<string, any>): CallTransportPolicyState {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    callId: row.call_id,
    admittedCount: row.admitted_count,
    desiredTransport: row.desired_transport,
    eligibilityDeadline: row.eligibility_deadline,
    eligibilityGeneration: row.eligibility_generation,
    sourceTransportGeneration: row.source_transport_generation,
    explicitHoldTarget: row.explicit_hold_target,
    explicitHoldAdmittedCount: row.explicit_hold_admitted_count,
    latestReason: row.latest_reason,
    version: row.version,
  }
}

export const CallTransportPolicyRepository = {
  async find(db: Querier, workspaceId: string, callId: string): Promise<CallTransportPolicyState | null> {
    const result = await db.query(sql`SELECT ${sql.raw(COLUMNS)} FROM call_transport_policy_states
      WHERE workspace_id = ${workspaceId} AND call_id = ${callId}`)
    return result.rows[0] ? map(result.rows[0]) : null
  },

  async findForUpdate(db: Querier, workspaceId: string, callId: string): Promise<CallTransportPolicyState | null> {
    const result = await db.query(sql`SELECT ${sql.raw(COLUMNS)} FROM call_transport_policy_states
      WHERE workspace_id = ${workspaceId} AND call_id = ${callId} FOR UPDATE`)
    return result.rows[0] ? map(result.rows[0]) : null
  },

  async insert(db: Querier, state: Omit<CallTransportPolicyState, "version">): Promise<CallTransportPolicyState> {
    const result = await db.query(sql`INSERT INTO call_transport_policy_states
      (id, workspace_id, call_id, admitted_count, desired_transport, eligibility_deadline,
       eligibility_generation, source_transport_generation, explicit_hold_target, explicit_hold_admitted_count,
       latest_reason)
      VALUES (${state.id}, ${state.workspaceId}, ${state.callId}, ${state.admittedCount}, ${state.desiredTransport},
       ${state.eligibilityDeadline}, ${state.eligibilityGeneration}, ${state.sourceTransportGeneration},
       ${state.explicitHoldTarget}, ${state.explicitHoldAdmittedCount}, ${state.latestReason})
      ON CONFLICT (workspace_id, call_id) DO UPDATE SET updated_at = call_transport_policy_states.updated_at
      RETURNING ${sql.raw(COLUMNS)}`)
    return map(result.rows[0])
  },

  async update(db: Querier, state: CallTransportPolicyState): Promise<CallTransportPolicyState | null> {
    const result = await db.query(sql`UPDATE call_transport_policy_states SET admitted_count = ${state.admittedCount},
      desired_transport = ${state.desiredTransport}, eligibility_deadline = ${state.eligibilityDeadline},
      eligibility_generation = ${state.eligibilityGeneration},
      source_transport_generation = ${state.sourceTransportGeneration}, explicit_hold_target = ${state.explicitHoldTarget},
      explicit_hold_admitted_count = ${state.explicitHoldAdmittedCount}, latest_reason = ${state.latestReason},
      version = version + 1, updated_at = NOW()
      WHERE workspace_id = ${state.workspaceId} AND call_id = ${state.callId} AND version = ${state.version}
      RETURNING ${sql.raw(COLUMNS)}`)
    return result.rows[0] ? map(result.rows[0]) : null
  },

  async listDue(db: Querier, now: Date): Promise<CallTransportPolicyState[]> {
    const result = await db.query(sql`SELECT ${sql.raw(COLUMNS)} FROM call_transport_policy_states
      WHERE eligibility_deadline IS NOT NULL AND eligibility_deadline <= ${now} ORDER BY call_id`)
    return result.rows.map(map)
  },

  async listPeriodicCandidates(db: Querier): Promise<Array<{ workspaceId: string; callId: string }>> {
    const result = await db.query<{ workspace_id: string; call_id: string }>(sql`
      SELECT c.workspace_id, c.id AS call_id
      FROM calls c
      LEFT JOIN call_transport_policy_states p
        ON p.workspace_id = c.workspace_id AND p.call_id = c.id
      WHERE c.status IN ('active', 'empty_grace')
        AND (c.media_transport = 'p2p' OR p.id IS NULL OR p.eligibility_deadline IS NULL)
      ORDER BY c.id
    `)
    return result.rows.map((row) => ({ workspaceId: row.workspace_id, callId: row.call_id }))
  },
}
