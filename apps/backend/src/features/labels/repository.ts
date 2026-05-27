import type { Querier } from "../../db"
import { sql } from "../../db"
import { Visibilities, type Label, type LabelMember, type Visibility } from "@threa/types"

interface LabelRow {
  id: string
  workspace_id: string
  visibility: string
  creator_user_id: string
  name: string
  slug: string
  color: string
  emoji: string | null
  description: string | null
  created_at: Date
  updated_at: Date
  archived_at: Date | null
}

interface LabelMemberRow {
  label_id: string
  user_id: string
  workspace_id: string
  joined_at: Date
}

const LABEL_COLUMNS =
  "id, workspace_id, visibility, creator_user_id, name, slug, color, emoji, description, created_at, updated_at, archived_at"

function mapRow(row: LabelRow): Label {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    visibility: row.visibility as Visibility,
    creatorUserId: row.creator_user_id,
    name: row.name,
    slug: row.slug,
    color: row.color,
    emoji: row.emoji,
    description: row.description,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
  }
}

function mapMemberRow(row: LabelMemberRow): LabelMember {
  return {
    labelId: row.label_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    joinedAt: row.joined_at.toISOString(),
  }
}

export interface InsertLabelParams {
  id: string
  workspaceId: string
  visibility: Visibility
  creatorUserId: string
  name: string
  slug: string
  color: string
  emoji: string | null
  description: string | null
}

export interface UpdateLabelParams {
  name?: string
  slug?: string
  color?: string
  emoji?: string | null
  description?: string | null
}

