import type { ContentRange, JSONContent } from "@threahq/types"

import { sql } from "../../../db"
import { chunkIds, registerBackfill, type BackfillContext } from "../../../lib/backfill"
import { deriveContentMarkdown } from "../content"
import { MessageRepository, type Message } from "../repository"
import { MessageVersionRepository, type MessageVersion } from "../version-repository"

import { locateSnippetRange } from "./locate"
import { sliceReferenceContent } from "./slice"

export const MESSAGE_REFERENCE_PINS_BACKFILL_NAME = "message-reference-pins"

/**
 * Tables holding ProseMirror `contentJson` that may carry quote/share nodes
 * written before the server pinned references to a revision and range. Same
 * set and same scoping as the mention backfill: `message_versions` scopes (and
 * skips E2E) through its parent `messages` row, the others carry their own
 * `workspace_id` and exclude E2E by `e2e_version IS NULL` (messages) or by
 * `content_json IS NULL` (drafts null it when sealed).
 */
type BackfillTable = "messages" | "message_versions" | "scheduled_messages" | "drafts"

interface ReferencePinsChunk {
  table: BackfillTable
  ids: string[]
}

interface ContentRow {
  id: string
  content_json: JSONContent
  created_at: Date
}

function listIdsQuery(table: BackfillTable, workspaceId: string) {
  switch (table) {
    case "messages":
      return sql`
        SELECT id FROM messages
        WHERE stream_id IN (SELECT id FROM streams WHERE workspace_id = ${workspaceId})
          AND content_json IS NOT NULL AND e2e_version IS NULL
        ORDER BY id
      `
    case "message_versions":
      return sql`
        SELECT v.id FROM message_versions v
        JOIN messages m ON m.id = v.message_id
        JOIN streams s ON s.id = m.stream_id
        WHERE s.workspace_id = ${workspaceId} AND m.e2e_version IS NULL AND v.content_json IS NOT NULL
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
      SELECT v.id, v.content_json, v.created_at FROM message_versions v
      JOIN messages m ON m.id = v.message_id
      JOIN streams s ON s.id = m.stream_id
      WHERE s.workspace_id = ${workspaceId} AND v.id = ANY(${ids}) AND v.content_json IS NOT NULL
    `
  }
  if (table === "messages") {
    return sql`
      SELECT id, content_json, created_at FROM messages
      WHERE id = ANY(${ids})
        AND content_json IS NOT NULL
        AND stream_id IN (SELECT id FROM streams WHERE workspace_id = ${workspaceId})
    `
  }
  return sql`
    SELECT id, content_json, created_at FROM ${sql.raw(table)}
    WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}) AND content_json IS NOT NULL
  `
}

interface UnpinnedNode {
  node: JSONContent
  attrs: Record<string, unknown>
  messageId: string
  isQuote: boolean
}

/** Quote and share nodes that predate pinning — `version` still absent or null. */
function collectUnpinnedNodes(root: JSONContent): UnpinnedNode[] {
  const found: UnpinnedNode[] = []
  const walk = (node: JSONContent): void => {
    if (node.type === "quoteReply" || node.type === "sharedMessage") {
      const attrs = (node.attrs ?? {}) as Record<string, unknown>
      const messageId = attrs.messageId
      if (typeof messageId === "string" && messageId.length > 0 && (attrs.version ?? null) === null) {
        found.push({ node, attrs, messageId, isQuote: node.type === "quoteReply" })
      }
    }
    for (const child of node.content ?? []) walk(child)
  }
  walk(root)
  return found
}

/**
 * Revisions to try a legacy quote's snippet against, best guess first: the one
 * that was live when the quoting row was written, then the rest newest to
 * oldest. `message_versions.created_at` is the moment that snapshot was
 * SUPERSEDED, so the live revision at time `t` is the oldest snapshot that
 * outlived `t` — and the current revision when none did.
 */
function candidateVersions(revision: number, versions: readonly MessageVersion[], at: Date): number[] {
  let live = revision
  for (const version of versions) {
    if (version.versionNumber < revision && version.createdAt.getTime() > at.getTime()) {
      live = version.versionNumber
      break
    }
  }
  const ordered = [live]
  for (let candidate = revision; candidate >= 1; candidate--) {
    if (candidate !== live) ordered.push(candidate)
  }
  return ordered
}

function contentForVersion(source: Message, versions: readonly MessageVersion[], version: number): JSONContent | null {
  if (version === source.revision) return source.contentJson
  return versions.find((row) => row.versionNumber === version)?.contentJson ?? null
}

interface QuotePin {
  version: number
  range: ContentRange | null
  snippet: string
}

/**
 * The revision a legacy quote was taken from, found by locating its stored
 * snippet in each candidate revision. `null` when no revision contains the
 * snippet — the node then stays unpinned rather than being pinned to a body it
 * never quoted.
 */
