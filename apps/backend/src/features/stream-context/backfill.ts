import { AuthorTypes, MemoScopes, StreamTypes, type JSONContent, type MemoScope } from "@threa/types"
import { sql } from "../../db"
import { chunkIds, registerBackfill, type BackfillContext } from "../../lib/backfill"
import { streamContextItemId } from "../../lib/id"
import { resolveMemoScopeForStreamId } from "../memos"
import { contextRowsForMessage, contextSnippet } from "./extract"
import { StreamContextRepository } from "./repository"
import type { NewStreamContextItem } from "./types"

export const STREAM_CONTEXT_BACKFILL_NAME = "stream-context-index"

/** Top-level stream of `s` — a thread resolves to its root (INV-62). */
const TOP_LEVEL_STREAM_SQL = sql.raw(
  `CASE WHEN s.type = '${StreamTypes.THREAD}' THEN COALESCE(s.root_stream_id, s.id) ELSE s.id END`
)

interface StreamRef {
  streamId: string
  rootStreamId: string
}

export type StreamContextChunk =
  | ({ kind: "messages"; ids: string[] } & StreamRef)
  | ({ kind: "memos" } & StreamRef)
  | ({ kind: "delegations" } & StreamRef)
  | ({ kind: "threads" } & StreamRef)

interface MessageRow {
  id: string
  author_id: string | null
  created_at: Date
  sequence: string | number | bigint
  content_json: JSONContent | null
  content_markdown: string
  edited_at: Date | null
}

interface AttachmentRow {
  message_id: string
  attachment_id: string
  mime_type: string
}

interface MemoRow {
  id: string
  title: string
  knowledge_type: string
  source_message_ids: string[]
  scope: MemoScope
}

interface DelegationRow {
  id: string
  title: string
  created_by_kind: string
  created_by_id: string
  created_at: Date
}

interface ThreadRow {
  id: string
  parent_anchor_id: string
}

interface AnchorRow {
  id: string
  author_id: string | null
  created_at: Date
  sequence: string | number | bigint
  content_markdown: string
}

interface EventAnchorRow {
  id: string
  actor_id: string | null
  actor_type: string | null
  created_at: Date
  sequence: string | number | bigint
}

function toBigInt(value: string | number | bigint | null): bigint | null {
  return value === null ? null : BigInt(value)
}

/**
 * Sealed streams are skipped at plan time, so nothing E2E ever reaches
 * `processChunk` — the same rule the write path applies per hook.
 */
async function listIndexableStreams(ctx: BackfillContext, workspaceId: string): Promise<StreamRef[]> {
  const result = await ctx.pool.query<{ id: string; root_stream_id: string }>(sql`
    SELECT s.id, COALESCE(s.root_stream_id, s.id) AS root_stream_id
    FROM streams s
    WHERE s.workspace_id = ${workspaceId}
      AND NOT EXISTS (SELECT 1 FROM e2e_streams e WHERE e.stream_id = s.id)
    ORDER BY s.id
  `)
  return result.rows.map((row) => ({ streamId: row.id, rootStreamId: row.root_stream_id }))
}