export const LabelRepository = {
  async insert(db: Querier, params: InsertLabelParams): Promise<Label> {
    const result = await db.query<LabelRow>(sql`
      INSERT INTO labels (
        id, workspace_id, visibility, creator_user_id, name, slug, color, emoji, description
      )
      VALUES (
        ${params.id},
        ${params.workspaceId},
        ${params.visibility},
        ${params.creatorUserId},
        ${params.name},
        ${params.slug},
        ${params.color},
        ${params.emoji},
        ${params.description}
      )
      RETURNING ${sql.raw(LABEL_COLUMNS)}
    `)
    return mapRow(result.rows[0]!)
  },

  async findById(db: Querier, workspaceId: string, labelId: string): Promise<Label | null> {
    const result = await db.query<LabelRow>(sql`
      SELECT ${sql.raw(LABEL_COLUMNS)}
      FROM labels
      WHERE id = ${labelId} AND workspace_id = ${workspaceId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * List labels visible to the viewer: all public labels in the workspace
   * (joined or not — the Discover tab needs both) plus the viewer's own
   * private labels. Archived rows are excluded.
   */
  async listVisibleTo(db: Querier, workspaceId: string, userId: string): Promise<Label[]> {
    const result = await db.query<LabelRow>(sql`
      SELECT ${sql.raw(LABEL_COLUMNS)}
      FROM labels
      WHERE workspace_id = ${workspaceId}
        AND archived_at IS NULL
        AND (
          visibility = ${Visibilities.PUBLIC}
          OR (visibility = ${Visibilities.PRIVATE} AND creator_user_id = ${userId})
        )
      ORDER BY created_at DESC
    `)
    return result.rows.map(mapRow)
  },

  /** Workspace-scoped public-slug existence check for the promote/create path. */
  async publicSlugExists(db: Querier, workspaceId: string, slug: string): Promise<boolean> {
    const result = await db.query<{ exists: boolean }>(sql`
      SELECT 1 AS exists
      FROM labels
      WHERE workspace_id = ${workspaceId}
        AND visibility = ${Visibilities.PUBLIC}
        AND archived_at IS NULL
        AND slug = ${slug}
      LIMIT 1
    `)
    return result.rows.length > 0
  },

  /** Per-user private-slug existence check. */
  async privateSlugExists(db: Querier, workspaceId: string, userId: string, slug: string): Promise<boolean> {
    const result = await db.query<{ exists: boolean }>(sql`
      SELECT 1 AS exists
      FROM labels
      WHERE workspace_id = ${workspaceId}
        AND visibility = ${Visibilities.PRIVATE}
        AND creator_user_id = ${userId}
        AND archived_at IS NULL
        AND slug = ${slug}
      LIMIT 1
    `)
    return result.rows.length > 0
  },

  async update(db: Querier, workspaceId: string, labelId: string, params: UpdateLabelParams): Promise<Label | null> {
    const result = await db.query<LabelRow>(sql`
      UPDATE labels SET
        name = COALESCE(${params.name ?? null}, name),
        slug = COALESCE(${params.slug ?? null}, slug),
        color = COALESCE(${params.color ?? null}, color),
        emoji = CASE WHEN ${params.emoji !== undefined} THEN ${params.emoji ?? null} ELSE emoji END,
        description = CASE WHEN ${params.description !== undefined} THEN ${params.description ?? null} ELSE description END,
        updated_at = NOW()
      WHERE id = ${labelId}
        AND workspace_id = ${workspaceId}
        AND archived_at IS NULL
      RETURNING ${sql.raw(LABEL_COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** Soft-archive. Returns true if a row was archived (false if already archived or missing). */
  async archive(db: Querier, workspaceId: string, labelId: string): Promise<boolean> {
    const result = await db.query(sql`
      UPDATE labels SET
        archived_at = NOW(),
        updated_at = NOW()
      WHERE id = ${labelId}
        AND workspace_id = ${workspaceId}
        AND archived_at IS NULL
    `)
    return (result.rowCount ?? 0) > 0
  },

  /** Promote a private label to public. Returns the updated label or null. */
  async promoteToPublic(db: Querier, workspaceId: string, labelId: string): Promise<Label | null> {
    const result = await db.query<LabelRow>(sql`
      UPDATE labels SET
        visibility = ${Visibilities.PUBLIC},
        updated_at = NOW()
      WHERE id = ${labelId}
        AND workspace_id = ${workspaceId}
        AND archived_at IS NULL
        AND visibility = ${Visibilities.PRIVATE}
      RETURNING ${sql.raw(LABEL_COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },
}

export const LabelMemberRepository = {
  /**
   * Idempotent join (INV-20). Returns the membership row; ON CONFLICT keeps
   * the original `joined_at` so re-joining doesn't churn the timestamp.
   */
  async join(db: Querier, params: { labelId: string; userId: string; workspaceId: string }): Promise<LabelMember> {
    const result = await db.query<LabelMemberRow>(sql`
      INSERT INTO label_members (label_id, user_id, workspace_id)
      VALUES (${params.labelId}, ${params.userId}, ${params.workspaceId})
      ON CONFLICT (label_id, user_id) DO UPDATE
        SET workspace_id = EXCLUDED.workspace_id
      RETURNING label_id, user_id, workspace_id, joined_at
    `)
    return mapMemberRow(result.rows[0]!)
  },

  async leave(db: Querier, params: { labelId: string; userId: string }): Promise<boolean> {
    const result = await db.query(sql`
      DELETE FROM label_members
      WHERE label_id = ${params.labelId} AND user_id = ${params.userId}
    `)
    return (result.rowCount ?? 0) > 0
  },

  async listForUser(db: Querier, workspaceId: string, userId: string): Promise<LabelMember[]> {
    const result = await db.query<LabelMemberRow>(sql`
      SELECT label_id, user_id, workspace_id, joined_at
      FROM label_members
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
    return result.rows.map(mapMemberRow)
  },

  /**
   * Drop all memberships for an archived label (callers run this inside the
   * archive transaction so members aren't left subscribed to a tombstoned row).
   */
  async deleteAllForLabel(db: Querier, labelId: string): Promise<void> {
    await db.query(sql`DELETE FROM label_members WHERE label_id = ${labelId}`)
  },
}
