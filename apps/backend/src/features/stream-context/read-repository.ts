import type {
  LinkPreviewContentType,
  LinkPreviewStatus,
  RichLinkPreviewType,
  ContextCategory,
  StreamContextRefKind,
  StreamContextItem,
  StreamContextItemDetail,
  StreamContextScope,
} from "@threa/types"
import { CONTEXT_CATEGORIES, streamContextItemKey } from "@threa/types"
import { composeSql, sql, type Querier } from "../../db"

export interface StreamContextFeedFilters {
  workspaceId: string
  rootStreamId: string
  streamId: string
  scope: StreamContextScope
  category?: ContextCategory
  queryText?: string
  authorId?: string
  /** Exclusive upper bound on `occurred_at`. */
  before?: Date
  /** Inclusive lower bound on `occurred_at`. */
  after?: Date
}

export interface StreamContextCursor {
  occurredAt: Date
  id: string
}

export interface ListFeedParams extends StreamContextFeedFilters {
  cursor?: StreamContextCursor
  limit: number
}

export interface ListOccurrencesParams extends StreamContextFeedFilters {
  category: ContextCategory
  groupKey: string
  cursor?: StreamContextCursor
  limit: number
}

export interface StreamContextFeedRow extends StreamContextItem {
  /** Keyset position — the cursor is built from this, never from `occurredAt`'s string form. */
  cursorOccurredAt: Date
  id: string
}

interface DbRow {
  id: string
  stream_id: string
  category: string
  ref_kind: string
  ref_id: string
  group_key: string
  source_message_id: string | null
  author_id: string | null
  occurred_at: Date
  sequence: string | null
  snippet: string
  detail: Record<string, unknown>
  occurrence_count: number
  link_url: string | null
  link_title: string | null
  link_description: string | null
  link_site_name: string | null
  link_favicon_url: string | null
  link_image_url: string | null
  link_preview_type: RichLinkPreviewType | null
  link_content_type: LinkPreviewContentType | null
  link_status: LinkPreviewStatus | null
  attachment_id: string | null
  attachment_filename: string | null
  attachment_mime_type: string | null
  attachment_size_bytes: string | null
  attachment_width: number | null
  attachment_height: number | null
  memo_title: string | null
  memo_knowledge_type: string | null
  task_title: string | null
  task_status: string | null
  task_claimed_by_label: string | null
  task_status_note: string | null
  task_result_message_id: string | null
  thread_name: string | null
  thread_reply_count: number | null
  thread_last_reply_at: Date | null
  thread_anchor_event_id: string | null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null
}

function detailFor(row: DbRow): StreamContextItemDetail {
  switch (row.category as ContextCategory) {
    case "link":
      return {
        url: row.link_url ?? stringOrNull(row.detail.url) ?? row.ref_id,
        title: row.link_title,
        description: row.link_description,
        siteName: row.link_site_name,
        faviconUrl: row.link_favicon_url,
        imageUrl: row.link_image_url,
        previewType: row.link_preview_type,
        contentType: row.link_content_type,
        previewStatus: row.link_status,
      }
    case "media":
    case "file":
      return {
        attachmentId: row.attachment_id,
        filename: row.attachment_filename,
        mimeType: row.attachment_mime_type,
        sizeBytes: row.attachment_size_bytes === null ? null : Number(row.attachment_size_bytes),
        width: row.attachment_width ?? numberOrNull(row.detail.width),
        height: row.attachment_height ?? numberOrNull(row.detail.height),
        mediaKind: stringOrNull(row.detail.mediaKind) ?? (row.ref_kind === "giphy" ? "gif" : null),
        giphyUrl: stringOrNull(row.detail.giphyUrl),
        giphyTitle: stringOrNull(row.detail.title),
      }
    case "memo":
      return { title: row.memo_title, knowledgeType: row.memo_knowledge_type }
    case "delegation":
      return {
        title: row.task_title,
        status: row.task_status,
        claimedByLabel: row.task_claimed_by_label,
        statusNote: row.task_status_note,
        resultMessageId: row.task_result_message_id,
      }
    case "thread":
      return {
        name: row.thread_name,
        replyCount: row.thread_reply_count ?? 0,
        lastReplyAt: row.thread_last_reply_at?.toISOString() ?? null,
        anchorEventId: row.thread_anchor_event_id,
      }
  }
}

