import type { Querier } from "../../db"
import { sql } from "../../db"
import type { AuthorType, JSONContent } from "@threa/types"
import type { MoveEventSequenceUpdate } from "../streams"

// Internal row type (snake_case, not exported)
interface MessageRow {
  id: string
  stream_id: string
  sequence: string
  author_id: string
  author_type: string
  content_json: JSONContent
  content_markdown: string
  reply_count: number
  client_message_id: string | null
  sent_via: string | null
  metadata: Record<string, string>
  edited_at: Date | null
  deleted_at: Date | null
  created_at: Date
  ciphertext: Buffer | null
  envelope: unknown | null
  e2e_version: number | null
}

interface ReactionRow {
  message_id: string
  user_id: string
  emoji: string
}

// Domain type (camelCase, exported)
export interface Message {
  id: string
  streamId: string
  sequence: bigint
  authorId: string
  authorType: AuthorType
  contentJson: JSONContent
  contentMarkdown: string
  replyCount: number
  clientMessageId: string | null
  sentVia: string | null
  reactions: Record<string, string[]>
  /** External references (e.g. GitHub PR id). Always present; `{}` when unset. */
  metadata: Record<string, string>
  editedAt: Date | null
  deletedAt: Date | null
  createdAt: Date
  /**
   * E2E ciphertext + envelope are populated for messages in `e2e_scratchpads`
   * streams; `contentJson` / `contentMarkdown` carry an empty-doc placeholder
   * in that case (the canonical payload is the ciphertext). Non-E2E rows have
   * all three null.
   */
  ciphertext: Buffer | null
  envelope: unknown | null
  e2eVersion: number | null
}

export interface InsertMessageParams {
  id: string
  streamId: string
  sequence: bigint
  authorId: string
  authorType: AuthorType
  contentJson: JSONContent
  contentMarkdown: string
  clientMessageId?: string
  sentVia?: string
  metadata?: Record<string, string>
  /** When set, this row is an E2E ciphertext payload; `contentJson` / `contentMarkdown` should be the empty-doc placeholder. */
  ciphertext?: Buffer
  envelope?: unknown
  e2eVersion?: number
}

// Alias for the canonical move-by-messageId+sequence shape defined alongside
// `moveMessageCreatedEvents` in the streams feature. Keeping the local name
// preserved so message-side callers (`MessageRepository.moveByIds`) read in
// the messaging vocabulary while the underlying type stays canonical.
export type MoveMessageSequenceUpdate = MoveEventSequenceUpdate

function mapRowToMessage(row: MessageRow, reactions: Record<string, string[]> = {}): Message {
  return {
    id: row.id,
    streamId: row.stream_id,
    sequence: BigInt(row.sequence),
    authorId: row.author_id,
    authorType: row.author_type as AuthorType,
    contentJson: row.content_json,
    contentMarkdown: row.content_markdown,
    replyCount: row.reply_count,
    clientMessageId: row.client_message_id,
    sentVia: row.sent_via,
    reactions,
    // JSONB comes back parsed; the column has NOT NULL DEFAULT '{}' so it's always an object.
    metadata: row.metadata ?? {},
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    ciphertext: row.ciphertext,
    envelope: row.envelope,
    e2eVersion: row.e2e_version,
  }
}

function aggregateReactions(rows: ReactionRow[]): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const row of rows) {
    if (!result[row.emoji]) {
      result[row.emoji] = []
    }
    result[row.emoji].push(row.user_id)
  }
  // Filter out empty arrays (shouldn't happen, but defensive)
  for (const emoji of Object.keys(result)) {
    if (result[emoji].length === 0) {
      delete result[emoji]
    }
  }
  return result
}

function aggregateReactionsByMessage(rows: ReactionRow[]): Map<string, Record<string, string[]>> {
  const byMessage = new Map<string, ReactionRow[]>()
  for (const row of rows) {
    const existing = byMessage.get(row.message_id) ?? []
    existing.push(row)
    byMessage.set(row.message_id, existing)
  }

  const result = new Map<string, Record<string, string[]>>()
  for (const [messageId, reactions] of byMessage) {
    result.set(messageId, aggregateReactions(reactions))
  }
  return result
}