function findQuotePin(
  source: Message,
  versions: readonly MessageVersion[],
  snippet: unknown,
  rowCreatedAt: Date
): QuotePin | null {
  for (const version of candidateVersions(source.revision, versions, rowCreatedAt)) {
    const doc = contentForVersion(source, versions, version)
    if (!doc) continue
    const located = locateSnippetRange(doc, snippet)
    if (!located) continue
    return { version, range: located.range, snippet: sliceReferenceContent(doc, located.range).contentMarkdown }
  }
  return null
}

function pinReferenceRows(
  rows: readonly ContentRow[],
  sourcesById: ReadonlyMap<string, Message>,
  versionsByMessageId: ReadonlyMap<string, MessageVersion[]>
): Array<{ id: string; contentJson: JSONContent; contentMarkdown: string }> {
  const updates: Array<{ id: string; contentJson: JSONContent; contentMarkdown: string }> = []
  for (const row of rows) {
    const contentJson = structuredClone(row.content_json)
    let changed = false
    for (const reference of collectUnpinnedNodes(contentJson)) {
      const source = sourcesById.get(reference.messageId)
      if (!source) continue
      const versions = versionsByMessageId.get(reference.messageId) ?? []

      if (!reference.isQuote) {
        reference.node.attrs = { ...reference.attrs, version: source.revision, range: null }
        changed = true
        continue
      }

      const pin = findQuotePin(source, versions, reference.attrs.snippet, row.created_at)
      if (!pin) continue
      reference.node.attrs = { ...reference.attrs, version: pin.version, range: pin.range, snippet: pin.snippet }
      changed = true
    }
    if (changed) updates.push({ id: row.id, contentJson, contentMarkdown: deriveContentMarkdown(contentJson) })
  }
  return updates
}

async function plan(ctx: BackfillContext, workspaceId: string): Promise<ReferencePinsChunk[]> {
  const tables: BackfillTable[] = ["messages", "message_versions", "scheduled_messages", "drafts"]
  const chunks: ReferencePinsChunk[] = []
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
  chunk: ReferencePinsChunk
): Promise<{ processed: number }> {
  const { table, ids } = chunk
  if (ids.length === 0) return { processed: 0 }

  const result = await ctx.pool.query<ContentRow>(selectRowsQuery(table, workspaceId, ids))
  const rows = result.rows
  if (rows.length === 0) return { processed: 0 }

  const sourceIds = new Set<string>()
  const quotedSourceIds = new Set<string>()
  for (const row of rows) {
    for (const reference of collectUnpinnedNodes(row.content_json)) {
      sourceIds.add(reference.messageId)
      if (reference.isQuote) quotedSourceIds.add(reference.messageId)
    }
  }
  if (sourceIds.size === 0) return { processed: 0 }

  const sourcesById = await MessageRepository.findByIdsInWorkspace(ctx.pool, workspaceId, [...sourceIds])
  // Ids come out of stored content, so they are whatever an author once wrote.
  // `sourcesById` is already workspace-resolved; anything it does not name is
  // not this workspace's to read (INV-8).
  const versionsByMessageId = await MessageVersionRepository.findByMessageIds(
    ctx.pool,
    [...quotedSourceIds].filter((id) => sourcesById.has(id))
  )

  const observedById = new Map(rows.map((row) => [row.id, JSON.stringify(row.content_json)]))
  const updates = pinReferenceRows(rows, sourcesById, versionsByMessageId)
  if (updates.length === 0) return { processed: 0 }

  const updateIds = updates.map((u) => u.id)
  const updateJson = updates.map((u) => JSON.stringify(u.contentJson))
  const updateMarkdown = updates.map((u) => u.contentMarkdown)
  const observedJson = updates.map((u) => observedById.get(u.id) ?? "")
  // The body was read in a separate statement, so the write has to prove it is
  // replacing what it read (INV-20) — an author editing in between would
  // otherwise have their new text overwritten with the old. A row that moved
  // stays unpinned and the next run pins it, since pinning is idempotent.
  const written = await ctx.pool.query(sql`
    UPDATE ${sql.raw(table)} AS t
    SET content_json = data.content_json::jsonb, content_markdown = data.content_markdown
    FROM unnest(${updateIds}::text[], ${updateJson}::text[], ${updateMarkdown}::text[], ${observedJson}::text[])
      AS data(id, content_json, content_markdown, observed_content_json)
    WHERE t.id = data.id AND t.content_json = data.observed_content_json::jsonb
  `)

  return { processed: written.rowCount ?? 0 }
}

export function registerMessageReferencePinsBackfill(): void {
  registerBackfill<ReferencePinsChunk>({ name: MESSAGE_REFERENCE_PINS_BACKFILL_NAME, plan, processChunk })
}
