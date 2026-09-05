import { composeSql } from "../../db"
import { chunkIds, registerBackfill, type BackfillContext } from "../../lib/backfill"
import { detectSearchConfig } from "../../lib/text-search-config"
import { MemoRepository, memoSearchText } from "./repository"

export const MEMO_SEARCH_CONFIG_BACKFILL_NAME = "memo-search-config"

export type MemoSearchConfigChunk = { ids: string[] }

export async function plan(ctx: BackfillContext, workspaceId: string): Promise<MemoSearchConfigChunk[]> {
  const result = await ctx.pool.query<{ id: string }>(composeSql`
    SELECT id FROM memos WHERE workspace_id = ${workspaceId} AND search_config IS NULL ORDER BY id
  `)
  return chunkIds(result.rows.map((row) => row.id)).map((ids) => ({ ids }))
}

export async function processChunk(
  ctx: BackfillContext,
  workspaceId: string,
  chunk: MemoSearchConfigChunk
): Promise<{ processed: number }> {
  if (chunk.ids.length === 0) return { processed: 0 }

  const result = await ctx.pool.query<{ id: string; title: string; abstract: string; key_points: string[] }>(
    composeSql`
      SELECT id, title, abstract, key_points
      FROM memos
      WHERE workspace_id = ${workspaceId} AND id = ANY(${chunk.ids}::text[]) AND search_config IS NULL
    `
  )
  const processed = await MemoRepository.fillMissingSearchConfigs(
    ctx.pool,
    result.rows.map((row) => ({
      id: row.id,
      searchConfig: detectSearchConfig(
        memoSearchText({ title: row.title, abstract: row.abstract, keyPoints: row.key_points })
      ),
    }))
  )
  return { processed }
}

export function registerMemoSearchConfigBackfill(): void {
  registerBackfill<MemoSearchConfigChunk>({ name: MEMO_SEARCH_CONFIG_BACKFILL_NAME, plan, processChunk })
}
