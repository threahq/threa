import { sql, type Querier } from "../../db"
import { personaConfigDraftId } from "../../lib/id"

interface DraftDetailRow {
  patch: unknown
  test_stream_id: string | null
  updated_at: Date
}

interface DraftIdentityRow {
  id: string
  workspace_id: string
  agent_id: string
  created_by: string
  patch: unknown
  test_stream_id: string | null
}

/** A caller's draft plus the timestamp the editor renders "saved Ns ago" from. */
export interface PersonaConfigDraftDetail {
  patch: unknown
  testStreamId: string | null
  updatedAt: string
}

/** The full identity of a draft, loaded by id in the turn precheck. */
export interface PersonaConfigDraftIdentity {
  id: string
  workspaceId: string
  agentId: string
  createdBy: string
  patch: unknown
  testStreamId: string | null
}

export interface UpsertPersonaConfigDraftParams {
  workspaceId: string
  agentId: string
  createdBy: string
  patch: unknown
}

/**
 * Data access for `persona_config_drafts` — the per-`(workspace, agent, editor)`
 * candidate patch behind the persona editor's test-drive substrate (roadmap
 * 7.1). The stored `patch` JSONB is opaque here; validate/apply it through the
 * shared schema (`personaConfigPatchSchema`) or `applyBuiltInAgentPatch`.
 */
export const PersonaConfigDraftRepository = {
  /** The caller's own draft for a persona, or `null` if they have none. */
  async findByOwner(
    db: Querier,
    workspaceId: string,
    agentId: string,
    createdBy: string
  ): Promise<PersonaConfigDraftDetail | null> {
    const result = await db.query<DraftDetailRow>(sql`
      SELECT patch, test_stream_id, updated_at
      FROM persona_config_drafts
      WHERE workspace_id = ${workspaceId}
        AND agent_id = ${agentId}
        AND created_by = ${createdBy}
    `)
    const row = result.rows[0]
    return row ? { patch: row.patch, testStreamId: row.test_stream_id, updatedAt: row.updated_at.toISOString() } : null
  },

  /** Load a draft by its own id (the turn precheck resolves the candidate config from this). */
  async findById(db: Querier, workspaceId: string, id: string): Promise<PersonaConfigDraftIdentity | null> {
    const result = await db.query<DraftIdentityRow>(sql`
      SELECT id, workspace_id, agent_id, created_by, patch, test_stream_id
      FROM persona_config_drafts
      WHERE id = ${id}
        AND workspace_id = ${workspaceId}
    `)
    const row = result.rows[0]
    return row
      ? {
          id: row.id,
          workspaceId: row.workspace_id,
          agentId: row.agent_id,
          createdBy: row.created_by,
          patch: row.patch,
          testStreamId: row.test_stream_id,
        }
      : null
  },

  /**
   * The draft bound to a test stream, if any (companion dispatch lookup: is this
   * stream a draft's test chat, and whose draft?). Uses the partial index.
   */
  async findByTestStreamId(
    db: Querier,
    workspaceId: string,
    testStreamId: string
  ): Promise<{ id: string; workspaceId: string; agentId: string } | null> {
    const result = await db.query<{ id: string; workspace_id: string; agent_id: string }>(sql`
      SELECT id, workspace_id, agent_id
      FROM persona_config_drafts
      WHERE test_stream_id = ${testStreamId}
        AND workspace_id = ${workspaceId}
    `)
    const row = result.rows[0]
    return row ? { id: row.id, workspaceId: row.workspace_id, agentId: row.agent_id } : null
  },

  /**
   * Race-safe upsert of the caller's draft patch (INV-20): a single
   * `INSERT … ON CONFLICT (workspace_id, agent_id, created_by) DO UPDATE`, so two
   * concurrent saves resolve to one row, last write winning. Only `patch` is
   * written — `test_stream_id` is preserved across a re-save (the conflict path
   * doesn't touch it) so an active test chat survives editing.
   */
  async upsert(db: Querier, params: UpsertPersonaConfigDraftParams): Promise<PersonaConfigDraftDetail> {
    const { workspaceId, agentId, createdBy, patch } = params
    const result = await db.query<DraftDetailRow>(sql`
      INSERT INTO persona_config_drafts (id, workspace_id, agent_id, created_by, patch)
      VALUES (${personaConfigDraftId()}, ${workspaceId}, ${agentId}, ${createdBy}, ${JSON.stringify(patch)}::jsonb)
      ON CONFLICT (workspace_id, agent_id, created_by)
      DO UPDATE SET patch = EXCLUDED.patch
      RETURNING patch, test_stream_id, updated_at
    `)
    const row = result.rows[0]!
    return { patch: row.patch, testStreamId: row.test_stream_id, updatedAt: row.updated_at.toISOString() }
  },

  /**
   * Bind (or rebind) the caller's draft to its test scratchpad in one race-safe
   * statement (INV-20). Inserts an empty-patch draft row when the editor started a
   * test chat before its first debounced save; on conflict it updates ONLY
   * `test_stream_id`, never `patch` — so a concurrent real `saveDraft` between the
   * ensureTestStream read and this write cannot be clobbered back to `{}`.
   */
  async bindTestStream(
    db: Querier,
    params: { workspaceId: string; agentId: string; createdBy: string; testStreamId: string }
  ): Promise<void> {
    const { workspaceId, agentId, createdBy, testStreamId } = params
    await db.query(sql`
      INSERT INTO persona_config_drafts (id, workspace_id, agent_id, created_by, patch, test_stream_id)
      VALUES (${personaConfigDraftId()}, ${workspaceId}, ${agentId}, ${createdBy}, '{}'::jsonb, ${testStreamId})
      ON CONFLICT (workspace_id, agent_id, created_by)
      DO UPDATE SET test_stream_id = EXCLUDED.test_stream_id
    `)
  },

  /**
   * Delete the caller's draft, returning the bound test stream id (if any) so the
   * caller can archive it. Returns `null` when there was no draft (idempotent
   * discard / commit-with-no-draft).
   */
  async deleteByOwner(
    db: Querier,
    workspaceId: string,
    agentId: string,
    createdBy: string
  ): Promise<{ testStreamId: string | null } | null> {
    const result = await db.query<{ test_stream_id: string | null }>(sql`
      DELETE FROM persona_config_drafts
      WHERE workspace_id = ${workspaceId}
        AND agent_id = ${agentId}
        AND created_by = ${createdBy}
      RETURNING test_stream_id
    `)
    const row = result.rows[0]
    return row ? { testStreamId: row.test_stream_id } : null
  },
}
