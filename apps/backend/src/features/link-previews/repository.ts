import { sql, type Querier } from "@threa/backend-common"
import {
  type GitHubPreview,
  type GitHubPreviewType,
  type LinearPreview,
  type LinearPreviewType,
  type VideoPreview,
  type VideoPreviewType,
  type LinkPreviewContentType,
  type LinkPreviewStatus,
  isInAppLinkContentType,
} from "@threa/types"

/** Union of all rich provider preview types persisted in `link_previews.preview_type`. */
export type RichPreviewType = GitHubPreviewType | LinearPreviewType | VideoPreviewType
/** Union of all rich provider preview payloads stored in `link_previews.preview_data`. */
export type RichPreview = GitHubPreview | LinearPreview | VideoPreview

export interface LinkPreview {
  id: string
  workspaceId: string
  url: string
  normalizedUrl: string
  title: string | null
  description: string | null
  imageUrl: string | null
  faviconUrl: string | null
  siteName: string | null
  contentType: LinkPreviewContentType
  status: LinkPreviewStatus
  previewType: RichPreviewType | null
  previewData: RichPreview | null
  targetWorkspaceId: string | null
  targetStreamId: string | null
  targetMessageId: string | null
  targetMemoId: string | null
  targetConversationId: string | null
  targetDelegationId: string | null
  fetchedAt: Date | null
  /**
   * Optimistic-concurrency counter for the webhook force-refresh path. Every
   * metadata write increments it; a refresh captures it pre-fetch and passes it
   * back as the compare-and-set expectation (`overwriteMetadata` under
   * `expectedRefreshVersion`). Replaces the old `fetched_at` CAS, which the
   * TIMESTAMPTZ-vs-Date precision mismatch broke.
   */
  refreshVersion: number
  expiresAt: Date | null
  createdAt: Date
}

export interface InsertLinkPreviewParams {
  id: string
  workspaceId: string
  url: string
  normalizedUrl: string
  contentType: LinkPreviewContentType
  targetWorkspaceId?: string
  targetStreamId?: string
  targetMessageId?: string
  targetMemoId?: string
  targetConversationId?: string
  targetDelegationId?: string
}

export interface UpdateLinkPreviewParams {
  title?: string | null
  description?: string | null
  imageUrl?: string | null
  faviconUrl?: string | null
  siteName?: string | null
  contentType?: LinkPreviewContentType
  previewType?: RichPreviewType | null
  previewData?: RichPreview | null
  status: LinkPreviewStatus
  expiresAt?: Date | null
}

export interface MessageLinkPreview {
  messageId: string
  linkPreviewId: string
  position: number
}

function mapRow(row: Record<string, unknown>): LinkPreview {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    url: row.url as string,
    normalizedUrl: row.normalized_url as string,
    title: row.title as string | null,
    description: row.description as string | null,
    imageUrl: row.image_url as string | null,
    faviconUrl: row.favicon_url as string | null,
    siteName: row.site_name as string | null,
    contentType: row.content_type as LinkPreviewContentType,
    status: row.status as LinkPreviewStatus,
    previewType: (row.preview_type as RichPreviewType | null) ?? null,
    previewData: (row.preview_data as RichPreview | null) ?? null,
    targetWorkspaceId: (row.target_workspace_id as string | null) ?? null,
    targetStreamId: (row.target_stream_id as string | null) ?? null,
    targetMessageId: (row.target_message_id as string | null) ?? null,
    targetMemoId: (row.target_memo_id as string | null) ?? null,
    targetConversationId: (row.target_conversation_id as string | null) ?? null,
    targetDelegationId: (row.target_delegation_id as string | null) ?? null,
    fetchedAt: row.fetched_at ? new Date(row.fetched_at as string) : null,
    refreshVersion: (row.refresh_version as number | null) ?? 0,
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
    createdAt: new Date(row.created_at as string),
  }
}

