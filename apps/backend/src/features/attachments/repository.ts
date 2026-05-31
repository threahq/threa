import { sql, type Querier } from "../../db"
import {
  AttachmentSafetyStatuses,
  ProcessingStatuses,
  Visibilities,
  mimePrefixesForCategory,
  type StorageProvider,
  type ProcessingStatus,
  type ExtractionContentType,
  type AttachmentSafetyStatus,
  type AttachmentCategory,
} from "@threa/types"

// Internal row type (snake_case, not exported)
interface AttachmentRow {
  id: string
  workspace_id: string
  stream_id: string | null
  message_id: string | null
  uploaded_by: string | null
  filename: string
  mime_type: string
  size_bytes: string
  storage_provider: string
  storage_path: string
  processing_status: string
  safety_status: string
  e2e_only: boolean
  thumbnail_storage_path: string | null
  width: number | null
  height: number | null
  created_at: Date
}

// Domain type (camelCase, exported)
export interface Attachment {
  id: string
  workspaceId: string
  streamId: string | null
  messageId: string | null
  uploadedBy: string | null
  filename: string
  mimeType: string
  sizeBytes: number
  storageProvider: StorageProvider
  storagePath: string
  processingStatus: ProcessingStatus
  safetyStatus: AttachmentSafetyStatus
  /**
   * True when the S3 bytes are client-side ciphertext (E2E scratchpad). The
   * server never holds the key or the real filename/mime — those ride in the
   * SSK-sealed message payload. Gates scan + processor skip.
   */
  e2eOnly: boolean
  /** S3 key of the resized WebP thumbnail (images only; null until the worker runs) */
  thumbnailStoragePath: string | null
  /** Orientation-corrected intrinsic pixel dimensions (images only; null otherwise) */
  width: number | null
  height: number | null
  createdAt: Date
}

export interface InsertAttachmentParams {
  id: string
  workspaceId: string
  streamId?: string
  uploadedBy: string
  filename: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  storageProvider?: StorageProvider
  safetyStatus?: AttachmentSafetyStatus
  processingStatus?: ProcessingStatus
  e2eOnly?: boolean
}

// Row type for attachments with extraction joined
interface AttachmentWithExtractionRow extends AttachmentRow {
  extraction_content_type: string | null
  extraction_summary: string | null
  extraction_full_text: string | null
}

// Domain type for attachment with extraction
export interface AttachmentWithExtraction extends Attachment {
  extraction: {
    contentType: ExtractionContentType
    summary: string
    fullText: string | null
  } | null
}

function mapRowToAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    messageId: row.message_id,
    uploadedBy: row.uploaded_by,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    storageProvider: row.storage_provider as StorageProvider,
    storagePath: row.storage_path,
    processingStatus: row.processing_status as ProcessingStatus,
    safetyStatus: row.safety_status as AttachmentSafetyStatus,
    e2eOnly: row.e2e_only,
    thumbnailStoragePath: row.thumbnail_storage_path ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    createdAt: row.created_at,
  }
}

function mapRowToAttachmentWithExtraction(row: AttachmentWithExtractionRow): AttachmentWithExtraction {
  return {
    ...mapRowToAttachment(row),
    extraction: row.extraction_content_type
      ? {
          contentType: row.extraction_content_type as ExtractionContentType,
          summary: row.extraction_summary ?? "",
          fullText: row.extraction_full_text,
        }
      : null,
  }
}

const SELECT_FIELDS = `
  id, workspace_id, stream_id, message_id, uploaded_by,
  filename, mime_type, size_bytes,
  storage_provider, storage_path, processing_status, safety_status, e2e_only,
  thumbnail_storage_path, width, height,
  created_at
`