const SELECT_FIELDS = `
  id, stream_id, sequence, author_id, author_type,
  content_json, content_markdown, reply_count, client_message_id, sent_via,
  metadata,
  edited_at, deleted_at, created_at,
  ciphertext, envelope, e2e_version
`

const QUALIFIED_SELECT_FIELDS = `
  m.id, m.stream_id, m.sequence, m.author_id, m.author_type,
  m.content_json, m.content_markdown, m.reply_count, m.client_message_id, m.sent_via,
  m.metadata,
  m.edited_at, m.deleted_at, m.created_at,
  m.ciphertext, m.envelope, m.e2e_version
`

export const MessageRepository = {
  async findByClientMessageId(db: Querier, streamId: string, clientMessageId: string): Promise<Message | null> {
    const result = await db.query<MessageRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM messages
      WHERE stream_id = ${streamId} AND client_message_id = ${clientMessageId}
    `)
    if (!result.rows[0]) return null

    const reactionsResult = await db.query<ReactionRow>(
      sql`SELECT message_id, user_id, emoji FROM reactions WHERE message_id = ${result.rows[0].id}`
    )
    const reactions = aggregateReactions(reactionsResult.rows)

    return mapRowToMessage(result.rows[0], reactions)
  },

  async findByIdForUpdate(db: Querier, id: string): Promise<Message | null> {
    const result = await db.query<MessageRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM messages WHERE id = ${id} FOR UPDATE`
    )
    if (!result.rows[0]) return null
    return mapRowToMessage(result.rows[0])
  },

  async findById(db: Querier, id: string): Promise<Message | null> {
    const result = await db.query<MessageRow>(sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM messages WHERE id = ${id}`)
    if (!result.rows[0]) return null

    const reactionsResult = await db.query<ReactionRow>(
      sql`SELECT message_id, user_id, emoji FROM reactions WHERE message_id = ${id}`
    )
    const reactions = aggregateReactions(reactionsResult.rows)

    return mapRowToMessage(result.rows[0], reactions)
  },

  async findByIds(db: Querier, ids: string[]): Promise<Map<string, Message>> {
    if (ids.length === 0) return new Map()

    const result = await db.query<MessageRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM messages
      WHERE id = ANY(${ids})
    `)

    if (result.rows.length === 0) return new Map()

    const reactionsResult = await db.query<ReactionRow>(sql`
      SELECT message_id, user_id, emoji FROM reactions
      WHERE message_id = ANY(${ids})
    `)
    const reactionsByMessage = aggregateReactionsByMessage(reactionsResult.rows)

    const map = new Map<string, Message>()
    for (const row of result.rows) {
      map.set(row.id, mapRowToMessage(row, reactionsByMessage.get(row.id) ?? {}))
    }
    return map
  },

  async findByIdsForUpdate(db: Querier, ids: string[]): Promise<Message[]> {
    if (ids.length === 0) return []

    const result = await db.query<MessageRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM messages
      WHERE id = ANY(${ids})
      ORDER BY sequence ASC
      FOR UPDATE
    `)

    if (result.rows.length === 0) return []

    const messageIds = result.rows.map((r) => r.id)
    const reactionsResult = await db.query<ReactionRow>(sql`
      SELECT message_id, user_id, emoji FROM reactions
      WHERE message_id = ANY(${messageIds})
    `)
    const reactionsByMessage = aggregateReactionsByMessage(reactionsResult.rows)

    return result.rows.map((row) => mapRowToMessage(row, reactionsByMessage.get(row.id) ?? {}))
  },

  /**
   * Fetch messages by ID scoped to a workspace. The messages table has no
   * direct `workspace_id` column so the filter joins through `streams`. Used
   * by callers whose input ids come from untrusted sources (e.g. a pointer
   * messageId pulled from contentJson) where trusting the caller's implicit
   * workspace boundary would violate INV-8.
   */
  async findByIdsInWorkspace(db: Querier, workspaceId: string, ids: string[]): Promise<Map<string, Message>> {
    if (ids.length === 0) return new Map()

    const result = await db.query<MessageRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM messages
      WHERE id = ANY(${ids})
        AND stream_id IN (SELECT id FROM streams WHERE workspace_id = ${workspaceId})
    `)

    if (result.rows.length === 0) return new Map()

    const foundIds = result.rows.map((r) => r.id)
    const reactionsResult = await db.query<ReactionRow>(sql`
      SELECT message_id, user_id, emoji FROM reactions
      WHERE message_id = ANY(${foundIds})
    `)
    const reactionsByMessage = aggregateReactionsByMessage(reactionsResult.rows)

    const map = new Map<string, Message>()
    for (const row of result.rows) {
      map.set(row.id, mapRowToMessage(row, reactionsByMessage.get(row.id) ?? {}))
    }
    return map
  },

  /**
   * Fetch messages by ID, restricted to a set of accessible streams and excluding
   * soft-deleted rows. Used by quote-reply resolution where the quoted message ID
   * comes from untrusted client content (`content_json.attrs.messageId`) and must
   * be filtered against the caller's access scope.
   */
  async findByIdsInStreams(db: Querier, ids: string[], streamIds: string[]): Promise<Map<string, Message>> {
    if (ids.length === 0 || streamIds.length === 0) return new Map()

    const result = await db.query<MessageRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM messages
      WHERE id = ANY(${ids})
        AND stream_id = ANY(${streamIds})
        AND deleted_at IS NULL
    `)

    if (result.rows.length === 0) return new Map()

    const foundIds = result.rows.map((r) => r.id)
    const reactionsResult = await db.query<ReactionRow>(sql`
      SELECT message_id, user_id, emoji FROM reactions
      WHERE message_id = ANY(${foundIds})
    `)
    const reactionsByMessage = aggregateReactionsByMessage(reactionsResult.rows)

    const map = new Map<string, Message>()
    for (const row of result.rows) {
      map.set(row.id, mapRowToMessage(row, reactionsByMessage.get(row.id) ?? {}))
    }
    return map
  },

  /**
   * Return the parent ("root") message of a stream — the message that spawned
   * the thread — or null when the stream has no parent (channel / scratchpad /
   * DM / hard-deleted root / soft-deleted root).
   *
   * Canonical helper for the recurring "thread root forgotten" bug class:
   * every context-building path that fetches a thread's messages must also
   * include the root so the reply chain stays intelligible. Callers that use
   * `MessageRepository.list(streamId)` on a thread stream miss the root by
   * default (it lives in the parent stream). This helper centralises:
   *   1. The `parentMessageId` presence check
   *   2. The `findById` lookup
   *   3. The soft-delete filter — `findById` doesn't filter `deletedAt IS NULL`,
   *      so without this guard a user's deleted root would still reach the AI.
   */
  async findThreadRoot(db: Querier, stream: { parentMessageId: string | null }): Promise<Message | null> {
    if (!stream.parentMessageId) return null
    const parent = await MessageRepository.findById(db, stream.parentMessageId)
    if (!parent || parent.deletedAt) return null
    return parent
  },

  async list(
    db: Querier,
    streamId: string,
    filters?: { limit?: number; beforeSequence?: bigint; afterSequence?: bigint }
  ): Promise<Message[]> {
    const limit = filters?.limit ?? 50

    let messageRows: MessageRow[]
    if (filters?.afterSequence) {
      const result = await db.query<MessageRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS)} FROM messages
        WHERE stream_id = ${streamId}
          AND sequence > ${filters.afterSequence.toString()}
          AND deleted_at IS NULL
        ORDER BY sequence ASC
        LIMIT ${limit}
      `)
      messageRows = result.rows
    } else if (filters?.beforeSequence) {
      const result = await db.query<MessageRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS)} FROM messages
        WHERE stream_id = ${streamId}
          AND sequence < ${filters.beforeSequence.toString()}
          AND deleted_at IS NULL
        ORDER BY sequence DESC
        LIMIT ${limit}
      `)
      messageRows = result.rows
    } else {
      const result = await db.query<MessageRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS)} FROM messages
        WHERE stream_id = ${streamId}
          AND deleted_at IS NULL
        ORDER BY sequence DESC
        LIMIT ${limit}
      `)
      messageRows = result.rows
    }

    if (messageRows.length === 0) return []

    const messageIds = messageRows.map((r) => r.id)
    const reactionsResult = await db.query<ReactionRow>(sql`
      SELECT message_id, user_id, emoji FROM reactions
      WHERE message_id = ANY(${messageIds})
    `)
    const reactionsByMessage = aggregateReactionsByMessage(reactionsResult.rows)

    // afterSequence already returns ASC order; beforeSequence and default return DESC and need reversal
    const messages = messageRows.map((row) => mapRowToMessage(row, reactionsByMessage.get(row.id) ?? {}))
    return filters?.afterSequence ? messages : messages.reverse()
  },

  async insert(db: Querier, params: InsertMessageParams): Promise<Message> {
    const clientMessageId = params.clientMessageId ?? null
    const sentVia = params.sentVia ?? null
    const metadata = params.metadata ?? {}

    // Use ON CONFLICT DO NOTHING when a clientMessageId is provided so that
    // concurrent retries don't throw a unique-constraint error (INV-20).
    const onConflict = clientMessageId
      ? "ON CONFLICT (stream_id, client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING"
      : ""

    const ciphertext = params.ciphertext ?? null
    const envelope = params.envelope !== undefined ? JSON.stringify(params.envelope) : null
    const e2eVersion = params.e2eVersion ?? null

    const result = await db.query<MessageRow>(sql`
      INSERT INTO messages (
        id, stream_id, sequence, author_id, author_type,
        content_json, content_markdown, client_message_id, sent_via, metadata,
        ciphertext, envelope, e2e_version
      )
      VALUES (
        ${params.id},
        ${params.streamId},
        ${params.sequence.toString()},
        ${params.authorId},
        ${params.authorType},
        ${JSON.stringify(params.contentJson)},
        ${params.contentMarkdown},
        ${clientMessageId},
        ${sentVia},
        ${JSON.stringify(metadata)},
        ${ciphertext},
        ${envelope},
        ${e2eVersion}
      )
      ${sql.raw(onConflict)}
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)

    // If ON CONFLICT swallowed the insert, the duplicate already exists — fetch it.
    if (!result.rows[0] && clientMessageId) {
      const existing = await this.findByClientMessageId(db, params.streamId, clientMessageId)
      if (existing) return existing
      throw new Error(`Insert conflict but no existing message found for clientMessageId ${clientMessageId}`)
    }

    return mapRowToMessage(result.rows[0])
  },

  async moveToStream(
    db: Querier,
    destinationStreamId: string,
    updates: MoveMessageSequenceUpdate[]
  ): Promise<Message[]> {
    if (updates.length === 0) return []

    const messageIds = updates.map((update) => update.messageId)
    const sequences = updates.map((update) => update.sequence.toString())

    const result = await db.query<MessageRow>(
      `UPDATE messages m
       SET stream_id = $1, sequence = updates.new_sequence
       FROM (
         SELECT * FROM unnest($2::text[], $3::bigint[]) AS u(id, new_sequence)
       ) updates
       WHERE m.id = updates.id
       RETURNING ${QUALIFIED_SELECT_FIELDS}`,
      [destinationStreamId, messageIds, sequences]
    )

    if (result.rows.length === 0) return []

    const movedIds = result.rows.map((row) => row.id)
    const reactionsResult = await db.query<ReactionRow>(sql`
      SELECT message_id, user_id, emoji FROM reactions
      WHERE message_id = ANY(${movedIds})
    `)
    const reactionsByMessage = aggregateReactionsByMessage(reactionsResult.rows)

    return result.rows.map((row) => mapRowToMessage(row, reactionsByMessage.get(row.id) ?? {}))
  },

  async updateStreamScopedReferences(
    db: Querier,
    params: { workspaceId: string; sourceStreamId: string; destinationStreamId: string; messageIds: string[] }
  ): Promise<void> {
    if (params.messageIds.length === 0) return

    await db.query(sql`
      UPDATE attachments
      SET stream_id = ${params.destinationStreamId}
      WHERE workspace_id = ${params.workspaceId}
        AND stream_id = ${params.sourceStreamId}
        AND message_id = ANY(${params.messageIds})
    `)

    await db.query(sql`
      UPDATE saved_messages
      SET stream_id = ${params.destinationStreamId}, updated_at = NOW()
      WHERE workspace_id = ${params.workspaceId}
        AND stream_id = ${params.sourceStreamId}
        AND message_id = ANY(${params.messageIds})
    `)

    await db.query(sql`
      UPDATE user_activity
      SET stream_id = ${params.destinationStreamId}
      WHERE workspace_id = ${params.workspaceId}
        AND stream_id = ${params.sourceStreamId}
        AND message_id = ANY(${params.messageIds})
    `)

    await db.query(sql`
      UPDATE researcher_cache
      SET stream_id = ${params.destinationStreamId}
      WHERE workspace_id = ${params.workspaceId}
        AND stream_id = ${params.sourceStreamId}
        AND message_id = ANY(${params.messageIds})
    `)

    await db.query(sql`
      UPDATE memo_pending_items
      SET stream_id = ${params.destinationStreamId}
      WHERE workspace_id = ${params.workspaceId}
        AND stream_id = ${params.sourceStreamId}
        AND item_type = 'message'
        AND item_id = ANY(${params.messageIds})
    `)

    await db.query(sql`
      UPDATE link_previews
      SET target_stream_id = ${params.destinationStreamId}
      WHERE workspace_id = ${params.workspaceId}
        AND target_stream_id = ${params.sourceStreamId}
        AND target_message_id = ANY(${params.messageIds})
    `)

    // shared_messages denormalizes both the source's stream and the share
    // message's stream. A move can hit either side: the moved message can be
    // a SOURCE (someone else's message embeds it) or the SHARE MESSAGE itself
    // (its body contains a `sharedMessage` node). Re-stamp both columns so the
    // pointer-invalidation broadcaster (`outbox-handler.ts`) targets the room
    // where the share actually lives, and so any future joins on
    // `source_stream_id` for navigation/UI resolve to the current stream.
    await db.query(sql`
      UPDATE shared_messages
      SET source_stream_id = ${params.destinationStreamId}
      WHERE workspace_id = ${params.workspaceId}
        AND source_stream_id = ${params.sourceStreamId}
        AND source_message_id = ANY(${params.messageIds})
    `)

    await db.query(sql`
      UPDATE shared_messages
      SET target_stream_id = ${params.destinationStreamId}
      WHERE workspace_id = ${params.workspaceId}
        AND target_stream_id = ${params.sourceStreamId}
        AND share_message_id = ANY(${params.messageIds})
    `)

    await db.query(sql`
      UPDATE agent_sessions
      SET stream_id = ${params.destinationStreamId}
      WHERE stream_id = ${params.sourceStreamId}
        AND (
          response_message_id = ANY(${params.messageIds})
          OR sent_message_ids && ${params.messageIds}
        )
    `)
  },

  async findAgentSessionIdsForMessages(
    db: Querier,
    params: { sourceStreamId: string; messageIds: string[] }
  ): Promise<string[]> {
    if (params.messageIds.length === 0) return []

    const result = await db.query<{ id: string }>(sql`
      SELECT id
      FROM agent_sessions
      WHERE stream_id = ${params.sourceStreamId}
        AND (
          response_message_id = ANY(${params.messageIds})
          OR sent_message_ids && ${params.messageIds}
        )
    `)
    return result.rows.map((row) => row.id)
  },

  /**
   * Find non-deleted messages whose `metadata` JSONB contains all the given
   * key/value pairs (AND-containment via the `@>` operator, backed by the
   * `idx_messages_metadata_gin` index). Results are scoped to `streamIds` so
   * callers can apply access control (INV-8). Ordered newest-first.
   *
   * Callers are responsible for passing a non-empty `filter` and at least one
   * accessible stream id — this repo returns `[]` for either empty input.
   */
  async findByMetadata(
    db: Querier,
    params: {
      streamIds: string[]
      filter: Record<string, string>
      streamId?: string
      limit?: number
    }
  ): Promise<Message[]> {
    if (params.streamIds.length === 0) return []
    if (Object.keys(params.filter).length === 0) return []
    const limit = params.limit ?? 20

    // If a specific streamId is given, intersect with accessible streams. This
    // pushes the access check into SQL so unauthorized streams never leak out
    // even if the handler forgot to pre-check access.
    let effectiveStreams: string[]
    if (params.streamId) {
      effectiveStreams = params.streamIds.includes(params.streamId) ? [params.streamId] : []
    } else {
      effectiveStreams = params.streamIds
    }
    if (effectiveStreams.length === 0) return []

    const result = await db.query<MessageRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM messages
      WHERE stream_id = ANY(${effectiveStreams})
        AND deleted_at IS NULL
        AND metadata @> ${JSON.stringify(params.filter)}::jsonb
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `)

    if (result.rows.length === 0) return []

    const messageIds = result.rows.map((r) => r.id)
    const reactionsResult = await db.query<ReactionRow>(sql`
      SELECT message_id, user_id, emoji FROM reactions
      WHERE message_id = ANY(${messageIds})
    `)
    const reactionsByMessage = aggregateReactionsByMessage(reactionsResult.rows)

    return result.rows.map((row) => mapRowToMessage(row, reactionsByMessage.get(row.id) ?? {}))
  },

  async updateContent(
    db: Querier,
    id: string,
    contentJson: JSONContent,
    contentMarkdown: string
  ): Promise<Message | null> {
    const result = await db.query<MessageRow>(sql`
      UPDATE messages
      SET content_json = ${JSON.stringify(contentJson)}, content_markdown = ${contentMarkdown}, edited_at = NOW()
      WHERE id = ${id}
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    if (!result.rows[0]) return null
    return this.findById(db, id)
  },

  async softDelete(db: Querier, id: string): Promise<Message | null> {
    const result = await db.query<MessageRow>(sql`
      UPDATE messages
      SET deleted_at = NOW()
      WHERE id = ${id}
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    if (!result.rows[0]) return null
    return this.findById(db, id)
  },

  async addReaction(db: Querier, messageId: string, emoji: string, userId: string): Promise<Message | null> {
    await db.query(sql`
      INSERT INTO reactions (message_id, user_id, emoji)
      VALUES (${messageId}, ${userId}, ${emoji})
      ON CONFLICT DO NOTHING
    `)
    return this.findById(db, messageId)
  },

  async removeReaction(db: Querier, messageId: string, emoji: string, userId: string): Promise<Message | null> {
    await db.query(sql`
      DELETE FROM reactions
      WHERE message_id = ${messageId}
        AND user_id = ${userId}
        AND emoji = ${emoji}
    `)
    return this.findById(db, messageId)
  },

  async incrementReplyCount(db: Querier, id: string): Promise<void> {
    await db.query(sql`
      UPDATE messages
      SET reply_count = reply_count + 1
      WHERE id = ${id}
    `)
  },

  async incrementReplyCountBy(db: Querier, id: string, count: number): Promise<void> {
    if (count <= 0) return
    await db.query(sql`
      UPDATE messages
      SET reply_count = reply_count + ${count}
      WHERE id = ${id}
    `)
  },

  async decrementReplyCount(db: Querier, id: string): Promise<void> {
    await db.query(sql`
      UPDATE messages
      SET reply_count = GREATEST(reply_count - 1, 0)
      WHERE id = ${id}
    `)
  },

  async decrementReplyCountBy(db: Querier, id: string, count: number): Promise<void> {
    if (count <= 0) return
    await db.query(sql`
      UPDATE messages
      SET reply_count = GREATEST(reply_count - ${count}, 0)
      WHERE id = ${id}
    `)
  },

  /**
   * Get reply counts for multiple messages.
   * Returns a map of messageId -> replyCount
   */
  async getReplyCountsBatch(db: Querier, messageIds: string[]): Promise<Map<string, number>> {
    if (messageIds.length === 0) return new Map()

    const result = await db.query<{ id: string; reply_count: number }>(sql`
      SELECT id, reply_count FROM messages
      WHERE id = ANY(${messageIds})
    `)

    const map = new Map<string, number>()
    for (const row of result.rows) {
      map.set(row.id, row.reply_count)
    }
    return map
  },

  /**
   * Count non-deleted messages in a stream. Used by surfaces that label a
   * stream by its size (e.g. context-bag chip strips: "12 messages in #intro").
   */
  async countByStream(db: Querier, streamId: string): Promise<number> {
    const result = await db.query<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM messages
      WHERE stream_id = ${streamId}
        AND deleted_at IS NULL
    `)
    return Number(result.rows[0]?.count ?? 0)
  },

  /**
   * Batched variant of `countByStream` — returns a Map keyed by streamId so a
   * caller fanning over N refs (context-bag, sidebar previews) can avoid an
   * N-query loop. Streams with no messages are absent from the map; callers
   * default to 0. INV-56.
   */
  async countByStreams(db: Querier, streamIds: string[]): Promise<Map<string, number>> {
    if (streamIds.length === 0) return new Map()
    const result = await db.query<{ stream_id: string; count: string }>(sql`
      SELECT stream_id, COUNT(*)::text AS count FROM messages
      WHERE stream_id = ANY(${streamIds})
        AND deleted_at IS NULL
      GROUP BY stream_id
    `)
    const out = new Map<string, number>()
    for (const row of result.rows) out.set(row.stream_id, Number(row.count))
    return out
  },

  /**
   * Update the embedding for a message.
   * Used by the embedding worker after generating embeddings.
   */
  async updateEmbedding(db: Querier, id: string, embedding: number[]): Promise<void> {
    const embeddingLiteral = `[${embedding.join(",")}]`
    await db.query(sql`
      UPDATE messages
      SET embedding = ${embeddingLiteral}::vector
      WHERE id = ${id}
    `)
  },

  /**
   * Find messages from threads rooted at the given parent messages.
   * Returns a map of parentMessageId -> thread messages (in chronological order).
   */
  async findThreadMessages(db: Querier, parentMessageIds: string[]): Promise<Map<string, Message[]>> {
    if (parentMessageIds.length === 0) return new Map()

    // Find thread streams for these parent messages and get their messages
    const result = await db.query<MessageRow & { parent_message_id: string }>(sql`
      SELECT
        ${sql.raw(QUALIFIED_SELECT_FIELDS)},
        s.parent_message_id
      FROM messages m
      JOIN streams s ON m.stream_id = s.id
      WHERE s.parent_message_id = ANY(${parentMessageIds})
        AND s.type = 'thread'
        AND m.deleted_at IS NULL
      ORDER BY m.created_at ASC, m.id ASC
    `)

    if (result.rows.length === 0) return new Map()

    // Fetch reactions for all messages
    const messageIds = result.rows.map((r) => r.id)
    const reactionsResult = await db.query<ReactionRow>(sql`
      SELECT message_id, user_id, emoji FROM reactions
      WHERE message_id = ANY(${messageIds})
    `)
    const reactionsByMessage = aggregateReactionsByMessage(reactionsResult.rows)

    // Group by parent message ID
    const byParent = new Map<string, Message[]>()
    for (const row of result.rows) {
      const parentId = row.parent_message_id
      const messages = byParent.get(parentId) ?? []
      messages.push(mapRowToMessage(row, reactionsByMessage.get(row.id) ?? {}))
      byParent.set(parentId, messages)
    }

    return byParent
  },

  /**
   * Find messages surrounding a target message in the same stream.
   * Returns up to `messagesBefore` messages before and `messagesAfter` messages after the target.
   * The target message itself is always included.
   * Messages are returned in chronological order (ascending sequence).
   */
  async findSurrounding(
    db: Querier,
    messageId: string,
    streamId: string,
    messagesBefore: number,
    messagesAfter: number
  ): Promise<Message[]> {
    // Get the target message's sequence number
    const targetResult = await db.query<{ sequence: string }>(
      sql`SELECT sequence FROM messages WHERE id = ${messageId} AND stream_id = ${streamId}`
    )
    if (!targetResult.rows[0]) return []
    const targetSequence = targetResult.rows[0].sequence

    // Get messages before and after (including the target)
    const result = await db.query<MessageRow>(sql`
      (
        SELECT ${sql.raw(SELECT_FIELDS)} FROM messages
        WHERE stream_id = ${streamId}
          AND sequence < ${targetSequence}
          AND deleted_at IS NULL
        ORDER BY sequence DESC
        LIMIT ${messagesBefore}
      )
      UNION ALL
      (
        SELECT ${sql.raw(SELECT_FIELDS)} FROM messages
        WHERE stream_id = ${streamId}
          AND sequence >= ${targetSequence}
          AND deleted_at IS NULL
        ORDER BY sequence ASC
        LIMIT ${messagesAfter + 1}
      )
      ORDER BY sequence ASC
    `)

    if (result.rows.length === 0) return []

    const messageIds = result.rows.map((r) => r.id)
    const reactionsResult = await db.query<ReactionRow>(sql`
      SELECT message_id, user_id, emoji FROM reactions
      WHERE message_id = ANY(${messageIds})
    `)
    const reactionsByMessage = aggregateReactionsByMessage(reactionsResult.rows)

    return result.rows.map((row) => mapRowToMessage(row, reactionsByMessage.get(row.id) ?? {}))
  },

  /**
   * List messages since a given sequence number.
   * Used by agents to check for new messages during their loop.
   */
  async listSince(
    db: Querier,
    streamId: string,
    sinceSequence: bigint,
    options?: { excludeAuthorId?: string; limit?: number }
  ): Promise<Message[]> {
    const limit = options?.limit ?? 50
    const excludeAuthorId = options?.excludeAuthorId

    let messageRows: MessageRow[]
    if (excludeAuthorId) {
      const result = await db.query<MessageRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS)} FROM messages
        WHERE stream_id = ${streamId}
          AND sequence > ${sinceSequence.toString()}
          AND author_id != ${excludeAuthorId}
          AND deleted_at IS NULL
        ORDER BY sequence ASC
        LIMIT ${limit}
      `)
      messageRows = result.rows
    } else {
      const result = await db.query<MessageRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS)} FROM messages
        WHERE stream_id = ${streamId}
          AND sequence > ${sinceSequence.toString()}
          AND deleted_at IS NULL
        ORDER BY sequence ASC
        LIMIT ${limit}
      `)
      messageRows = result.rows
    }

    if (messageRows.length === 0) return []

    const messageIds = messageRows.map((r) => r.id)
    const reactionsResult = await db.query<ReactionRow>(sql`
      SELECT message_id, user_id, emoji FROM reactions
      WHERE message_id = ANY(${messageIds})
    `)
    const reactionsByMessage = aggregateReactionsByMessage(reactionsResult.rows)

    return messageRows.map((row) => mapRowToMessage(row, reactionsByMessage.get(row.id) ?? {}))
  },

  /**
   * List messages in an inclusive sequence range.
   * Returns messages in chronological order.
   */
  async listBySequenceRange(
    db: Querier,
    streamId: string,
    startSequence: bigint,
    endSequence: bigint,
    options?: { limit?: number }
  ): Promise<Message[]> {
    if (endSequence < startSequence) return []

    const limit = options?.limit ?? 200
    const result = await db.query<MessageRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM messages
      WHERE stream_id = ${streamId}
        AND sequence >= ${startSequence.toString()}
        AND sequence <= ${endSequence.toString()}
        AND deleted_at IS NULL
      ORDER BY sequence ASC
      LIMIT ${limit}
    `)

    if (result.rows.length === 0) return []

    const messageIds = result.rows.map((r) => r.id)
    const reactionsResult = await db.query<ReactionRow>(sql`
      SELECT message_id, user_id, emoji FROM reactions
      WHERE message_id = ANY(${messageIds})
    `)
    const reactionsByMessage = aggregateReactionsByMessage(reactionsResult.rows)

    return result.rows.map((row) => mapRowToMessage(row, reactionsByMessage.get(row.id) ?? {}))
  },
}
