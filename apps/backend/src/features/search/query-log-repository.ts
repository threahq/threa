import type { SearchClickKind } from "@threa/types"
import { sql, type Querier } from "../../db"
import type { SearchRanking } from "./config"

export type SearchQueryMode = "normal" | "deep"

export interface SearchQueryLogResultIds {
  messages: string[]
  conversations: string[]
  memos: string[]
}

const RESULT_LIST_BY_KIND: Record<SearchClickKind, keyof SearchQueryLogResultIds> = {
  message: "messages",
  conversation: "conversations",
  memo: "memos",
}

export interface InsertSearchQueryLogInput {
  id: string
  workspaceId: string
  userId: string
  query: string
  params: unknown
  mode: SearchQueryMode
  ranking: SearchRanking
  resultIds: SearchQueryLogResultIds
}

export interface SearchQueryLogRow {
  id: string
  workspaceId: string
  userId: string
  query: string
  params: unknown
  mode: string
  ranking: string
  resultIds: SearchQueryLogResultIds
  clickedKind: string | null
  clickedId: string | null
  clickedAt: Date | null
  createdAt: Date
}

interface SearchQueryLogDbRow {
  id: string
  workspace_id: string
  user_id: string
  query: string
  params: unknown
  mode: string
  ranking: string
  result_ids: SearchQueryLogResultIds
  clicked_kind: string | null
  clicked_id: string | null
  clicked_at: Date | null
  created_at: Date
}

function mapRow(row: SearchQueryLogDbRow): SearchQueryLogRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    query: row.query,
    params: row.params,
    mode: row.mode,
    ranking: row.ranking,
    resultIds: row.result_ids,
    clickedKind: row.clicked_kind,
    clickedId: row.clicked_id,
    clickedAt: row.clicked_at,
    createdAt: row.created_at,
  }
}

export const SearchQueryLogRepository = {
  async insert(db: Querier, input: InsertSearchQueryLogInput): Promise<void> {
    await db.query(sql`
      INSERT INTO search_query_log (id, workspace_id, user_id, query, params, mode, ranking, result_ids)
      VALUES (
        ${input.id}, ${input.workspaceId}, ${input.userId}, ${input.query},
        ${JSON.stringify(input.params)}::jsonb, ${input.mode}, ${input.ranking},
        ${JSON.stringify(input.resultIds)}::jsonb
      )
    `)
  },

  /**
   * Last click wins. The row must belong to the same workspace and user (INV-8)
   * and the target must be one of the row's own results, so a click can never
   * attribute an id the search did not return.
   */
  async recordClick(
    db: Querier,
    params: { workspaceId: string; userId: string; id: string; kind: SearchClickKind; targetId: string }
  ): Promise<boolean> {
    const result = await db.query(sql`
      UPDATE search_query_log
      SET clicked_kind = ${params.kind}, clicked_id = ${params.targetId}, clicked_at = NOW()
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND user_id = ${params.userId}
        AND result_ids -> ${RESULT_LIST_BY_KIND[params.kind]}::text ? ${params.targetId}
    `)
    return (result.rowCount ?? 0) > 0
  },

  /** Exists solely for INV-68 integration readback of the real statements; no route exposes it. */
  async listForUser(db: Querier, workspaceId: string, userId: string, limit: number): Promise<SearchQueryLogRow[]> {
    const result = await db.query<SearchQueryLogDbRow>(sql`
      SELECT id, workspace_id, user_id, query, params, mode, ranking, result_ids,
             clicked_kind, clicked_id, clicked_at, created_at
      FROM search_query_log
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRow)
  },
}
