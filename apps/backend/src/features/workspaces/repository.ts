import type { WorkspaceTier } from "@threahq/types"
import type { Querier } from "../../db"
import { sql } from "../../db"

interface WorkspaceRow {
  id: string
  name: string
  slug: string
  tier: WorkspaceTier
  created_by: string | null
  created_at: Date
  updated_at: Date
}

export interface Workspace {
  id: string
  name: string
  slug: string
  tier: WorkspaceTier
  /** Null for an org workspace nobody has claimed yet. */
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export interface InsertWorkspaceParams {
  id: string
  name: string
  slug: string
  createdBy: string
}

function mapRowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    tier: row.tier,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const WorkspaceRepository = {
  async findById(db: Querier, id: string): Promise<Workspace | null> {
    const result = await db.query<WorkspaceRow>(sql`
      SELECT id, name, slug, tier, created_by, created_at, updated_at
      FROM workspaces WHERE id = ${id}
    `)
    return result.rows[0] ? mapRowToWorkspace(result.rows[0]) : null
  },

  async findBySlug(db: Querier, slug: string): Promise<Workspace | null> {
    const result = await db.query<WorkspaceRow>(sql`
      SELECT id, name, slug, tier, created_by, created_at, updated_at
      FROM workspaces WHERE slug = ${slug}
    `)
    return result.rows[0] ? mapRowToWorkspace(result.rows[0]) : null
  },

  async list(db: Querier, filters: { workosUserId: string }): Promise<Workspace[]> {
    const result = await db.query<WorkspaceRow>(
      // eslint-disable-next-line threa/workspace-scoped-sql -- the WorkOS identity discovers every workspace it belongs to
      sql`
        SELECT w.id, w.name, w.slug, w.tier, w.created_by, w.created_at, w.updated_at
        FROM workspaces w
        JOIN users u ON u.workspace_id = w.id
        WHERE u.workos_user_id = ${filters.workosUserId}
        ORDER BY w.created_at DESC
      `
    )
    return result.rows.map(mapRowToWorkspace)
  },

  async insert(db: Querier, params: InsertWorkspaceParams): Promise<Workspace> {
    const result = await db.query<WorkspaceRow>(sql`
      INSERT INTO workspaces (id, name, slug, created_by)
      VALUES (${params.id}, ${params.name}, ${params.slug}, ${params.createdBy})
      RETURNING id, name, slug, tier, created_by, created_at, updated_at
    `)
    return mapRowToWorkspace(result.rows[0])
  },

  async insertUnclaimedIfAbsent(
    db: Querier,
    params: { id: string; name: string; slug: string; tier: WorkspaceTier }
  ): Promise<void> {
    await db.query(sql`
      INSERT INTO workspaces (id, name, slug, tier, created_by)
      VALUES (${params.id}, ${params.name}, ${params.slug}, ${params.tier}, NULL)
      ON CONFLICT (id) DO NOTHING
    `)
  },

  async findByIdForUpdate(db: Querier, id: string): Promise<Workspace | null> {
    const result = await db.query<WorkspaceRow>(sql`
      SELECT id, name, slug, tier, created_by, created_at, updated_at
      FROM workspaces WHERE id = ${id}
      FOR UPDATE
    `)
    return result.rows[0] ? mapRowToWorkspace(result.rows[0]) : null
  },

  async slugExists(db: Querier, slug: string): Promise<boolean> {
    const result = await db.query(sql`
      SELECT 1 FROM workspaces WHERE slug = ${slug}
    `)
    return result.rows.length > 0
  },

  async getWorkosOrganizationId(db: Querier, workspaceId: string): Promise<string | null> {
    const result = await db.query<{ workos_organization_id: string | null }>(sql`
      SELECT workos_organization_id FROM workspaces WHERE id = ${workspaceId}
    `)
    return result.rows[0]?.workos_organization_id ?? null
  },

  async updateTier(db: Querier, workspaceId: string, tier: WorkspaceTier): Promise<boolean> {
    const result = await db.query(sql`
      UPDATE workspaces SET tier = ${tier}, updated_at = NOW() WHERE id = ${workspaceId}
    `)
    return (result.rowCount ?? 0) > 0
  },
}
