import type { Querier } from "../../db"
import { sql } from "../../db"
import {
  Visibilities,
  type Label,
  type LabelMember,
  type LabelAssignment,
  type LabelableResourceType,
  type Visibility,
} from "@threa/types"

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
   * Like {@link findById} but takes a row lock so callers can serialize a
   * read-decide-write against concurrent writers (INV-20). Used by the
   * last-member-leave path to make the "is this the final member?" check
   * race-safe: concurrent `leave`s on the same label queue on this lock.
   */
  async findByIdForUpdate(db: Querier, workspaceId: string, labelId: string): Promise<Label | null> {
    const result = await db.query<LabelRow>(sql`
      SELECT ${sql.raw(LABEL_COLUMNS)}
      FROM labels
      WHERE id = ${labelId} AND workspace_id = ${workspaceId}
      FOR UPDATE
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * List labels visible to the viewer, expressed against the uniform membership
   * set: every public label in the workspace (joined or not — the Discover tab
   * needs both) plus any label the viewer is a member of. Since every label —
   * including private ones — now carries a creator membership row, the viewer's
   * own private labels surface via membership rather than a `creator_user_id`
   * special case (and visibility would automatically follow any future
   * shared-private model). Archived rows are excluded.
   */
  async listVisibleTo(db: Querier, workspaceId: string, userId: string): Promise<Label[]> {
    const result = await db.query<LabelRow>(sql`
      SELECT ${sql.raw(LABEL_COLUMNS)}
      FROM labels
      WHERE workspace_id = ${workspaceId}
        AND archived_at IS NULL
        AND (
          visibility = ${Visibilities.PUBLIC}
          OR EXISTS (
            SELECT 1 FROM label_members m
            WHERE m.label_id = labels.id
              AND m.user_id = ${userId}
              AND m.workspace_id = ${workspaceId}
          )
        )
      ORDER BY created_at DESC
    `)
    return result.rows.map(mapRow)
  },

  /**
   * Workspace-scoped public-slug existence check for the promote/create path.
   * `excludeLabelId` skips the row being updated so it doesn't collide with its
   * own slug.
   */
  async publicSlugExists(db: Querier, workspaceId: string, slug: string, excludeLabelId?: string): Promise<boolean> {
    const result = await db.query<{ exists: boolean }>(sql`
      SELECT 1 AS exists
      FROM labels
      WHERE workspace_id = ${workspaceId}
        AND visibility = ${Visibilities.PUBLIC}
        AND archived_at IS NULL
        AND slug = ${slug}
        AND (${excludeLabelId ?? null}::text IS NULL OR id <> ${excludeLabelId ?? null})
      LIMIT 1
    `)
    return result.rows.length > 0
  },

  /** Per-user private-slug existence check. `excludeLabelId` skips the row being updated. */
  async privateSlugExists(
    db: Querier,
    workspaceId: string,
    userId: string,
    slug: string,
    excludeLabelId?: string
  ): Promise<boolean> {
    const result = await db.query<{ exists: boolean }>(sql`
      SELECT 1 AS exists
      FROM labels
      WHERE workspace_id = ${workspaceId}
        AND visibility = ${Visibilities.PRIVATE}
        AND creator_user_id = ${userId}
        AND archived_at IS NULL
        AND slug = ${slug}
        AND (${excludeLabelId ?? null}::text IS NULL OR id <> ${excludeLabelId ?? null})
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

  /** Count current members of a label. Used by the last-member-leave check. */
  async countForLabel(db: Querier, workspaceId: string, labelId: string): Promise<number> {
    const result = await db.query<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count
      FROM label_members
      WHERE workspace_id = ${workspaceId} AND label_id = ${labelId}
    `)
    return Number(result.rows[0]?.count ?? "0")
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

interface LabelAssignmentRow {
  label_id: string
  resource_type: string
  resource_id: string
  user_id: string
  workspace_id: string
  assigned_at: Date
}

function mapAssignmentRow(row: LabelAssignmentRow): LabelAssignment {
  return {
    labelId: row.label_id,
    resourceType: row.resource_type as LabelableResourceType,
    resourceId: row.resource_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    assignedAt: row.assigned_at.toISOString(),
  }
}

const ASSIGNMENT_COLUMNS = "label_id, resource_type, resource_id, user_id, workspace_id, assigned_at"

/**
 * A {@link LabelAssignment} carrying its label's visibility. `listForViewer`
 * needs this to pick the right access rule per row: private rows are the
 * viewer's own and skip the resource gate, while every public row (any user's)
 * must be filtered through `listAccessibleStreamIds`.
 */
export interface VisibleAssignmentCandidate extends LabelAssignment {
  labelVisibility: Visibility
}

export interface AssignmentKey {
  workspaceId: string
  labelId: string
  resourceType: LabelableResourceType
  resourceId: string
  userId: string
}

export const LabelAssignmentRepository = {
  /**
   * Idempotent assign (INV-20). ON CONFLICT keeps the original `assigned_at` so
   * re-applying the same label doesn't churn the timestamp, and still returns
   * the row.
   */
  async assign(db: Querier, params: AssignmentKey): Promise<LabelAssignment> {
    const result = await db.query<LabelAssignmentRow>(sql`
      INSERT INTO label_assignments (label_id, resource_type, resource_id, user_id, workspace_id)
      VALUES (${params.labelId}, ${params.resourceType}, ${params.resourceId}, ${params.userId}, ${params.workspaceId})
      ON CONFLICT (workspace_id, resource_type, resource_id, label_id, user_id) DO UPDATE
        SET assigned_at = label_assignments.assigned_at
      RETURNING ${sql.raw(ASSIGNMENT_COLUMNS)}
    `)
    return mapAssignmentRow(result.rows[0]!)
  },

  /** Remove one assignment. Returns true if a row was deleted. */
  async unassign(db: Querier, params: AssignmentKey): Promise<boolean> {
    const result = await db.query(sql`
      DELETE FROM label_assignments
      WHERE workspace_id = ${params.workspaceId}
        AND resource_type = ${params.resourceType}
        AND resource_id = ${params.resourceId}
        AND label_id = ${params.labelId}
        AND user_id = ${params.userId}
    `)
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Assignments the viewer is allowed to see, before resource-access filtering:
   * every assignment on a public label (the shared pool — any user's row) plus
   * the viewer's own rows on their private labels. Joined to `labels` so a
   * single query enforces visibility; archived labels are excluded. The caller
   * still gates the public stream rows through `listAccessibleStreamIds` so a
   * public label on a private channel only reaches its members.
   */
  async listVisibleCandidates(db: Querier, workspaceId: string, userId: string): Promise<VisibleAssignmentCandidate[]> {
    const result = await db.query<LabelAssignmentRow & { label_visibility: string }>(sql`
      SELECT ${sql.raw(
        ASSIGNMENT_COLUMNS.split(", ")
          .map((c) => `a.${c}`)
          .join(", ")
      )}, l.visibility AS label_visibility
      FROM label_assignments a
      JOIN labels l ON l.id = a.label_id AND l.workspace_id = a.workspace_id
      WHERE a.workspace_id = ${workspaceId}
        AND l.archived_at IS NULL
        AND (
          l.visibility = ${Visibilities.PUBLIC}
          OR (l.visibility = ${Visibilities.PRIVATE} AND a.user_id = ${userId})
        )
    `)
    return result.rows.map((row) => ({
      ...mapAssignmentRow(row),
      labelVisibility: row.label_visibility as Visibility,
    }))
  },

  /**
   * Drop every assignment of a label across all users/resources. Callers run
   * this inside the label-archive transaction so no chip outlives its label.
   */
  async deleteAllForLabel(db: Querier, workspaceId: string, labelId: string): Promise<void> {
    await db.query(sql`
      DELETE FROM label_assignments
      WHERE workspace_id = ${workspaceId} AND label_id = ${labelId}
    `)
  },
}
