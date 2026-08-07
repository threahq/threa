import { ulid } from "ulid"
import type { Querier } from "../../db"
import { sql } from "../../db"
import { DYNAMIC_NAMING_SETTLING_KEEPS } from "./config"
import type {
  DynamicNamingCheckpoint,
  DynamicNamingClaimReason,
  DynamicNamingDecision,
  DynamicNamingTargetKind,
} from "./types"

interface StateRow {
  id: string
  workspace_id: string
  target_kind: string
  target_id: string
  last_evaluated_message_count: number
  consecutive_keeps: number
  completed_at: Date | null
  version: number
  structure_version: number
  last_evaluated_structure_version: number
  last_structural_event_id: string | null
  regeneration_pending: boolean
  claim_token: string | null
  claim_owner_id: string | null
  claim_checkpoint: number | null
  claim_message_count: number | null
  claim_structure_version: number | null
  claim_title_revision: number | null
  claim_reason: string | null
  claim_expires_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface DynamicNamingState {
  id: string
  workspaceId: string
  targetKind: DynamicNamingTargetKind
  targetId: string
  lastEvaluatedMessageCount: number
  consecutiveKeeps: number
  completedAt: Date | null
  version: number
  structureVersion: number
  lastEvaluatedStructureVersion: number
  lastStructuralEventId: string | null
  regenerationPending: boolean
  claimToken: string | null
  claimOwnerId: string | null
  claimCheckpoint: DynamicNamingCheckpoint | null
  claimMessageCount: number | null
  claimStructureVersion: number | null
  claimTitleRevision: number | null
  claimReason: DynamicNamingClaimReason | null
  claimExpiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const COLUMNS =
  "id, workspace_id, target_kind, target_id, last_evaluated_message_count, consecutive_keeps, completed_at, version, structure_version, last_evaluated_structure_version, last_structural_event_id, regeneration_pending, claim_token, claim_owner_id, claim_checkpoint, claim_message_count, claim_structure_version, claim_title_revision, claim_reason, claim_expires_at, created_at, updated_at"
const clearClaim = sql.raw(
  "claim_token = NULL, claim_owner_id = NULL, claim_checkpoint = NULL, claim_message_count = NULL, claim_structure_version = NULL, claim_title_revision = NULL, claim_reason = NULL, claim_expires_at = NULL"
)

function mapRow(row: StateRow): DynamicNamingState {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    targetKind: row.target_kind as DynamicNamingTargetKind,
    targetId: row.target_id,
    lastEvaluatedMessageCount: row.last_evaluated_message_count,
    consecutiveKeeps: row.consecutive_keeps,
    completedAt: row.completed_at,
    version: row.version,
    structureVersion: row.structure_version,
    lastEvaluatedStructureVersion: row.last_evaluated_structure_version,
    lastStructuralEventId: row.last_structural_event_id,
    regenerationPending: row.regeneration_pending,
    claimToken: row.claim_token,
    claimOwnerId: row.claim_owner_id,
    claimCheckpoint: row.claim_checkpoint as DynamicNamingCheckpoint | null,
    claimMessageCount: row.claim_message_count,
    claimStructureVersion: row.claim_structure_version,
    claimTitleRevision: row.claim_title_revision,
    claimReason: row.claim_reason as DynamicNamingClaimReason | null,
    claimExpiresAt: row.claim_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function dynamicNamingClaimId(): string {
  return `dnclaim_${ulid()}`
}

export const DynamicNamingStateRepository = {
  async ensure(
    db: Querier,
    params: { workspaceId: string; targetKind: DynamicNamingTargetKind; targetId: string }
  ): Promise<DynamicNamingState> {
    const result = await db.query<StateRow>(sql`
      INSERT INTO dynamic_naming_state (id, workspace_id, target_kind, target_id)
      VALUES (${`dnstate_${ulid()}`}, ${params.workspaceId}, ${params.targetKind}, ${params.targetId})
      ON CONFLICT (workspace_id, target_kind, target_id) DO UPDATE
      SET workspace_id = EXCLUDED.workspace_id
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return mapRow(result.rows[0]!)
  },

  async find(
    db: Querier,
    workspaceId: string,
    targetKind: DynamicNamingTargetKind,
    targetId: string
  ): Promise<DynamicNamingState | null> {
    const result = await db.query<StateRow>(sql`
      SELECT ${sql.raw(COLUMNS)} FROM dynamic_naming_state
      WHERE workspace_id = ${workspaceId} AND target_kind = ${targetKind} AND target_id = ${targetId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async claim(
    db: Querier,
    params: {
      workspaceId: string
      targetKind: DynamicNamingTargetKind
      targetId: string
      ownerId: string
      checkpoint: DynamicNamingCheckpoint
      messageCount: number
      structureVersion: number
      titleRevision: number
      expectedVersion: number
      leaseSeconds: number
    }
  ): Promise<DynamicNamingState | null> {
    const token = dynamicNamingClaimId()
    const result = await db.query<StateRow>(sql`
      UPDATE dynamic_naming_state SET
        claim_token = ${token}, claim_owner_id = ${params.ownerId}, claim_checkpoint = ${params.checkpoint},
        claim_message_count = ${params.messageCount}, claim_structure_version = ${params.structureVersion},
        claim_title_revision = ${params.titleRevision},
        claim_reason = CASE WHEN regeneration_pending THEN 'regenerate' WHEN structure_version > last_evaluated_structure_version THEN 'structural' ELSE 'ordinary' END,
        claim_expires_at = NOW() + (${params.leaseSeconds} || ' seconds')::interval,
        version = version + 1, updated_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND target_kind = ${params.targetKind} AND target_id = ${params.targetId}
        AND structure_version = ${params.structureVersion} AND version = ${params.expectedVersion}
        AND (claim_token IS NULL OR claim_expires_at <= NOW())
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async release(
    db: Querier,
    params: {
      workspaceId: string
      targetKind: DynamicNamingTargetKind
      targetId: string
      token: string
      expectedVersion: number
    }
  ): Promise<DynamicNamingState | null> {
    const result = await db.query<StateRow>(sql`
      UPDATE dynamic_naming_state SET ${clearClaim}, version = version + 1, updated_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND target_kind = ${params.targetKind} AND target_id = ${params.targetId}
        AND claim_token = ${params.token} AND version = ${params.expectedVersion}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async applyDecision(
    db: Querier,
    params: {
      workspaceId: string
      targetKind: DynamicNamingTargetKind
      targetId: string
      token: string
      expectedVersion: number
      titleRevision: number
      decision: DynamicNamingDecision
    }
  ): Promise<DynamicNamingState | null> {
    const isKeep = params.decision.action === "keep"
    const isRename = params.decision.action === "rename"
    const result = await db.query<StateRow>(sql`
      UPDATE dynamic_naming_state SET
        last_evaluated_message_count = CASE
          WHEN claim_reason = 'structural' THEN last_evaluated_message_count
          ELSE GREATEST(last_evaluated_message_count, claim_message_count)
        END,
        consecutive_keeps = CASE
          WHEN ${isRename} THEN 0
          WHEN claim_reason IN ('structural', 'regenerate') THEN consecutive_keeps
          WHEN ${isKeep} THEN consecutive_keeps + 1
          ELSE 0
        END,
        completed_at = CASE
          WHEN claim_reason IN ('structural', 'regenerate') THEN completed_at
          WHEN claim_checkpoint = 10 OR (${isKeep} AND consecutive_keeps + 1 >= ${DYNAMIC_NAMING_SETTLING_KEEPS}) THEN COALESCE(completed_at, NOW())
          ELSE completed_at
        END,
        last_evaluated_structure_version = CASE WHEN claim_reason IN ('structural', 'regenerate') THEN claim_structure_version ELSE last_evaluated_structure_version END,
        regeneration_pending = CASE WHEN claim_reason = 'regenerate' THEN FALSE ELSE regeneration_pending END,
        ${clearClaim}, version = version + 1, updated_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND target_kind = ${params.targetKind} AND target_id = ${params.targetId}
        AND claim_token = ${params.token} AND version = ${params.expectedVersion}
        AND claim_expires_at > NOW() AND claim_title_revision = ${params.titleRevision}
        AND claim_structure_version = structure_version
        AND (claim_reason IN ('structural', 'regenerate') OR completed_at IS NULL)
        AND (${params.decision.action} <> 'defer' OR (claim_reason = 'ordinary' AND claim_checkpoint = 1))
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async recoverExpiredClaims(db: Querier, workspaceId: string, limit: number): Promise<number> {
    const result = await db.query(sql`
      WITH expired AS (
        SELECT id FROM dynamic_naming_state
        WHERE workspace_id = ${workspaceId} AND claim_token IS NOT NULL AND claim_expires_at <= NOW()
        ORDER BY claim_expires_at, target_kind, target_id
        LIMIT ${limit} FOR UPDATE SKIP LOCKED
      )
      UPDATE dynamic_naming_state s SET ${clearClaim}, version = version + 1, updated_at = NOW()
      FROM expired WHERE s.id = expired.id
    `)
    return result.rowCount ?? 0
  },

  async recordStructuralEvent(
    db: Querier,
    params: { workspaceId: string; targetKind: DynamicNamingTargetKind; targetId: string; eventId: string }
  ): Promise<DynamicNamingState | null> {
    const result = await db.query<StateRow>(sql`
      UPDATE dynamic_naming_state SET
        structure_version = structure_version + 1, last_structural_event_id = ${params.eventId}::bigint,
        ${clearClaim}, version = version + 1, updated_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND target_kind = ${params.targetKind} AND target_id = ${params.targetId}
        AND (last_structural_event_id IS NULL OR last_structural_event_id < ${params.eventId}::bigint)
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async resetForRegeneration(
    db: Querier,
    params: { workspaceId: string; targetKind: DynamicNamingTargetKind; targetId: string; expectedVersion: number }
  ): Promise<DynamicNamingState | null> {
    const result = await db.query<StateRow>(sql`
      UPDATE dynamic_naming_state SET
        last_evaluated_message_count = 0, consecutive_keeps = 0, completed_at = NULL,
        structure_version = structure_version + 1, regeneration_pending = TRUE, ${clearClaim}, version = version + 1, updated_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND target_kind = ${params.targetKind} AND target_id = ${params.targetId}
        AND version = ${params.expectedVersion}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async cleanupOrphans(db: Querier, workspaceId: string, limit: number): Promise<number> {
    const result = await db.query(sql`
      WITH orphans AS (
        SELECT s.id FROM dynamic_naming_state s
        WHERE s.workspace_id = ${workspaceId} AND s.claim_token IS NULL AND (
          (s.target_kind = 'stream' AND NOT EXISTS (SELECT 1 FROM streams t WHERE t.workspace_id = s.workspace_id AND t.id = s.target_id)) OR
          (s.target_kind = 'conversation' AND NOT EXISTS (SELECT 1 FROM conversations t WHERE t.workspace_id = s.workspace_id AND t.id = s.target_id))
        )
        ORDER BY s.target_kind, s.target_id LIMIT ${limit} FOR UPDATE OF s SKIP LOCKED
      )
      DELETE FROM dynamic_naming_state s USING orphans WHERE s.id = orphans.id
    `)
    return result.rowCount ?? 0
  },
}
