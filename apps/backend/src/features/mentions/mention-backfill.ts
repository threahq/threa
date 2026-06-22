import type { JSONContent } from "@threa/types"
import { collectUnresolvedChannelLinkSlugs, collectUnresolvedMentionSlugs } from "@threa/prosemirror"
import { sql } from "../../db"
import { registerBackfill, type BackfillContext } from "../../lib/backfill"
// Barrel import (INV-52). The messaging barrel exports `deriveContentMarkdown`
// before `EventService`, so this resolves cleanly despite the messaging↔mentions
// cycle (event-service imports this feature's resolver) — the binding is only
// used at runtime inside `processChunk`, never at module init.
import { deriveContentMarkdown } from "../messaging"
import { applyMentionResolution, buildMentionResolutionMaps, type MentionResolutionMaps } from "./resolution"

export const MENTION_BACKFILL_NAME = "mention-actor-refs"

const CHUNK_SIZE = 500

/**
 * Tables holding ProseMirror `contentJson` that may carry unresolved mention /
 * channelLink ids (INV-64). Each entry knows how to list its candidate ids and
 * how to read/write a row's `content_json`.
 *
 * `message_versions` has no `workspace_id` of its own, so it scopes (and skips
 * E2E) through its parent `messages` row. The other tables carry their own
 * `workspace_id`; E2E rows are excluded by `e2e_version IS NULL` (messages) or
 * by `content_json IS NULL` (drafts null it when sealed). `scheduled_messages`
 * has no E2E variant, so `content_json` is always plaintext there.
 */
type BackfillTable = "messages" | "message_versions" | "scheduled_messages" | "drafts"

interface MentionBackfillChunk {
  table: BackfillTable
  ids: string[]
}

interface ContentRow {
  id: string
  content_json: JSONContent
}

function listIdsQuery(table: BackfillTable, workspaceId: string) {
  switch (table) {
    case "messages":
      return sql`
        SELECT id FROM messages
        WHERE workspace_id = ${workspaceId} AND content_json IS NOT NULL AND e2e_version IS NULL
        ORDER BY id
      `
    case "message_versions":
      return sql`
        SELECT v.id FROM message_versions v
        JOIN messages m ON m.id = v.message_id
        WHERE m.workspace_id = ${workspaceId} AND m.e2e_version IS NULL AND v.content_json IS NOT NULL
        ORDER BY v.id
      `
    case "scheduled_messages":
      return sql`
        SELECT id FROM scheduled_messages
        WHERE workspace_id = ${workspaceId} AND content_json IS NOT NULL
        ORDER BY id
      `
    case "drafts":
      return sql`
        SELECT id FROM drafts
        WHERE workspace_id = ${workspaceId} AND content_json IS NOT NULL
        ORDER BY id
      `
  }
}

function selectRowsQuery(table: BackfillTable, workspaceId: string, ids: string[]) {
  if (table === "message_versions") {
    return sql`
      SELECT v.id, v.content_json FROM message_versions v
      JOIN messages m ON m.id = v.message_id
      WHERE m.workspace_id = ${workspaceId} AND v.id = ANY(${ids}) AND v.content_json IS NOT NULL
    `
  }
  return sql`
    SELECT id, content_json FROM ${sql.raw(table)}
    WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}) AND content_json IS NOT NULL
  `
}

/**
 * Pure per-batch rewrite: gather the resolution result for every row using the
 * prebuilt maps and return only the rows that actually changed. Factored out so
 * the rewrite logic is testable without a database.
 */
export function resolveContentRows(
  rows: ContentRow[],
  maps: MentionResolutionMaps
): Array<{ id: string; contentJson: JSONContent; contentMarkdown: string }> {
  const updates: Array<{ id: string; contentJson: JSONContent; contentMarkdown: string }> = []
  for (const row of rows) {
    const { contentJson, changed } = applyMentionResolution(row.content_json, maps)
    // Re-derive markdown so the stored wire form (`[@slug](user:usr_x)`) stays
    // consistent with the rewritten JSON — the id now rides on the markdown too.
    if (changed) updates.push({ id: row.id, contentJson, contentMarkdown: deriveContentMarkdown(contentJson) })
  }
  return updates
}

export function chunkIds(ids: string[], size: number = CHUNK_SIZE): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size))
  }
  return chunks
}

async function plan(ctx: BackfillContext, workspaceId: string): Promise<MentionBackfillChunk[]> {
  const tables: BackfillTable[] = ["messages", "message_versions", "scheduled_messages", "drafts"]
  const chunks: MentionBackfillChunk[] = []
  for (const table of tables) {
    const result = await ctx.pool.query<{ id: string }>(listIdsQuery(table, workspaceId))
    const ids = result.rows.map((r) => r.id)
    for (const slice of chunkIds(ids)) {
      chunks.push({ table, ids: slice })
    }
  }
  return chunks
}

async function processChunk(
  ctx: BackfillContext,
  workspaceId: string,
  chunk: MentionBackfillChunk
): Promise<{ processed: number }> {
  const { table, ids } = chunk
  if (ids.length === 0) return { processed: 0 }

  const result = await ctx.pool.query<ContentRow>(selectRowsQuery(table, workspaceId, ids))
  const rows = result.rows
  if (rows.length === 0) return { processed: 0 }

  const mentionSlugs = new Set<string>()
  const channelSlugs = new Set<string>()
  for (const row of rows) {
    for (const slug of collectUnresolvedMentionSlugs(row.content_json)) mentionSlugs.add(slug)
    for (const slug of collectUnresolvedChannelLinkSlugs(row.content_json)) channelSlugs.add(slug)
  }

  const maps = await buildMentionResolutionMaps(ctx.pool, workspaceId, {
    mentionSlugs: [...mentionSlugs],
    channelSlugs: [...channelSlugs],
  })

  const updates = resolveContentRows(rows, maps)
  if (updates.length > 0) {
    // One set-based UPDATE per chunk (INV-56) instead of a round-trip per row:
    // unnest the parallel id / content arrays and join them back onto the table.
    const updateIds = updates.map((u) => u.id)
    const updateJson = updates.map((u) => JSON.stringify(u.contentJson))
    const updateMarkdown = updates.map((u) => u.contentMarkdown)
    await ctx.pool.query(sql`
      UPDATE ${sql.raw(table)} AS t
      SET content_json = data.content_json::jsonb, content_markdown = data.content_markdown
      FROM unnest(${updateIds}::text[], ${updateJson}::text[], ${updateMarkdown}::text[])
        AS data(id, content_json, content_markdown)
      WHERE t.id = data.id
    `)
  }

  return { processed: updates.length }
}

export function registerMentionBackfill(): void {
  registerBackfill<MentionBackfillChunk>({ name: MENTION_BACKFILL_NAME, plan, processChunk })
}

registerMentionBackfill()
