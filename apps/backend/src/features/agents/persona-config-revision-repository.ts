import { type PersonaConfigPatch, type PersonaConfigRevision, type PersonaRevisionAuthorKind } from "@threa/types"
import { sql, type Querier } from "../../db"
import { personaConfigRevisionId } from "../../lib/id"

/** Who committed the revision. Admins write via the editor; personas via a future 7.x tool. */
export type PersonaConfigRevisionAuthorKind = PersonaRevisionAuthorKind

interface PersonaConfigRevisionRow {
  id: string
  agent_id: string
  version: number
  patch: unknown
  created_by_kind: string
  created_by_id: string
  created_at: Date
}

/** A revision plus its `agentId`, so a restore can reject a revision foreign to the persona (404). */
export interface PersonaConfigRevisionRecord extends PersonaConfigRevision {
  agentId: string
}

export interface InsertPersonaConfigRevisionParams {
  workspaceId: string
  agentId: string
  patch: PersonaConfigPatch
  createdByKind: PersonaConfigRevisionAuthorKind
  createdById: string
}

function mapRow(row: PersonaConfigRevisionRow): PersonaConfigRevisionRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    version: row.version,
    patch: row.patch as PersonaConfigPatch,
    createdByKind: row.created_by_kind as PersonaConfigRevisionAuthorKind,
    createdById: row.created_by_id,
    createdAt: row.created_at.toISOString(),
  }
}

/**
 * Data access for `persona_config_revisions` — the append-only audit trail
 * behind the persona editor's history/restore surface (roadmap 7.1). Every
 * accepted override write appends one row via {@link insert}; the editor lists
 * them newest-first and restores an old `patch` by re-committing it. Workspace
 * scoped on every query (INV-8).
 */
export const PersonaConfigRevisionRepository = {
  /**
   * Append the revision for a just-committed override, deriving `version` as
   * `MAX(version)+1` for the persona in a single statement. MUST run in the
   * override's transaction: the override upsert's row lock serializes concurrent
   * `(workspace, agent)` writers, so this `MAX+1` can't collide (INV-20). Returns
   * the assigned version.
   */
  async insert(db: Querier, params: InsertPersonaConfigRevisionParams): Promise<{ version: number }> {
    const { workspaceId, agentId, patch, createdByKind, createdById } = params
    const result = await db.query<{ version: number }>(sql`
      INSERT INTO persona_config_revisions (id, workspace_id, agent_id, version, patch, created_by_kind, created_by_id)
      SELECT ${personaConfigRevisionId()}, ${workspaceId}, ${agentId},
             COALESCE(MAX(version), 0) + 1, ${JSON.stringify(patch)}::jsonb, ${createdByKind}, ${createdById}
      FROM persona_config_revisions
      WHERE workspace_id = ${workspaceId} AND agent_id = ${agentId}
      RETURNING version
    `)
    return { version: result.rows[0]!.version }
  },

  /** Revisions for one persona in a workspace, newest-first, capped at `limit`. */
  async listByWorkspaceAndAgent(
    db: Querier,
    workspaceId: string,
    agentId: string,
    limit: number
  ): Promise<PersonaConfigRevisionRecord[]> {
    const result = await db.query<PersonaConfigRevisionRow>(sql`
      SELECT id, agent_id, version, patch, created_by_kind, created_by_id, created_at
      FROM persona_config_revisions
      WHERE workspace_id = ${workspaceId} AND agent_id = ${agentId}
      ORDER BY version DESC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRow)
  },

  /** A single revision by id, workspace-scoped (INV-8). Includes `agentId` for the foreign-revision guard. */
  async findById(db: Querier, workspaceId: string, id: string): Promise<PersonaConfigRevisionRecord | null> {
    const result = await db.query<PersonaConfigRevisionRow>(sql`
      SELECT id, agent_id, version, patch, created_by_kind, created_by_id, created_at
      FROM persona_config_revisions
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
    const row = result.rows[0]
    return row ? mapRow(row) : null
  },
}