export async function plan(ctx: BackfillContext, workspaceId: string): Promise<StreamContextChunk[]> {
  const streams = await listIndexableStreams(ctx, workspaceId)
  if (streams.length === 0) return []
  const streamIds = streams.map((s) => s.streamId)
  const rootByStream = new Map(streams.map((s) => [s.streamId, s.rootStreamId]))

  const messages = await ctx.pool.query<{ id: string; stream_id: string }>(sql`
    SELECT id, stream_id FROM messages
    WHERE workspace_id = ${workspaceId}
      AND stream_id = ANY(${streamIds})
      AND deleted_at IS NULL
    ORDER BY stream_id, id
  `)
  const idsByStream = new Map<string, string[]>()
  for (const row of messages.rows) {
    const ids = idsByStream.get(row.stream_id) ?? []
    ids.push(row.id)
    idsByStream.set(row.stream_id, ids)
  }

  // Memo landmarks live on the source messages' TOP-LEVEL stream, the same
  // stream the write path indexes to, so backfilled rows collide with live rows
  // on the identity index instead of duplicating them onto the thread.
  const memoStreams = await ctx.pool.query<{ stream_id: string }>(sql`
    SELECT DISTINCT ${TOP_LEVEL_STREAM_SQL} AS stream_id
    FROM memos mo
    JOIN messages m ON m.id = ANY(mo.source_message_ids)
    JOIN streams s ON s.id = m.stream_id AND s.workspace_id = ${workspaceId}
    WHERE mo.workspace_id = ${workspaceId}
      AND m.workspace_id = ${workspaceId}
      AND m.stream_id = ANY(${streamIds})
  `)
  const delegationStreams = await ctx.pool.query<{ stream_id: string }>(sql`
    SELECT DISTINCT stream_id FROM delegated_tasks
    WHERE workspace_id = ${workspaceId} AND stream_id = ANY(${streamIds})
  `)
  const threadParents = await ctx.pool.query<{ parent_stream_id: string }>(sql`
    SELECT DISTINCT parent_stream_id FROM streams
    WHERE workspace_id = ${workspaceId}
      AND parent_stream_id = ANY(${streamIds})
      AND parent_anchor_id IS NOT NULL
  `)

  const chunks: StreamContextChunk[] = []
  for (const stream of streams) {
    for (const ids of chunkIds(idsByStream.get(stream.streamId) ?? [])) {
      chunks.push({ kind: "messages", ...stream, ids })
    }
  }
  for (const row of memoStreams.rows) {
    // A thread's root can itself be sealed, and is then absent from `streams`.
    const rootStreamId = rootByStream.get(row.stream_id)
    if (rootStreamId === undefined) continue
    chunks.push({ kind: "memos", streamId: row.stream_id, rootStreamId })
  }
  for (const row of delegationStreams.rows) {
    chunks.push({ kind: "delegations", streamId: row.stream_id, rootStreamId: rootByStream.get(row.stream_id)! })
  }
  for (const row of threadParents.rows) {
    chunks.push({
      kind: "threads",
      streamId: row.parent_stream_id,
      rootStreamId: rootByStream.get(row.parent_stream_id)!,
    })
  }
  return chunks
}

/**
 * Same rows the create path writes, rebuilt from stored state: `occurredAt` is
 * the message's `created_at`, never the attachment's upload time.
 */
function messageChunkRows(
  chunk: StreamContextChunk & { kind: "messages" },
  workspaceId: string,
  messages: MessageRow[],
  attachments: AttachmentRow[]
): NewStreamContextItem[] {
  const attachmentsByMessage = new Map<string, Array<{ id: string; mimeType: string }>>()
  for (const row of attachments) {
    const list = attachmentsByMessage.get(row.message_id) ?? []
    list.push({ id: row.attachment_id, mimeType: row.mime_type })
    attachmentsByMessage.set(row.message_id, list)
  }

  return messages.flatMap((message) =>
    contextRowsForMessage({
      workspaceId,
      streamId: chunk.streamId,
      rootStreamId: chunk.rootStreamId,
      messageId: message.id,
      authorId: message.author_id,
      occurredAt: message.created_at,
      sequence: toBigInt(message.sequence),
      contentJson: message.content_json,
      contentMarkdown: message.content_markdown,
      attachments: attachmentsByMessage.get(message.id) ?? [],
    })
  )
}

/**
 * Mirrors `MemoService.indexCapturedMemos`: the landmark sits at the LATEST
 * source message's `created_at`, not the capture time (extraction is debounced).
 */