function mapRow(row: DbRow): StreamContextFeedRow {
  const category = row.category as ContextCategory
  return {
    key: streamContextItemKey({ category, refId: row.ref_id, sourceMessageId: row.source_message_id }),
    category,
    refKind: row.ref_kind as StreamContextRefKind,
    refId: row.ref_id,
    groupKey: row.group_key,
    streamId: row.stream_id,
    sourceMessageId: row.source_message_id,
    authorId: row.author_id,
    occurredAt: row.occurred_at.toISOString(),
    sequence: row.sequence === null ? null : String(row.sequence),
    snippet: row.snippet,
    occurrenceCount: row.occurrence_count,
    detail: detailFor(row),
    cursorOccurredAt: row.occurred_at,
    id: row.id,
  }
}

const EPOCH = new Date(0)

/**
 * Scope + filters + the live display joins, as one fragment. Every read path
 * (feed, counts, occurrences) starts from this so a filter can never apply on
 * one and silently not on another — the free-text predicate reaches into the
 * joined columns, so the joins have to precede the filters, and the collapse
 * has to follow both.
 */
function scopedSql(filters: StreamContextFeedFilters, extra?: { groupKey?: string }) {
  const isTree = filters.scope === "tree"
  const queryText = filters.queryText?.trim()
  const hasQuery = Boolean(queryText)
  const likePattern = `%${(queryText ?? "").replace(/[\\%_]/g, "\\$&")}%`

  return sql`
    SELECT
      sci.id,
      sci.stream_id,
      sci.category,
      sci.ref_kind,
      sci.ref_id,
      sci.group_key,
      sci.source_message_id,
      sci.author_id,
      sci.occurred_at,
      sci.sequence,
      sci.snippet,
      sci.detail,
      lp.url AS link_url,
      lp.title AS link_title,
      lp.description AS link_description,
      lp.site_name AS link_site_name,
      lp.favicon_url AS link_favicon_url,
      lp.image_url AS link_image_url,
      lp.preview_type AS link_preview_type,
      lp.content_type AS link_content_type,
      lp.status AS link_status,
      att.id AS attachment_id,
      att.filename AS attachment_filename,
      att.mime_type AS attachment_mime_type,
      att.size_bytes AS attachment_size_bytes,
      att.width AS attachment_width,
      att.height AS attachment_height,
      mem.title AS memo_title,
      mem.knowledge_type AS memo_knowledge_type,
      dt.title AS task_title,
      dt.status AS task_status,
      dt.claimed_by_label AS task_claimed_by_label,
      dt.status_note AS task_status_note,
      dt.result_message_id AS task_result_message_id,
      th.display_name AS thread_name,
      th.reply_count AS thread_reply_count,
      th.last_reply_at AS thread_last_reply_at,
      th.parent_anchor_id AS thread_anchor_event_id
    FROM stream_context_items sci
    LEFT JOIN link_previews lp
      ON sci.category = 'link'
     AND lp.workspace_id = sci.workspace_id
     AND lp.normalized_url = sci.group_key
    LEFT JOIN attachments att
      ON sci.ref_kind = 'attachment'
     AND att.workspace_id = sci.workspace_id
     AND att.id = sci.ref_id
    LEFT JOIN memos mem
      ON sci.category = 'memo'
     AND mem.workspace_id = sci.workspace_id
     AND mem.id = sci.ref_id
    LEFT JOIN delegated_tasks dt
      ON sci.category = 'delegation'
     AND dt.workspace_id = sci.workspace_id
     AND dt.id = sci.ref_id
    LEFT JOIN streams th
      ON sci.category = 'thread'
     AND th.workspace_id = sci.workspace_id
     AND th.id = sci.ref_id
    WHERE sci.workspace_id = ${filters.workspaceId}
      AND (
        (${isTree} AND sci.root_stream_id = ${filters.rootStreamId})
        OR (${!isTree} AND sci.stream_id = ${filters.streamId})
      )
      AND (${filters.category === undefined} OR sci.category = ${filters.category ?? ""})
      AND (${extra?.groupKey === undefined} OR sci.group_key = ${extra?.groupKey ?? ""})
      AND (${filters.authorId === undefined} OR sci.author_id = ${filters.authorId ?? ""})
      AND (${filters.before === undefined} OR sci.occurred_at < ${filters.before ?? EPOCH}::timestamptz)
      AND (${filters.after === undefined} OR sci.occurred_at >= ${filters.after ?? EPOCH}::timestamptz)
      AND (
        ${!hasQuery}
        OR sci.ref_id ILIKE ${likePattern}
        OR lp.title ILIKE ${likePattern}
        OR lp.site_name ILIKE ${likePattern}
        OR lp.url ILIKE ${likePattern}
        OR att.filename ILIKE ${likePattern}
        OR mem.title ILIKE ${likePattern}
        OR dt.title ILIKE ${likePattern}
        OR th.display_name ILIKE ${likePattern}
      )
  `
}