export const AttachmentRepository = {
  async findById(client: Querier, id: string): Promise<Attachment | null> {
    const result = await client.query<AttachmentRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM attachments WHERE id = ${id}`
    )
    return result.rows[0] ? mapRowToAttachment(result.rows[0]) : null
  },

  async findByIds(client: Querier, ids: string[]): Promise<Attachment[]> {
    if (ids.length === 0) return []
    const result = await client.query<AttachmentRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM attachments WHERE id = ANY(${ids})`
    )
    return result.rows.map(mapRowToAttachment)
  },

  async findByMessageId(client: Querier, messageId: string): Promise<Attachment[]> {
    const result = await client.query<AttachmentRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM attachments WHERE message_id = ${messageId}`
    )
    return result.rows.map(mapRowToAttachment)
  },

  async findByMessageIds(client: Querier, messageIds: string[]): Promise<Map<string, Attachment[]>> {
    if (messageIds.length === 0) return new Map()
    const result = await client.query<AttachmentRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM attachments WHERE message_id = ANY(${messageIds})`
    )

    const byMessage = new Map<string, Attachment[]>()
    for (const row of result.rows) {
      if (!row.message_id) continue
      const existing = byMessage.get(row.message_id) ?? []
      existing.push(mapRowToAttachment(row))
      byMessage.set(row.message_id, existing)
    }
    return byMessage
  },

  async findByIdForUpdate(client: Querier, id: string): Promise<Attachment | null> {
    const result = await client.query<AttachmentRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM attachments WHERE id = ${id} FOR UPDATE`
    )
    return result.rows[0] ? mapRowToAttachment(result.rows[0]) : null
  },

  /**
   * Find attachments with their extractions for a list of message IDs.
   * Returns a map from message ID to attachments with extraction data.
   */
  async findByMessageIdsWithExtractions(
    client: Querier,
    messageIds: string[]
  ): Promise<Map<string, AttachmentWithExtraction[]>> {
    if (messageIds.length === 0) return new Map()

    const result = await client.query<AttachmentWithExtractionRow>(sql`
      SELECT
        a.id, a.workspace_id, a.stream_id, a.message_id, a.uploaded_by,
        a.filename, a.mime_type, a.size_bytes,
        a.storage_provider, a.storage_path, a.processing_status, a.safety_status, a.e2e_only,
        a.thumbnail_storage_path, a.width, a.height,
        a.created_at,
        e.content_type AS extraction_content_type,
        e.summary AS extraction_summary,
        e.full_text AS extraction_full_text
      FROM attachments a
      LEFT JOIN attachment_extractions e ON e.attachment_id = a.id
      WHERE a.message_id = ANY(${messageIds})
    `)

    const byMessage = new Map<string, AttachmentWithExtraction[]>()
    for (const row of result.rows) {
      if (!row.message_id) continue
      const existing = byMessage.get(row.message_id) ?? []
      existing.push(mapRowToAttachmentWithExtraction(row))
      byMessage.set(row.message_id, existing)
    }
    return byMessage
  },

  async insert(client: Querier, params: InsertAttachmentParams): Promise<Attachment> {
    const result = await client.query<AttachmentRow>(sql`
      INSERT INTO attachments (
        id, workspace_id, stream_id, uploaded_by,
        filename, mime_type, size_bytes,
        storage_provider, storage_path, safety_status, processing_status, e2e_only
      )
      VALUES (
        ${params.id},
        ${params.workspaceId},
        ${params.streamId ?? null},
        ${params.uploadedBy},
        ${params.filename},
        ${params.mimeType},
        ${params.sizeBytes},
        ${params.storageProvider ?? "s3"},
        ${params.storagePath},
        ${params.safetyStatus ?? AttachmentSafetyStatuses.PENDING_SCAN},
        ${params.processingStatus ?? ProcessingStatuses.PENDING},
        ${params.e2eOnly ?? false}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRowToAttachment(result.rows[0])
  },

  async attachToMessage(
    client: Querier,
    attachmentIds: string[],
    messageId: string,
    streamId: string
  ): Promise<number> {
    if (attachmentIds.length === 0) return 0
    // Link only shareable attachments: scanned-clean OR E2E ciphertext (which is
    // unscannable but is the owner's own bytes). Mirrors isAttachmentSafeForSharing.
    const result = await client.query(sql`
      UPDATE attachments
      SET message_id = ${messageId}, stream_id = ${streamId}
      WHERE id = ANY(${attachmentIds}) AND message_id IS NULL
        AND safety_status = ANY(${[AttachmentSafetyStatuses.CLEAN, AttachmentSafetyStatuses.E2E_UNSCANNED]})
    `)
    return result.rowCount ?? 0
  },

  async delete(client: Querier, id: string): Promise<boolean> {
    const result = await client.query(sql`
      DELETE FROM attachments WHERE id = ${id}
    `)
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Update the processing status of an attachment.
   * Returns true if the update was applied, false otherwise.
   *
   * @param onlyIfStatus - If provided, only update if current status matches this value (atomic transition)
   * @param onlyIfStatusIn - If provided, only update if current status is in this array (for retries)
   */
  async updateProcessingStatus(
    client: Querier,
    id: string,
    status: ProcessingStatus,
    options?: { onlyIfStatus?: ProcessingStatus; onlyIfStatusIn?: ProcessingStatus[] }
  ): Promise<boolean> {
    if (options?.onlyIfStatusIn) {
      const result = await client.query(sql`
        UPDATE attachments
        SET processing_status = ${status}
        WHERE id = ${id} AND processing_status = ANY(${options.onlyIfStatusIn})
      `)
      return (result.rowCount ?? 0) > 0
    }

    if (options?.onlyIfStatus) {
      const result = await client.query(sql`
        UPDATE attachments
        SET processing_status = ${status}
        WHERE id = ${id} AND processing_status = ${options.onlyIfStatus}
      `)
      return (result.rowCount ?? 0) > 0
    }

    const result = await client.query(sql`
      UPDATE attachments
      SET processing_status = ${status}
      WHERE id = ${id}
    `)
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Record the generated image thumbnail path and orientation-corrected
   * intrinsic dimensions. Idempotent — a re-run overwrites in place, so a
   * retried thumbnail job is safe.
   */
  async updateImageVariant(
    client: Querier,
    id: string,
    params: { thumbnailStoragePath: string; width: number; height: number }
  ): Promise<boolean> {
    const result = await client.query(sql`
      UPDATE attachments
      SET thumbnail_storage_path = ${params.thumbnailStoragePath},
          width = ${params.width},
          height = ${params.height}
      WHERE id = ${id}
    `)
    return (result.rowCount ?? 0) > 0
  },

  async updateSafetyStatus(
    client: Querier,
    id: string,
    status: AttachmentSafetyStatus,
    options?: { onlyIfStatus?: AttachmentSafetyStatus; onlyIfStatusIn?: AttachmentSafetyStatus[] }
  ): Promise<boolean> {
    if (options?.onlyIfStatusIn) {
      const result = await client.query(sql`
        UPDATE attachments
        SET safety_status = ${status}
        WHERE id = ${id} AND safety_status = ANY(${options.onlyIfStatusIn})
      `)
      return (result.rowCount ?? 0) > 0
    }

    if (options?.onlyIfStatus) {
      const result = await client.query(sql`
        UPDATE attachments
        SET safety_status = ${status}
        WHERE id = ${id} AND safety_status = ${options.onlyIfStatus}
      `)
      return (result.rowCount ?? 0) > 0
    }

    const result = await client.query(sql`
      UPDATE attachments
      SET safety_status = ${status}
      WHERE id = ${id}
    `)
    return (result.rowCount ?? 0) > 0
  },

  async quarantineStalePendingScans(client: Querier, options: { olderThan: Date; limit: number }): Promise<string[]> {
    const result = await client.query<{ id: string }>(sql`
      WITH stale AS (
        SELECT id
        FROM attachments
        WHERE safety_status = ${AttachmentSafetyStatuses.PENDING_SCAN}
          AND created_at < ${options.olderThan}
        ORDER BY created_at ASC
        LIMIT ${options.limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE attachments a
      SET
        safety_status = ${AttachmentSafetyStatuses.QUARANTINED},
        processing_status = ${ProcessingStatuses.SKIPPED}
      FROM stale
      WHERE a.id = stale.id
        AND a.safety_status = ${AttachmentSafetyStatuses.PENDING_SCAN}
      RETURNING a.id
    `)

    return result.rows.map((row) => row.id)
  },

  /**
   * Search attachments with their extractions joined.
   * Searches by filename and extraction content (summary, full_text).
   */
  async searchWithExtractions(
    client: Querier,
    opts: {
      workspaceId: string
      streamIds: string[]
      query: string
      contentTypes?: ExtractionContentType[]
      safetyStatuses?: AttachmentSafetyStatus[]
      limit?: number
    }
  ): Promise<AttachmentWithExtraction[]> {
    const { workspaceId, streamIds, query, contentTypes, safetyStatuses, limit = 20 } = opts

    if (streamIds.length === 0) return []

    const searchPattern = `%${query}%`
    const hasSafetyStatusFilter = Boolean(safetyStatuses?.length)

    // Use separate queries to avoid nested sql template issues
    if (contentTypes?.length) {
      const result = await client.query<AttachmentWithExtractionRow>(sql`
        SELECT
          a.id, a.workspace_id, a.stream_id, a.message_id, a.uploaded_by,
          a.filename, a.mime_type, a.size_bytes,
          a.storage_provider, a.storage_path, a.processing_status, a.safety_status, a.e2e_only,
          a.thumbnail_storage_path, a.width, a.height,
          a.created_at,
          e.content_type AS extraction_content_type,
          e.summary AS extraction_summary,
          e.full_text AS extraction_full_text
        FROM attachments a
        LEFT JOIN attachment_extractions e ON e.attachment_id = a.id
        WHERE a.workspace_id = ${workspaceId}
          AND a.stream_id = ANY(${streamIds})
          AND (${!hasSafetyStatusFilter} OR a.safety_status = ANY(${safetyStatuses ?? []}))
          AND (
            a.filename ILIKE ${searchPattern}
            OR e.summary ILIKE ${searchPattern}
            OR e.full_text ILIKE ${searchPattern}
          )
          AND e.content_type = ANY(${contentTypes})
        ORDER BY a.created_at DESC
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToAttachmentWithExtraction)
    }

    const result = await client.query<AttachmentWithExtractionRow>(sql`
      SELECT
        a.id, a.workspace_id, a.stream_id, a.message_id, a.uploaded_by,
        a.filename, a.mime_type, a.size_bytes,
        a.storage_provider, a.storage_path, a.processing_status, a.safety_status, a.e2e_only,
        a.thumbnail_storage_path, a.width, a.height,
        a.created_at,
        e.content_type AS extraction_content_type,
        e.summary AS extraction_summary,
        e.full_text AS extraction_full_text
      FROM attachments a
      LEFT JOIN attachment_extractions e ON e.attachment_id = a.id
      WHERE a.workspace_id = ${workspaceId}
        AND a.stream_id = ANY(${streamIds})
        AND (${!hasSafetyStatusFilter} OR a.safety_status = ANY(${safetyStatuses ?? []}))
        AND (
          a.filename ILIKE ${searchPattern}
          OR e.summary ILIKE ${searchPattern}
          OR e.full_text ILIKE ${searchPattern}
        )
      ORDER BY a.created_at DESC
      LIMIT ${limit}
    `)

    return result.rows.map(mapRowToAttachmentWithExtraction)
  },

  /**
   * Explorer search. One round trip combining:
   *   - readable-stream gating for `userId` (mirrors `listAccessibleStreamIds`
   *     so the predicate stays consistent with `checkStreamAccess`)
   *   - thread-descendant expansion when `streamIds` is supplied (callers
   *     pass channel/DM ids and the repo finds files in those streams *and*
   *     their threads via `root_stream_id`)
   *   - filename/extract FTS via `websearch_to_tsquery('english', ...)`
   *     against the combined `attachments.search_vector` and
   *     `attachment_extractions.search_vector`
   *   - exact substring match (ILIKE) when `exact = true`
   *   - filename-only substring match via `nameSubstring`
   *   - mime-category filter resolved through `mimePrefixesForCategory`
   *   - keyset cursor on `(created_at DESC, id DESC)`
   *
   * Returns `limit + 1` rows when more pages are available; the caller
   * trims the trailing row and uses it to mint the next cursor.
   */
  async search(client: Querier, opts: AttachmentSearchParams): Promise<AttachmentSearchRow[]> {
    const {
      workspaceId,
      userId,
      streamIds,
      categories,
      uploadedBy,
      before,
      after,
      queryText,
      exact = false,
      nameSubstring,
      cursor,
      limit,
    } = opts

    const fetchLimit = limit + 1
    const hasStreamScope = streamIds !== undefined && streamIds.length > 0
    const scopedStreamIds = hasStreamScope ? streamIds : []
    const hasCategories = Boolean(categories?.length)
    const mimePatterns = hasCategories
      ? Array.from(new Set(categories!.flatMap((c) => mimePrefixesForCategory(c))))
      : []
    const trimmedQuery = queryText?.trim()
    const hasQueryText = Boolean(trimmedQuery)
    const ilikePattern = hasQueryText ? `%${trimmedQuery}%` : ""
    const nameLikePattern = nameSubstring ? `%${nameSubstring}%` : ""
    const useFts = hasQueryText && !exact
    const useIlike = hasQueryText && exact
    const cursorCreatedAt = cursor?.createdAt ?? null
    const cursorId = cursor?.id ?? ""

    const result = await client.query<AttachmentSearchRowDb>(sql`
      WITH accessible_streams AS (
        SELECT s.id
        FROM streams s
        LEFT JOIN streams root ON root.id = s.root_stream_id
        WHERE s.workspace_id = ${workspaceId}
          AND (
            (s.root_stream_id IS NULL AND (
              s.visibility = ${Visibilities.PUBLIC}
              OR EXISTS (
                SELECT 1 FROM stream_members
                WHERE stream_id = s.id AND member_id = ${userId}
              )
            ))
            OR
            (s.root_stream_id IS NOT NULL AND root.id IS NOT NULL AND (
              root.visibility = ${Visibilities.PUBLIC}
              OR EXISTS (
                SELECT 1 FROM stream_members
                WHERE stream_id = s.root_stream_id AND member_id = ${userId}
              )
            ))
          )
      ),
      scoped_streams AS (
        SELECT acc.id
        FROM accessible_streams acc
        LEFT JOIN streams s ON s.id = acc.id
        WHERE
          ${!hasStreamScope}
          OR acc.id = ANY(${scopedStreamIds})
          OR s.root_stream_id = ANY(${scopedStreamIds})
      )
      SELECT
        a.id, a.workspace_id, a.stream_id, a.message_id, a.uploaded_by,
        a.filename, a.mime_type, a.size_bytes,
        a.storage_provider, a.storage_path, a.processing_status, a.safety_status, a.e2e_only,
        a.thumbnail_storage_path, a.width, a.height,
        a.created_at,
        e.content_type AS extraction_content_type,
        e.summary AS extraction_summary,
        s.slug AS stream_slug,
        s.display_name AS stream_name,
        s.type AS stream_type,
        u.slug AS uploader_slug,
        u.name AS uploader_name,
        COALESCE(ref_count.count, 0)::int AS reference_count
      FROM attachments a
      JOIN scoped_streams ss ON ss.id = a.stream_id
      LEFT JOIN attachment_extractions e ON e.attachment_id = a.id
      LEFT JOIN streams s ON s.id = a.stream_id
      LEFT JOIN users u ON u.id = a.uploaded_by
      LEFT JOIN (
        SELECT attachment_id, COUNT(*)::int AS count
        FROM attachment_references
        WHERE workspace_id = ${workspaceId}
        GROUP BY attachment_id
      ) ref_count ON ref_count.attachment_id = a.id
      WHERE a.workspace_id = ${workspaceId}
        AND a.message_id IS NOT NULL
        AND a.safety_status = ${AttachmentSafetyStatuses.CLEAN}
        AND (${!hasCategories} OR a.mime_type ILIKE ANY(${mimePatterns}))
        AND (${uploadedBy === undefined} OR a.uploaded_by = ${uploadedBy ?? ""})
        AND (${before === undefined} OR a.created_at < ${before ?? new Date(0)})
        AND (${after === undefined} OR a.created_at >= ${after ?? new Date(0)})
        AND (
          ${!useFts}
          OR (
            a.search_vector @@ websearch_to_tsquery('english', ${trimmedQuery ?? ""})
            OR e.search_vector @@ websearch_to_tsquery('english', ${trimmedQuery ?? ""})
          )
        )
        AND (
          ${!useIlike}
          OR a.filename ILIKE ${ilikePattern}
          OR e.summary ILIKE ${ilikePattern}
          OR e.full_text ILIKE ${ilikePattern}
        )
        AND (${nameSubstring === undefined} OR a.filename ILIKE ${nameLikePattern})
        AND (
          ${cursorCreatedAt === null}
          OR (a.created_at, a.id) < (${cursorCreatedAt ?? new Date(0)}::timestamptz, ${cursorId}::text)
        )
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${fetchLimit}
    `)

    return result.rows.map(mapRowToSearchRow)
  },
}

export interface AttachmentSearchParams {
  workspaceId: string
  /** Identity of the caller, used to apply readable-stream gating. */
  userId: string
  /**
   * Optional channel/DM/scratchpad ids to narrow to. Threads are included
   * automatically when their root is in this list.
   * `undefined` = workspace-wide (still gated by readable-stream access).
   */
  streamIds?: string[]
  categories?: AttachmentCategory[]
  uploadedBy?: string
  before?: Date
  after?: Date
  /** Free-text query — FTS by default, ILIKE when `exact` is true. */
  queryText?: string
  exact?: boolean
  /** Filename-only substring match (used by the `name:"..."` chip). */
  nameSubstring?: string
  cursor?: AttachmentSearchCursor
  limit: number
}

export interface AttachmentSearchCursor {
  createdAt: Date
  id: string
}

export interface AttachmentSearchRow extends Attachment {
  extraction: { contentType: ExtractionContentType; summary: string } | null
  streamSlug: string | null
  streamName: string | null
  streamType: string | null
  uploaderSlug: string | null
  uploaderName: string | null
  referenceCount: number
}

interface AttachmentSearchRowDb extends AttachmentRow {
  extraction_content_type: string | null
  extraction_summary: string | null
  stream_slug: string | null
  stream_name: string | null
  stream_type: string | null
  uploader_slug: string | null
  uploader_name: string | null
  reference_count: number
}

function mapRowToSearchRow(row: AttachmentSearchRowDb): AttachmentSearchRow {
  return {
    ...mapRowToAttachment(row),
    extraction: row.extraction_content_type
      ? {
          contentType: row.extraction_content_type as ExtractionContentType,
          summary: row.extraction_summary ?? "",
        }
      : null,
    streamSlug: row.stream_slug,
    streamName: row.stream_name,
    streamType: row.stream_type,
    uploaderSlug: row.uploader_slug,
    uploaderName: row.uploader_name,
    referenceCount: row.reference_count,
  }
}