function memoChunkRows(
  chunk: StreamContextChunk & { kind: "memos" },
  workspaceId: string,
  memos: MemoRow[],
  sourceMessages: AnchorRow[]
): NewStreamContextItem[] {
  const byId = new Map(sourceMessages.map((m) => [m.id, m]))
  const rows: NewStreamContextItem[] = []
  for (const memo of memos) {
    const resolved = memo.source_message_ids
      .map((id) => byId.get(id))
      .filter((message): message is AnchorRow => message !== undefined)
    if (resolved.length === 0) continue
    const latest = resolved.reduce((a, b) => (b.created_at > a.created_at ? b : a))
    // First SURVIVING source, matching `MemoService.indexCapturedMemos`: the
    // delete hook unindexes by `source_message_id`, so the two paths must agree
    // on the anchor or they write different identity keys for the same memo.
    const anchorId = resolved[0]!.id
    rows.push({
      id: streamContextItemId(),
      workspaceId,
      streamId: chunk.streamId,
      rootStreamId: chunk.rootStreamId,
      category: "memo",
      refKind: "memo",
      refId: memo.id,
      groupKey: memo.id,
      sourceMessageId: anchorId,
      authorId: latest.author_id,
      occurredAt: latest.created_at,
      sequence: toBigInt(latest.sequence),
      snippet: contextSnippet(memo.title),
      detail: { title: memo.title, knowledgeType: memo.knowledge_type },
    })
  }
  return rows
}

function delegationChunkRows(
  chunk: StreamContextChunk & { kind: "delegations" },
  workspaceId: string,
  delegations: DelegationRow[]
): NewStreamContextItem[] {
  return delegations.map((task) => ({
    id: streamContextItemId(),
    workspaceId,
    streamId: chunk.streamId,
    rootStreamId: chunk.rootStreamId,
    category: "delegation" as const,
    refKind: "delegation" as const,
    refId: task.id,
    groupKey: task.id,
    sourceMessageId: null,
    authorId: task.created_by_kind === AuthorTypes.USER ? task.created_by_id : null,
    occurredAt: task.created_at,
    sequence: null,
    snippet: contextSnippet(task.title),
    detail: { title: task.title },
  }))
}

/**
 * Thread landmarks live on the PARENT stream, at the anchor's timestamp. Both
 * anchor kinds project, matching `StreamService.createThreadOn`: a card-anchored
 * thread carries no source message, so its row points at the thread alone.
 */
function threadChunkRows(
  chunk: StreamContextChunk & { kind: "threads" },
  workspaceId: string,
  threads: ThreadRow[],
  anchors: AnchorRow[],
  eventAnchors: EventAnchorRow[]
): NewStreamContextItem[] {
  const byId = new Map(anchors.map((m) => [m.id, m]))
  const eventById = new Map(eventAnchors.map((e) => [e.id, e]))
  const rows: NewStreamContextItem[] = []
  for (const thread of threads) {
    const base = {
      id: streamContextItemId(),
      workspaceId,
      streamId: chunk.streamId,
      rootStreamId: chunk.rootStreamId,
      category: "thread" as const,
      refKind: "thread" as const,
      refId: thread.id,
      groupKey: thread.id,
    }
    const anchor = byId.get(thread.parent_anchor_id)
    if (anchor) {
      rows.push({
        ...base,
        sourceMessageId: anchor.id,
        authorId: anchor.author_id,
        occurredAt: anchor.created_at,
        sequence: toBigInt(anchor.sequence),
        snippet: contextSnippet(anchor.content_markdown),
        detail: {},
      })
      continue
    }
    const eventAnchor = eventById.get(thread.parent_anchor_id)
    if (!eventAnchor) continue
    rows.push({
      ...base,
      sourceMessageId: null,
      authorId: eventAnchor.actor_type === AuthorTypes.USER ? eventAnchor.actor_id : null,
      occurredAt: eventAnchor.created_at,
      sequence: toBigInt(eventAnchor.sequence),
      snippet: "",
      detail: { anchorEventId: eventAnchor.id },
    })
  }
  return rows
}

async function loadAnchorEvents(ctx: BackfillContext, streamId: string, ids: string[]): Promise<EventAnchorRow[]> {
  if (ids.length === 0) return []
  const result = await ctx.pool.query<EventAnchorRow>(sql`
    SELECT id, actor_id, actor_type, created_at, sequence
    FROM stream_events
    WHERE stream_id = ${streamId} AND id = ANY(${ids})
  `)
  return result.rows
}

