import { composeSql } from "../../db"
import { chunkIds, registerBackfill, type BackfillContext } from "../../lib/backfill"
import { detectSearchConfig } from "../../lib/text-search-config"
import { AttachmentExtractionRepository, extractionSearchText } from "./extraction-repository"

export const ATTACHMENT_EXTRACTION_SEARCH_CONFIG_BACKFILL_NAME = "attachment-extraction-search-config"

export type AttachmentExtractionSearchConfigChunk = { ids: string[] }

export async function plan(
  ctx: BackfillContext,
  workspaceId: string
): Promise<AttachmentExtractionSearchConfigChunk[]> {
  const result = await ctx.pool.query<{ id: string }>(composeSql`
    SELECT id
    FROM attachment_extractions
    WHERE workspace_id = ${workspaceId} AND search_config IS NULL
    ORDER BY id
  `)
  return chunkIds(result.rows.map((row) => row.id)).map((ids) => ({ ids }))
}

export async function processChunk(
  ctx: BackfillContext,
  workspaceId: string,
  chunk: AttachmentExtractionSearchConfigChunk
): Promise<{ processed: number }> {
  if (chunk.ids.length === 0) return { processed: 0 }

  const result = await ctx.pool.query<{ id: string; summary: string; full_text: string | null }>(composeSql`
    SELECT id, summary, full_text
    FROM attachment_extractions
    WHERE workspace_id = ${workspaceId} AND id = ANY(${chunk.ids}::text[]) AND search_config IS NULL
  `)
  const processed = await AttachmentExtractionRepository.fillMissingSearchConfigs(
    ctx.pool,
    workspaceId,
    result.rows.map((row) => ({
      id: row.id,
      searchConfig: detectSearchConfig(extractionSearchText({ summary: row.summary, fullText: row.full_text })),
    }))
  )
  return { processed }
}

export function registerAttachmentExtractionSearchConfigBackfill(): void {
  registerBackfill<AttachmentExtractionSearchConfigChunk>({
    name: ATTACHMENT_EXTRACTION_SEARCH_CONFIG_BACKFILL_NAME,
    plan,
    processChunk,
  })
}
