import { sql, type Querier } from "../../db"
import { boardViewId } from "../../lib/id"
import { degradeBoardLens, type BoardView, type BoardLens, type BoardScopeStreamType } from "@threa/types"

interface BoardViewRow {
  id: string
  name: string
  base_lens: string
  scope_stream_ids: string[]
  scope_stream_types: string[]
  scope_label_ids: string[]
  exclude_stream_ids: string[]
  exclude_stream_types: string[]
  exclude_label_ids: string[]
  sort_order: number
}

const SELECT =
  "id, name, base_lens, scope_stream_ids, scope_stream_types, scope_label_ids, exclude_stream_ids, exclude_stream_types, exclude_label_ids, sort_order"

/** A row written under a since-retired lens degrades to the widest lens here, at
 *  the single read boundary, so every consumer of a saved view (href,
 *  active-match, summary) sees a live lens. Mirrors `parseLensParam`. */
function normalizeLens(value: string): BoardLens {
  return degradeBoardLens(value)
}

function mapRow(row: BoardViewRow): BoardView {
  return {
    id: row.id,
    name: row.name,
    baseLens: normalizeLens(row.base_lens),
    scopeStreamIds: row.scope_stream_ids,
    scopeStreamTypes: row.scope_stream_types as BoardScopeStreamType[],
    scopeLabelIds: row.scope_label_ids,
    excludeStreamIds: row.exclude_stream_ids,
    excludeStreamTypes: row.exclude_stream_types as BoardScopeStreamType[],
    excludeLabelIds: row.exclude_label_ids,
    sortOrder: row.sort_order,
  }
}

export interface CreateBoardViewParams {
  workspaceId: string
  userId: string
  name: string
  baseLens: BoardLens
  scopeStreamIds: string[]
  scopeStreamTypes: BoardScopeStreamType[]
  scopeLabelIds: string[]
  excludeStreamIds: string[]
  excludeStreamTypes: BoardScopeStreamType[]
  excludeLabelIds: string[]
}

export interface UpdateBoardViewParams {
  name?: string
  baseLens?: BoardLens
  scopeStreamIds?: string[]
  scopeStreamTypes?: BoardScopeStreamType[]
  scopeLabelIds?: string[]
  excludeStreamIds?: string[]
  excludeStreamTypes?: BoardScopeStreamType[]
  excludeLabelIds?: string[]
  sortOrder?: number
}

/**
 * User-saved board lenses. Single-query paths,
 * so callers pass `pool` (INV-30); writes are ownership-scoped by
 * `workspace_id + user_id` (INV-8) so a cross-user id can't be read or mutated.
 */
export const BoardViewRepository = {
  async listForUser(db: Querier, workspaceId: string, userId: string): Promise<BoardView[]> {
    const result = await db.query<BoardViewRow>(sql`
      SELECT ${sql.raw(SELECT)} FROM board_views
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
      ORDER BY sort_order ASC, created_at ASC
    `)
    return result.rows.map(mapRow)
  },

  async create(db: Querier, params: CreateBoardViewParams): Promise<BoardView> {
    // Append to the end: sort_order = max + 1, computed in the one statement so
    // concurrent saves from a user's devices don't collide (INV-20).
    const result = await db.query<BoardViewRow>(sql`
      INSERT INTO board_views
        (id, workspace_id, user_id, name, base_lens, scope_stream_ids, scope_stream_types,
         scope_label_ids, exclude_stream_ids, exclude_stream_types, exclude_label_ids, sort_order)
      VALUES (
        ${boardViewId()}, ${params.workspaceId}, ${params.userId}, ${params.name}, ${params.baseLens},
        ${params.scopeStreamIds}::text[], ${params.scopeStreamTypes}::text[],
        ${params.scopeLabelIds}::text[], ${params.excludeStreamIds}::text[],
        ${params.excludeStreamTypes}::text[], ${params.excludeLabelIds}::text[],
        COALESCE(
          (SELECT MAX(sort_order) + 1 FROM board_views WHERE workspace_id = ${params.workspaceId} AND user_id = ${params.userId}),
          0
        )
      )
      RETURNING ${sql.raw(SELECT)}
    `)
    return mapRow(result.rows[0]!)
  },

  /**
   * Update one field-set of a saved view. `COALESCE(null, existing)` keeps a field
   * the caller omitted (undefined → null), while an empty array clears the scope —
   * so `scopeStreamIds: []` really removes the stream scope. Race-safe single
   * UPDATE (INV-20); returns null when the id isn't the caller's.
   */
  async update(
    db: Querier,
    workspaceId: string,
    userId: string,
    id: string,
    params: UpdateBoardViewParams
  ): Promise<BoardView | null> {
    const result = await db.query<BoardViewRow>(sql`
      UPDATE board_views SET
        name = COALESCE(${params.name ?? null}, name),
        base_lens = COALESCE(${params.baseLens ?? null}, base_lens),
        scope_stream_ids = COALESCE(${params.scopeStreamIds ?? null}::text[], scope_stream_ids),
        scope_stream_types = COALESCE(${params.scopeStreamTypes ?? null}::text[], scope_stream_types),
        scope_label_ids = COALESCE(${params.scopeLabelIds ?? null}::text[], scope_label_ids),
        exclude_stream_ids = COALESCE(${params.excludeStreamIds ?? null}::text[], exclude_stream_ids),
        exclude_stream_types = COALESCE(${params.excludeStreamTypes ?? null}::text[], exclude_stream_types),
        exclude_label_ids = COALESCE(${params.excludeLabelIds ?? null}::text[], exclude_label_ids),
        sort_order = COALESCE(${params.sortOrder ?? null}, sort_order),
        updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND user_id = ${userId}
      RETURNING ${sql.raw(SELECT)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async delete(db: Querier, workspaceId: string, userId: string, id: string): Promise<boolean> {
    const result = await db.query(sql`
      DELETE FROM board_views
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
    return (result.rowCount ?? 0) > 0
  },
}