export const StreamContextReadRepository = {
  /**
   * Collapsed feed: one row per (category, group_key), the newest occurrence,
   * carrying how many occurrences it stands for. Filters run inside `scoped`,
   * before the collapse and before the keyset, so a cursor is only ever valid
   * for the filter set that produced it.
   */
  async listFeed(db: Querier, params: ListFeedParams): Promise<StreamContextFeedRow[]> {
    const scoped = scopedSql(params)
    const cursor = params.cursor
    const result = await db.query<DbRow>(composeSql`
      WITH scoped AS (${scoped}),
      grouped AS (
        SELECT
          scoped.*,
          ROW_NUMBER() OVER (PARTITION BY category, group_key ORDER BY occurred_at DESC, id DESC) AS rn,
          COUNT(*) OVER (PARTITION BY category, group_key)::int AS occurrence_count
        FROM scoped
      )
      SELECT * FROM grouped
      WHERE rn = 1
        AND (
          ${cursor === undefined}
          OR (occurred_at, id) < (${cursor?.occurredAt ?? EPOCH}::timestamptz, ${cursor?.id ?? ""}::text)
        )
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${params.limit}
    `)
    return result.rows.map(mapRow)
  },

  /** Whole-scope counts over the collapsed set — distinct artifacts, not occurrences. */
  async countsByCategory(db: Querier, filters: StreamContextFeedFilters): Promise<Record<ContextCategory, number>> {
    const scoped = scopedSql(filters)
    const result = await db.query<{ category: string; count: number }>(composeSql`
      WITH scoped AS (${scoped})
      SELECT category, COUNT(DISTINCT group_key)::int AS count
      FROM scoped
      GROUP BY category
    `)

    const counts = Object.fromEntries(CONTEXT_CATEGORIES.map((c) => [c, 0])) as Record<ContextCategory, number>
    for (const row of result.rows) {
      if ((CONTEXT_CATEGORIES as readonly string[]).includes(row.category)) {
        counts[row.category as ContextCategory] = row.count
      }
    }
    return counts
  },

  /** The uncollapsed occurrences of one artifact, same ordering and same live joins. */
  async listOccurrences(db: Querier, params: ListOccurrencesParams): Promise<StreamContextFeedRow[]> {
    // Same filters as the feed: `occurrenceCount` is counted over the filtered
    // set, so an expansion that ignored them would return more rows than the
    // number the user clicked.
    const scoped = scopedSql({ ...params, category: params.category }, { groupKey: params.groupKey })
    const cursor = params.cursor
    const result = await db.query<DbRow>(composeSql`
      WITH scoped AS (${scoped})
      SELECT scoped.*, 1 AS occurrence_count
      FROM scoped
      WHERE (
        ${cursor === undefined}
        OR (occurred_at, id) < (${cursor?.occurredAt ?? EPOCH}::timestamptz, ${cursor?.id ?? ""}::text)
      )
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${params.limit}
    `)
    return result.rows.map(mapRow)
  },
}