async function loadAnchorMessages(ctx: BackfillContext, workspaceId: string, ids: string[]): Promise<AnchorRow[]> {
  if (ids.length === 0) return []
  const result = await ctx.pool.query<AnchorRow>(sql`
    SELECT id, author_id, created_at, sequence, content_markdown
    FROM messages
    WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}) AND deleted_at IS NULL
  `)
  return result.rows
}

/**
 * The chunk's read and its insert are separate round trips, so an edit, delete
 * or move can commit in between: the live hook finds no rows to replace (none
 * exist yet for a pre-C1 message) and the backfill then writes rows built from
 * the pre-mutation snapshot, which nothing ever cleans up. Re-check the read
 * snapshot afterwards and drop exactly the rows this chunk inserted for the
 * messages that changed — the live hook's own rows are already correct.
 */
async function reconcileMessagesChunk(
  ctx: BackfillContext,
  workspaceId: string,
  chunk: StreamContextChunk & { kind: "messages" },
  snapshot: MessageRow[],
  rows: NewStreamContextItem[]
): Promise<number> {
  const current = await ctx.pool.query<{ id: string; edited_at: Date | null }>(sql`
    SELECT id, edited_at FROM messages
    WHERE workspace_id = ${workspaceId}
      AND id = ANY(${snapshot.map((message) => message.id)})
      AND stream_id = ${chunk.streamId}
      AND deleted_at IS NULL
  `)
  const editedById = new Map(current.rows.map((row) => [row.id, row.edited_at?.getTime() ?? null]))
  const stale = new Set(
    snapshot
      .filter((message) => {
        if (!editedById.has(message.id)) return true
        return editedById.get(message.id) !== (message.edited_at?.getTime() ?? null)
      })
      .map((message) => message.id)
  )
  if (stale.size === 0) return 0
  return StreamContextRepository.deleteByIds(
    ctx.pool,
    workspaceId,
    rows.filter((row) => row.sourceMessageId !== null && stale.has(row.sourceMessageId)).map((row) => row.id)
  )
}

async function processMessagesChunk(
  ctx: BackfillContext,
  workspaceId: string,
  chunk: StreamContextChunk & { kind: "messages" }
): Promise<number> {
  if (chunk.ids.length === 0) return 0
  const messages = await ctx.pool.query<MessageRow>(sql`
    SELECT id, author_id, created_at, sequence, content_json, content_markdown, edited_at
    FROM messages
    WHERE workspace_id = ${workspaceId}
      AND stream_id = ${chunk.streamId}
      AND id = ANY(${chunk.ids})
      AND deleted_at IS NULL
    ORDER BY id
  `)
  if (messages.rows.length === 0) return 0

  // Both attachment tracks: `attachments` bound to the message by upload, and
  // `attachment_references` for a body re-referencing an earlier upload.
  const attachments = await ctx.pool.query<AttachmentRow>(sql`
    SELECT DISTINCT ref.message_id, a.id AS attachment_id, a.mime_type
    FROM (
      SELECT id AS attachment_id, message_id FROM attachments
      WHERE workspace_id = ${workspaceId} AND message_id = ANY(${chunk.ids})
      UNION
      SELECT attachment_id, message_id FROM attachment_references
      WHERE workspace_id = ${workspaceId} AND message_id = ANY(${chunk.ids})
    ) ref
    JOIN attachments a ON a.id = ref.attachment_id AND a.workspace_id = ${workspaceId}
    ORDER BY ref.message_id, a.id
  `)

  const rows = messageChunkRows(chunk, workspaceId, messages.rows, attachments.rows)
  const inserted = await StreamContextRepository.insertMany(ctx.pool, rows)
  const removed = await reconcileMessagesChunk(ctx, workspaceId, chunk, messages.rows, rows)
  return Math.max(inserted - removed, 0)
}

