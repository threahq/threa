import type { Querier } from "@threa/backend-common"

export interface WorkspaceRegistryRow {
  id: string
  name: string
  slug: string
  region: string
  created_by_workos_user_id: string
  workos_organization_id: string | null
  created_at: Date
  updated_at: Date
}

export interface WorkspaceMembershipRow {
  workspace_id: string
  workos_user_id: string
  joined_at: Date
}

export const WorkspaceRegistryRepository = {
  async findById(db: Querier, id: string): Promise<WorkspaceRegistryRow | null> {
    const result = await db.query<WorkspaceRegistryRow>(
      `SELECT id, name, slug, region, created_by_workos_user_id, workos_organization_id, created_at, updated_at
       FROM workspace_registry WHERE id = $1`,
      [id]
    )
    return result.rows[0] ?? null
  },

  /**
   * Batch counterpart to `findById` (INV-56). Returns rows in unspecified
   * order; callers should index by id if order matters.
   */
  async findByIds(db: Querier, ids: string[]): Promise<WorkspaceRegistryRow[]> {
    if (ids.length === 0) return []
    const result = await db.query<WorkspaceRegistryRow>(
      `SELECT id, name, slug, region, created_by_workos_user_id, workos_organization_id, created_at, updated_at
       FROM workspace_registry WHERE id = ANY($1::text[])`,
      [ids]
    )
    return result.rows
  },

  /** Backoffice: same as findById but also returns the member count in one round-trip. */
  async findByIdWithMemberCount(
    db: Querier,
    id: string
  ): Promise<(WorkspaceRegistryRow & { member_count: number }) | null> {
    const result = await db.query<WorkspaceRegistryRow & { member_count: string }>(
      `SELECT wr.id, wr.name, wr.slug, wr.region, wr.created_by_workos_user_id, wr.workos_organization_id,
              wr.created_at, wr.updated_at,
              COALESCE(COUNT(wm.workspace_id), 0)::text AS member_count
       FROM workspace_registry wr
       LEFT JOIN workspace_memberships wm ON wm.workspace_id = wr.id
       WHERE wr.id = $1
       GROUP BY wr.id`,
      [id]
    )
    const row = result.rows[0]
    if (!row) return null
    return { ...row, member_count: Number(row.member_count) }
  },

  /**
   * Backoffice: list every workspace a given WorkOS user is a member of. Used
   * when resolving "which workspace did this accepted invitation create?" —
   * the invitee signs in, creates a workspace, and ends up here via their
   * membership row.
   */
  async listIdsByUser(db: Querier, workosUserIds: string[]): Promise<Map<string, string[]>> {
    if (workosUserIds.length === 0) return new Map()
    const result = await db.query<{ workos_user_id: string; workspace_id: string }>(
      `SELECT workos_user_id, workspace_id
       FROM workspace_memberships
       WHERE workos_user_id = ANY($1::text[])`,
      [workosUserIds]
    )
    const map = new Map<string, string[]>()
    for (const row of result.rows) {
      const existing = map.get(row.workos_user_id) ?? []
      existing.push(row.workspace_id)
      map.set(row.workos_user_id, existing)
    }
    return map
  },

  async getWorkosOrganizationId(db: Querier, workspaceId: string): Promise<string | null> {
    const result = await db.query<{ workos_organization_id: string | null }>(
      "SELECT workos_organization_id FROM workspace_registry WHERE id = $1",
      [workspaceId]
    )
    return result.rows[0]?.workos_organization_id ?? null
  },

  async setWorkosOrganizationId(db: Querier, workspaceId: string, orgId: string): Promise<void> {
    await db.query(
      "UPDATE workspace_registry SET workos_organization_id = $1 WHERE id = $2 AND workos_organization_id IS NULL",
      [orgId, workspaceId]
    )
  },

  /**
   * List every workspace with its member count. Backoffice-only — there is no
   * workspace filter here, so callers must be in an admin-gated code path.
   */
  async listAllWithMemberCounts(db: Querier): Promise<Array<WorkspaceRegistryRow & { member_count: number }>> {
    const result = await db.query<WorkspaceRegistryRow & { member_count: string }>(
      `SELECT wr.id, wr.name, wr.slug, wr.region, wr.created_by_workos_user_id, wr.workos_organization_id,
              wr.created_at, wr.updated_at,
              COALESCE(COUNT(wm.workspace_id), 0)::text AS member_count
       FROM workspace_registry wr
       LEFT JOIN workspace_memberships wm ON wm.workspace_id = wr.id
       GROUP BY wr.id
       ORDER BY wr.created_at DESC`
    )
    return result.rows.map((row) => ({ ...row, member_count: Number(row.member_count) }))
  },

  /**
   * Look up all workspaces registered against a WorkOS organization. The fan-out
   * path uses this to translate a WorkOS membership event (keyed on
   * organization id) into the set of regional backends that need a mirror update.
   */
  async listByWorkosOrganizationId(
    db: Querier,
    workosOrganizationId: string
  ): Promise<Array<{ id: string; region: string }>> {
    const result = await db.query<{ id: string; region: string }>(
      `SELECT id, region FROM workspace_registry WHERE workos_organization_id = $1`,
      [workosOrganizationId]
    )
    return result.rows
  },

  /**
   * Count workspaces that have a non-null `workos_organization_id`. Used by the
   * owner backfill to compute "already-owner" workspaces by subtraction without
   * a second pass over all rows.
   */
  async countWithWorkosOrganizationId(db: Querier): Promise<number> {
    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM workspace_registry WHERE workos_organization_id IS NOT NULL`
    )
    return Number(result.rows[0]?.count ?? 0)
  },

  /**
   * List the distinct WorkOS organization ids registered for any workspace.
   * Used by the WorkOS authz backfill to enumerate orgs without paying for
   * the membership-count join in {@link listAllWithMemberCounts}.
   */
  async listWorkosOrganizationIds(db: Querier): Promise<string[]> {
    const result = await db.query<{ workos_organization_id: string }>(
      `SELECT DISTINCT workos_organization_id
       FROM workspace_registry
       WHERE workos_organization_id IS NOT NULL`
    )
    return result.rows.map((row) => row.workos_organization_id)
  },

  async listByUser(db: Querier, workosUserId: string): Promise<WorkspaceRegistryRow[]> {
    const result = await db.query<WorkspaceRegistryRow>(
      `SELECT wr.id, wr.name, wr.slug, wr.region, wr.created_by_workos_user_id, wr.workos_organization_id, wr.created_at, wr.updated_at
       FROM workspace_registry wr
       JOIN workspace_memberships wm ON wm.workspace_id = wr.id
       WHERE wm.workos_user_id = $1
       ORDER BY wr.created_at DESC`,
      [workosUserId]
    )
    return result.rows
  },

  async getRegion(db: Querier, workspaceId: string): Promise<string | null> {
    const result = await db.query<{ region: string }>("SELECT region FROM workspace_registry WHERE id = $1", [
      workspaceId,
    ])
    return result.rows[0]?.region ?? null
  },

  async findBySlug(db: Querier, slug: string): Promise<WorkspaceRegistryRow | null> {
    const result = await db.query<WorkspaceRegistryRow>(
      `SELECT id, name, slug, region, created_by_workos_user_id, workos_organization_id, created_at, updated_at
       FROM workspace_registry WHERE slug = $1`,
      [slug]
    )
    return result.rows[0] ?? null
  },

  async slugExists(db: Querier, slug: string): Promise<boolean> {
    const result = await db.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM workspace_registry WHERE slug = $1) as exists",
      [slug]
    )
    return result.rows[0]?.exists ?? false
  },

  async insert(
    db: Querier,
    workspace: { id: string; name: string; slug: string; region: string; createdByWorkosUserId: string }
  ): Promise<WorkspaceRegistryRow> {
    const result = await db.query<WorkspaceRegistryRow>(
      `INSERT INTO workspace_registry (id, name, slug, region, created_by_workos_user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, slug, region, created_by_workos_user_id, workos_organization_id, created_at, updated_at`,
      [workspace.id, workspace.name, workspace.slug, workspace.region, workspace.createdByWorkosUserId]
    )
    return result.rows[0]
  },

  async deleteById(db: Querier, id: string): Promise<void> {
    await db.query("DELETE FROM workspace_registry WHERE id = $1", [id])
  },

  async isMember(db: Querier, workspaceId: string, workosUserId: string): Promise<boolean> {
    const result = await db.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM workspace_memberships
         WHERE workspace_id = $1 AND workos_user_id = $2
       ) AS exists`,
      [workspaceId, workosUserId]
    )
    return result.rows[0]?.exists ?? false
  },

  async insertMembership(db: Querier, workspaceId: string, workosUserId: string): Promise<boolean> {
    const result = await db.query(
      `INSERT INTO workspace_memberships (workspace_id, workos_user_id)
       VALUES ($1, $2)
       ON CONFLICT (workspace_id, workos_user_id) DO NOTHING
       RETURNING workspace_id`,
      [workspaceId, workosUserId]
    )
    return (result.rowCount ?? 0) > 0
  },

  async deleteMembershipsByWorkspace(db: Querier, workspaceId: string): Promise<void> {
    await db.query("DELETE FROM workspace_memberships WHERE workspace_id = $1", [workspaceId])
  },
}
