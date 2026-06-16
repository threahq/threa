import type { Querier } from "../../db"
import { sql } from "../../db"

interface WorkspaceRow {
  id: string
  name: string
  slug: string
  created_by: string
  created_at: Date
  updated_at: Date
}

export interface Workspace {
  id: string
  name: string
  slug: string
  createdBy: string
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
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const WorkspaceRepository = {
  async findById(db: Querier, id: string): Promise<Workspace | null> {
    const result = await db.query<WorkspaceRow>(sql`
      SELECT id, name, slug, created_by, created_at, updated_at
      FROM workspaces WHERE id = ${id}
    `)
    return result.rows[0] ? mapRowToWorkspace(result.rows[0]) : null
  },

  async findBySlug(db: Querier, slug: string): Promise<Workspace | null> {
    const result = await db.query<WorkspaceRow>(sql`
      SELECT id, name, slug, created_by, created_at, updated_at
      FROM workspaces WHERE slug = ${slug}
    `)
    return result.rows[0] ? mapRowToWorkspace(result.rows[0]) : null
  },

  async list(db: Querier, filters: { workosUserId: string }): Promise<Workspace[]> {
    const result = await db.query<WorkspaceRow>(sql`
      SELECT w.id, w.name, w.slug, w.created_by, w.created_at, w.updated_at
      FROM workspaces w
      JOIN users u ON u.workspace_id = w.id
      WHERE u.workos_user_id = ${filters.workosUserId}
      ORDER BY w.created_at DESC
    `)
    return result.rows.map(mapRowToWorkspace)
  },

  async insert(db: Querier, params: InsertWorkspaceParams): Promise<Workspace> {
    const result = await db.query<WorkspaceRow>(sql`
      INSERT INTO workspaces (id, name, slug, created_by)
      VALUES (${params.id}, ${params.name}, ${params.slug}, ${params.createdBy})
      RETURNING id, name, slug, created_by, created_at, updated_at
    `)
    return mapRowToWorkspace(result.rows[0])
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

  async setWorkosOrganizationId(db: Querier, workspaceId: string, orgId: string): Promise<void> {
    await db.query(sql`
      UPDATE workspaces SET workos_organization_id = ${orgId} WHERE id = ${workspaceId}
    `)
  },
}