async function processMemosChunk(
  ctx: BackfillContext,
  workspaceId: string,
  chunk: StreamContextChunk & { kind: "memos" }
): Promise<NewStreamContextItem[]> {
  const memos = await ctx.pool.query<MemoRow>(sql`
    SELECT DISTINCT mo.id, mo.title, mo.knowledge_type, mo.source_message_ids, mo.scope
    FROM memos mo
    JOIN messages m ON m.id = ANY(mo.source_message_ids)
    JOIN streams s ON s.id = m.stream_id AND s.workspace_id = ${workspaceId}
    WHERE mo.workspace_id = ${workspaceId}
      AND m.workspace_id = ${workspaceId}
      AND ${TOP_LEVEL_STREAM_SQL} = ${chunk.streamId}
  `)
  if (memos.rows.length === 0) return []

  // Same suppression `MemoService.saveMemo` applies: a `user`-scoped memo filed
  // into a stream whose own tier is wider would leak its title to every member
  // through the projection row, so it is never indexed there.
  const natural = await resolveMemoScopeForStreamId(ctx.pool, chunk.streamId)
  const indexable =
    natural.scope === MemoScopes.USER ? memos.rows : memos.rows.filter((memo) => memo.scope !== MemoScopes.USER)
  if (indexable.length === 0) return []

  const sourceIds = [...new Set(indexable.flatMap((memo) => memo.source_message_ids))]
  const sourceMessages = await loadAnchorMessages(ctx, workspaceId, sourceIds)
  return memoChunkRows(chunk, workspaceId, indexable, sourceMessages)
}

async function processDelegationsChunk(
  ctx: BackfillContext,
  workspaceId: string,
  chunk: StreamContextChunk & { kind: "delegations" }
): Promise<NewStreamContextItem[]> {
  const delegations = await ctx.pool.query<DelegationRow>(sql`
    SELECT id, title, created_by_kind, created_by_id, created_at
    FROM delegated_tasks
    WHERE workspace_id = ${workspaceId} AND stream_id = ${chunk.streamId}
    ORDER BY id
  `)
  return delegationChunkRows(chunk, workspaceId, delegations.rows)
}

async function processThreadsChunk(
  ctx: BackfillContext,
  workspaceId: string,
  chunk: StreamContextChunk & { kind: "threads" }
): Promise<NewStreamContextItem[]> {
  const threads = await ctx.pool.query<ThreadRow>(sql`
    SELECT id, parent_anchor_id
    FROM streams
    WHERE workspace_id = ${workspaceId}
      AND parent_stream_id = ${chunk.streamId}
      AND parent_anchor_id IS NOT NULL
    ORDER BY id
  `)
  if (threads.rows.length === 0) return []
  const anchorIds = threads.rows.map((thread) => thread.parent_anchor_id)
  const [anchors, eventAnchors] = await Promise.all([
    loadAnchorMessages(
      ctx,
      workspaceId,
      anchorIds.filter((id) => id.startsWith("msg_"))
    ),
    loadAnchorEvents(
      ctx,
      chunk.streamId,
      anchorIds.filter((id) => id.startsWith("event_"))
    ),
  ])
  return threadChunkRows(chunk, workspaceId, threads.rows, anchors, eventAnchors)
}

export async function processChunk(
  ctx: BackfillContext,
  workspaceId: string,
  chunk: StreamContextChunk
): Promise<{ processed: number }> {
  if (chunk.kind === "messages") {
    return { processed: await processMessagesChunk(ctx, workspaceId, chunk) }
  }
  let rows: NewStreamContextItem[]
  switch (chunk.kind) {
    case "memos":
      rows = await processMemosChunk(ctx, workspaceId, chunk)
      break
    case "delegations":
      rows = await processDelegationsChunk(ctx, workspaceId, chunk)
      break
    case "threads":
      rows = await processThreadsChunk(ctx, workspaceId, chunk)
      break
  }
  // `insertMany` is ON CONFLICT DO NOTHING on the identity index, so a re-run
  // inserts nothing and `processed` reports only genuinely new rows.
  return { processed: await StreamContextRepository.insertMany(ctx.pool, rows) }
}

export function registerStreamContextBackfill(): void {
  registerBackfill<StreamContextChunk>({ name: STREAM_CONTEXT_BACKFILL_NAME, plan, processChunk })
}