export const LinkPreviewRepository = {
  async insert(querier: Querier, params: InsertLinkPreviewParams): Promise<LinkPreview> {
    // In-app links resolve through the permission-checked endpoint, never a
    // network fetch — they are complete the moment the row exists.
    const status = isInAppLinkContentType(params.contentType) ? "completed" : "pending"
    const result = await querier.query(
      sql`INSERT INTO link_previews (id, workspace_id, url, normalized_url, content_type, status,
              target_workspace_id, target_stream_id, target_message_id, target_memo_id, target_conversation_id,
              target_delegation_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (workspace_id, normalized_url) DO UPDATE SET
              content_type = EXCLUDED.content_type,
              status = EXCLUDED.status,
              target_workspace_id = EXCLUDED.target_workspace_id,
              target_stream_id = EXCLUDED.target_stream_id,
              target_message_id = EXCLUDED.target_message_id,
              target_memo_id = EXCLUDED.target_memo_id,
              target_conversation_id = EXCLUDED.target_conversation_id,
              target_delegation_id = EXCLUDED.target_delegation_id
          WHERE link_previews.content_type != EXCLUDED.content_type
          RETURNING *`,
      [
        params.id,
        params.workspaceId,
        params.url,
        params.normalizedUrl,
        params.contentType,
        status,
        params.targetWorkspaceId ?? null,
        params.targetStreamId ?? null,
        params.targetMessageId ?? null,
        params.targetMemoId ?? null,
        params.targetConversationId ?? null,
        params.targetDelegationId ?? null,
      ]
    )
    if (result.rows.length > 0) {
      return mapRow(result.rows[0])
    }
    const existing = await LinkPreviewRepository.findByNormalizedUrl(querier, params.workspaceId, params.normalizedUrl)
    if (!existing) {
      throw new Error(`link_preview row disappeared after conflict for ${params.normalizedUrl}`)
    }
    return existing
  },

  async findById(querier: Querier, workspaceId: string, id: string): Promise<LinkPreview | null> {
    const result = await querier.query(sql`SELECT * FROM link_previews WHERE workspace_id = $1 AND id = $2`, [
      workspaceId,
      id,
    ])
    return result.rows.length > 0 ? mapRow(result.rows[0]) : null
  },

  async findByNormalizedUrl(querier: Querier, workspaceId: string, normalizedUrl: string): Promise<LinkPreview | null> {
    const result = await querier.query(
      sql`SELECT * FROM link_previews WHERE workspace_id = $1 AND normalized_url = $2`,
      [workspaceId, normalizedUrl]
    )
    return result.rows.length > 0 ? mapRow(result.rows[0]) : null
  },

  async updateMetadata(
    querier: Querier,
    workspaceId: string,
    id: string,
    params: UpdateLinkPreviewParams
  ): Promise<LinkPreview | null> {
    const result = await querier.query(
      sql`UPDATE link_previews
          SET title = $3, description = $4, image_url = $5, favicon_url = $6,
              site_name = $7, content_type = $8, preview_type = $9, preview_data = $10::jsonb,
              status = $11, fetched_at = NOW(), refresh_version = refresh_version + 1, expires_at = $12
          WHERE workspace_id = $1 AND id = $2 AND status = 'pending'
          RETURNING *`,
      [
        workspaceId,
        id,
        params.title ?? null,
        params.description ?? null,
        params.imageUrl ?? null,
        params.faviconUrl ?? null,
        params.siteName ?? null,
        params.contentType ?? "website",
        params.previewType ?? null,
        params.previewData ? JSON.stringify(params.previewData) : null,
        params.status,
        params.expiresAt ?? null,
      ]
    )
    return result.rows.length > 0 ? mapRow(result.rows[0]) : null
  },

  /**
   * Unconditional overwrite of an already-fetched row, always bumping
   * `refresh_version`. When `options` carries an `expectedRefreshVersion` key the
   * write becomes a compare-and-set on that version: the webhook-refresh path
   * reads `refresh_version` before its out-of-transaction network fetch and passes
   * it here so a slower concurrent refresh (or a message-path write that already
   * advanced the version) can't blind-overwrite a newer write. A CAS miss returns
   * null (0 rows) without writing — the caller re-reads to distinguish a conflict
   * from a vanished row. Callers that omit the key (message-driven extract path)
   * keep the unconditional semantics.
   *
   * An integer version replaces the former `fetched_at` CAS: TIMESTAMPTZ stores
   * microseconds but pg maps `fetched_at` to a millisecond JS `Date`, so a
   * read-back value never equalled the stored one and every uncontended refresh
   * spuriously conflicted.
   */
  async overwriteMetadata(
    querier: Querier,
    workspaceId: string,
    id: string,
    params: UpdateLinkPreviewParams,
    options?: { expectedRefreshVersion?: number }
  ): Promise<LinkPreview | null> {
    // A single predicate handles both modes so the SET clause isn't duplicated:
    // when CAS is off, `$13` is true and the guard is a no-op; when CAS is on,
    // `$13` is false and the write requires `refresh_version` to equal `$14`.
    const cas = options !== undefined && "expectedRefreshVersion" in options
    const result = await querier.query(
      sql`UPDATE link_previews
          SET title = $3, description = $4, image_url = $5, favicon_url = $6,
              site_name = $7, content_type = $8, preview_type = $9, preview_data = $10::jsonb,
              status = $11, fetched_at = NOW(), refresh_version = refresh_version + 1, expires_at = $12
          WHERE workspace_id = $1 AND id = $2
            AND ($13::boolean OR refresh_version = $14)
          RETURNING *`,
      [
        workspaceId,
        id,
        params.title ?? null,
        params.description ?? null,
        params.imageUrl ?? null,
        params.faviconUrl ?? null,
        params.siteName ?? null,
        params.contentType ?? "website",
        params.previewType ?? null,
        params.previewData ? JSON.stringify(params.previewData) : null,
        params.status,
        params.expiresAt ?? null,
        !cas,
        cas ? (options!.expectedRefreshVersion ?? 0) : null,
      ]
    )
    return result.rows.length > 0 ? mapRow(result.rows[0]) : null
  },

  async unlinkAllFromMessage(querier: Querier, workspaceId: string, messageId: string): Promise<void> {
    await querier.query(sql`DELETE FROM message_link_previews WHERE workspace_id = $1 AND message_id = $2`, [
      workspaceId,
      messageId,
    ])
  },

  async linkToMessage(
    querier: Querier,
    workspaceId: string,
    messageId: string,
    linkPreviewId: string,
    position: number
  ): Promise<void> {
    await querier.query(
      sql`INSERT INTO message_link_previews (workspace_id, message_id, link_preview_id, position)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (workspace_id, message_id, link_preview_id) DO NOTHING`,
      [workspaceId, messageId, linkPreviewId, position]
    )
  },

  /**
   * Every completed preview row whose normalized URL starts with `prefix`, for
   * webhook-driven refresh matching. `prefix` MUST already be LIKE-escaped by the
   * caller (see `escapeLikePattern`); the trailing `%` and `ESCAPE` are applied
   * here so a repo name containing `_`/`%` can't widen the match. The caller
   * re-validates each row (parse the URL, compare owner/repo/number) — the prefix
   * is only a coarse DB-side narrowing.
   *
   * `ILIKE` (not `LIKE`): the caller's identity re-check lowercases owner/repo
   * (GitHub treats them case-insensitively), but `normalizeUrl` preserves path
   * casing, so a preview stored from a pasted non-canonical URL (`.../React/...`)
   * keeps that casing in `normalized_url` while a webhook derives the canonical
   * lowercase base (`.../react/...`). A case-sensitive prefix would drop the row
   * here before the case-insensitive re-check could confirm it, so this step must
   * be case-insensitive to agree with the re-check.
   */
  async findByNormalizedUrlPrefix(
    querier: Querier,
    workspaceId: string,
    escapedPrefix: string
  ): Promise<LinkPreview[]> {
    const result = await querier.query(
      sql`SELECT * FROM link_previews
          WHERE workspace_id = $1 AND status = 'completed' AND normalized_url ILIKE $2 ESCAPE '\\'`,
      [workspaceId, `${escapedPrefix}%`]
    )
    return result.rows.map(mapRow)
  },

  /** Message ids currently linked to a preview row (reverse of `findByMessageId`). */
  async findMessageIdsByPreviewId(querier: Querier, workspaceId: string, linkPreviewId: string): Promise<string[]> {
    const result = await querier.query(
      sql`SELECT message_id FROM message_link_previews WHERE workspace_id = $1 AND link_preview_id = $2`,
      [workspaceId, linkPreviewId]
    )
    return result.rows.map((row) => row.message_id as string)
  },

  async findByMessageId(querier: Querier, workspaceId: string, messageId: string): Promise<LinkPreview[]> {
    const result = await querier.query(
      sql`SELECT lp.* FROM link_previews lp
          JOIN message_link_previews mlp ON mlp.link_preview_id = lp.id
          WHERE mlp.workspace_id = $1 AND mlp.message_id = $2
          ORDER BY mlp.position ASC`,
      [workspaceId, messageId]
    )
    return result.rows.map(mapRow)
  },

  async findByMessageIds(
    querier: Querier,
    workspaceId: string,
    messageIds: string[]
  ): Promise<Map<string, LinkPreview[]>> {
    if (messageIds.length === 0) return new Map()

    const result = await querier.query(
      sql`SELECT lp.*, mlp.message_id, mlp.position FROM link_previews lp
          JOIN message_link_previews mlp ON mlp.link_preview_id = lp.id
          WHERE mlp.workspace_id = $1 AND mlp.message_id = ANY($2)
          ORDER BY mlp.message_id, mlp.position ASC`,
      [workspaceId, messageIds]
    )

    const map = new Map<string, LinkPreview[]>()
    for (const row of result.rows) {
      const msgId = row.message_id as string
      const preview = mapRow(row)
      const existing = map.get(msgId) ?? []
      existing.push(preview)
      map.set(msgId, existing)
    }
    return map
  },

  async dismiss(
    querier: Querier,
    workspaceId: string,
    userId: string,
    messageId: string,
    linkPreviewId: string
  ): Promise<boolean> {
    const result = await querier.query(
      sql`INSERT INTO user_link_preview_dismissals (workspace_id, user_id, message_id, link_preview_id)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (workspace_id, user_id, message_id, link_preview_id) DO NOTHING`,
      [workspaceId, userId, messageId, linkPreviewId]
    )
    return (result.rowCount ?? 0) > 0
  },

  async findDismissals(
    querier: Querier,
    workspaceId: string,
    userId: string,
    messageIds: string[]
  ): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set()

    const result = await querier.query(
      sql`SELECT message_id, link_preview_id FROM user_link_preview_dismissals
          WHERE workspace_id = $1 AND user_id = $2 AND message_id = ANY($3)`,
      [workspaceId, userId, messageIds]
    )

    const set = new Set<string>()
    for (const row of result.rows) {
      set.add(`${row.message_id}:${row.link_preview_id}`)
    }
    return set
  },
}
