import type { Querier } from "../../db"
import { sql } from "../../db"
import { type Label, type LabelAssignment, type LabelableResourceType, type LabelActorType } from "@threa/types"

interface LabelRow {
  id: string
  workspace_id: string
  creator_actor_type: string
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

const LABEL_COLUMNS =
  "id, workspace_id, creator_actor_type, creator_user_id, name, slug, color, emoji, description, created_at, updated_at, archived_at"

function mapRow(row: LabelRow): Label {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    creatorActorType: row.creator_actor_type as LabelActorType,
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

export interface InsertLabelParams {
  id: string
  workspaceId: string
  creatorActorType: LabelActorType
  creatorUserId: string
  name: string
  slug: string
  color: string
  emoji: string | null
  description: string | null
}

/**
 * Upsert-by-name params (public API ergonomics). The insert columns are used
 * when the owner has no active label for `slug`; on conflict the existing row is
 * reused, and each appearance field is overwritten only when its `overwrite*`
 * flag is set (the caller explicitly provided it), so a bare assign-by-name
 * never clobbers a label's existing color/emoji/description.
 */
export interface UpsertLabelByNameParams extends InsertLabelParams {
  overwriteColor: boolean
  overwriteEmoji: boolean
  overwriteDescription: boolean
}

export interface UpsertLabelByNameResult {
  label: Label
  /** True when this call created the row (vs. matched an existing one). */
  inserted: boolean
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
        id, workspace_id, creator_actor_type, creator_user_id, name, slug, color, emoji, description
      )
      VALUES (
        ${params.id},
        ${params.workspaceId},
        ${params.creatorActorType},
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

  /**
   * Find-or-create the owner's label for `slug` in one race-safe statement
   * (INV-20). The owner's active labels are unique on `(workspace_id,
   * creator_user_id, slug)`, so the partial unique index is the conflict target.
   * `xmax = 0` distinguishes an inserted row from a matched one without a second
   * read.
   */
  async upsertByName(db: Querier, params: UpsertLabelByNameParams): Promise<UpsertLabelByNameResult> {
    const result = await db.query<LabelRow & { inserted: boolean }>(sql`
      INSERT INTO labels (
        id, workspace_id, creator_actor_type, creator_user_id, name, slug, color, emoji, description
      )
      VALUES (
        ${params.id},
        ${params.workspaceId},
        ${params.creatorActorType},
        ${params.creatorUserId},
        ${params.name},
        ${params.slug},
        ${params.color},
        ${params.emoji},
        ${params.description}
      )
      ON CONFLICT (workspace_id, creator_user_id, slug) WHERE archived_at IS NULL
      DO UPDATE SET
        name = EXCLUDED.name,
        color = CASE WHEN ${params.overwriteColor} THEN EXCLUDED.color ELSE labels.color END,
        emoji = CASE WHEN ${params.overwriteEmoji} THEN EXCLUDED.emoji ELSE labels.emoji END,
        description = CASE WHEN ${params.overwriteDescription} THEN EXCLUDED.description ELSE labels.description END,
        updated_at = NOW()
      RETURNING ${sql.raw(LABEL_COLUMNS)}, (xmax = 0) AS inserted
    `)
    const row = result.rows[0]!
    return { label: mapRow(row), inserted: row.inserted }
  },

  async findById(db: Querier, workspaceId: string, labelId: string): Promise<Label | null> {
    const result = await db.query<LabelRow>(sql`
      SELECT ${sql.raw(LABEL_COLUMNS)}
      FROM labels
      WHERE id = ${labelId} AND workspace_id = ${workspaceId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** Resolve an owner's active label by slug — the name-based lookup path. */
  async findByOwnerSlug(db: Querier, workspaceId: string, ownerId: string, slug: string): Promise<Label | null> {
    const result = await db.query<LabelRow>(sql`
      SELECT ${sql.raw(LABEL_COLUMNS)}
      FROM labels
      WHERE workspace_id = ${workspaceId}
        AND creator_user_id = ${ownerId}
        AND slug = ${slug}
        AND archived_at IS NULL
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** The actor's own active labels, newest first. */
  async listForActor(db: Querier, workspaceId: string, actorId: string): Promise<Label[]> {
    const result = await db.query<LabelRow>(sql`
      SELECT ${sql.raw(LABEL_COLUMNS)}
      FROM labels
      WHERE workspace_id = ${workspaceId}
        AND creator_user_id = ${actorId}
        AND archived_at IS NULL
      ORDER BY created_at DESC
    `)
    return result.rows.map(mapRow)
  },

  /** Per-owner slug-existence check for the create path. `excludeLabelId` skips the row being updated. */
  async slugExists(
    db: Querier,
    workspaceId: string,
    ownerId: string,
    slug: string,
    excludeLabelId?: string
  ): Promise<boolean> {
    const result = await db.query<{ exists: boolean }>(sql`
      SELECT 1 AS exists
      FROM labels
      WHERE workspace_id = ${workspaceId}
        AND creator_user_id = ${ownerId}
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
}

interface LabelAssignmentRow {
  label_id: string
  resource_type: string
  resource_id: string
  actor_type: string
  user_id: string
  workspace_id: string
  assigned_at: Date
}

function mapAssignmentRow(row: LabelAssignmentRow): LabelAssignment {
  return {
    labelId: row.label_id,
    resourceType: row.resource_type as LabelableResourceType,
    resourceId: row.resource_id,
    actorType: row.actor_type as LabelActorType,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    assignedAt: row.assigned_at.toISOString(),
  }
}

const ASSIGNMENT_COLUMNS = "label_id, resource_type, resource_id, actor_type, user_id, workspace_id, assigned_at"

export interface AssignmentKey {
  workspaceId: string
  labelId: string
  resourceType: LabelableResourceType
  resourceId: string
  userId: string
}

export interface InsertAssignmentParams extends AssignmentKey {
  actorType: LabelActorType
}

export const LabelAssignmentRepository = {
  /**
   * Idempotent assign (INV-20). ON CONFLICT keeps the original `assigned_at` so
   * re-applying the same label doesn't churn the timestamp, and still returns
   * the row.
   */
  async assign(db: Querier, params: InsertAssignmentParams): Promise<LabelAssignment> {
    const result = await db.query<LabelAssignmentRow>(sql`
      INSERT INTO label_assignments (label_id, resource_type, resource_id, actor_type, user_id, workspace_id)
      VALUES (
        ${params.labelId},
        ${params.resourceType},
        ${params.resourceId},
        ${params.actorType},
        ${params.userId},
        ${params.workspaceId}
      )
      ON CONFLICT (workspace_id, resource_type, resource_id, label_id, user_id) DO UPDATE
        SET assigned_at = label_assignments.assigned_at, actor_type = EXCLUDED.actor_type
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
   * The actor's own assignments (labels are owner-scoped), excluding rows whose
   * label is archived. Joined to `labels` so the archived filter is a single
   * query; the caller applies any actor-specific resource-access gate.
   */
  async listForActor(db: Querier, workspaceId: string, actorId: string): Promise<LabelAssignment[]> {
    const result = await db.query<LabelAssignmentRow>(sql`
      SELECT ${sql.raw(
        ASSIGNMENT_COLUMNS.split(", ")
          .map((c) => `a.${c}`)
          .join(", ")
      )}
      FROM label_assignments a
      JOIN labels l ON l.id = a.label_id AND l.workspace_id = a.workspace_id
      WHERE a.workspace_id = ${workspaceId}
        AND a.user_id = ${actorId}
        AND l.archived_at IS NULL
    `)
    return result.rows.map(mapAssignmentRow)
  },

  /**
   * Drop every assignment of a label across all resources. Callers run this
   * inside the label-archive transaction so no chip outlives its label.
   */
  async deleteAllForLabel(db: Querier, workspaceId: string, labelId: string): Promise<void> {
    await db.query(sql`
      DELETE FROM label_assignments
      WHERE workspace_id = ${workspaceId} AND label_id = ${labelId}
    `)
  },
}
