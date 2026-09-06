import type { Querier } from "../../db"
import { sql } from "../../db"
import {
  ScheduledMessageStatuses,
  type ScheduledMessageStatus,
  type JSONContent,
  type ConversationDirective,
} from "@threahq/types"

interface ScheduledMessageRow {
  id: string
  workspace_id: string
  user_id: string
  stream_id: string
  parent_anchor_id: string | null
  content_json: JSONContent
  content_markdown: string
  attachment_ids: string[]
  metadata: Record<string, string> | null
  conversation_directive: ConversationDirective | null
  scheduled_for: Date
  status: string
  sent_message_id: string | null
  last_error: string | null
  queue_message_id: string | null
  edit_active_until: Date | null
  client_message_id: string | null
  retry_count: number
  version: number
  created_at: Date
  updated_at: Date
  status_changed_at: Date
}

export interface ScheduledMessage {
  id: string
  workspaceId: string
  userId: string
  streamId: string
  parentMessageId: string | null
  contentJson: JSONContent
  contentMarkdown: string
  attachmentIds: string[]
  metadata: Record<string, string> | null
  /**
   * Declared conversation for the delivered message ("Reply in conversation"
   * armed at schedule time), forwarded to `EventService.createMessage` at fire
   * time. Null → the async extractor infers the conversation, same as a live
   * send with no directive.
   */
  conversationDirective: ConversationDirective | null
  scheduledFor: Date
  status: ScheduledMessageStatus
  sentMessageId: string | null
  lastError: string | null
  queueMessageId: string | null
  /**
   * Worker fence — the worker won't fire while this is in the future. Bumped
   * by `lockForEdit` when a user opens the edit dialog. Anonymous (no owner):
   * multiple editors share the fence and any of them keeps the worker out.
   * First save wins via `version` CAS, not via this fence.
   */
  editActiveUntil: Date | null
  clientMessageId: string | null
  retryCount: number
  /**
   * Optimistic-concurrency version. Starts at 1; every UPDATE that represents
   * a logical state change increments it. The `update` CAS rejects when the
   * caller's `expectedVersion` doesn't match the stored value — first save
   * wins, second save 409s STALE_VERSION. Fence bumps (`edit_active_until`)
   * deliberately do NOT touch this so heartbeats can't invalidate an open
   * editor's expected version.
   */
  version: number
  createdAt: Date
  updatedAt: Date
  statusChangedAt: Date
}

export interface InsertScheduledMessageParams {
  id: string
  workspaceId: string
  userId: string
  streamId: string
  parentMessageId: string | null
  contentJson: JSONContent
  contentMarkdown: string
  attachmentIds: string[]
  metadata: Record<string, string> | null
  conversationDirective: ConversationDirective | null
  scheduledFor: Date
  clientMessageId: string | null
}

export interface ListScheduledOpts {
  status: ScheduledMessageStatus
  streamId?: string
  limit?: number
  cursor?: string
}

const COLUMNS =
  "id, workspace_id, user_id, stream_id, parent_anchor_id, content_json, content_markdown, attachment_ids, metadata, conversation_directive, scheduled_for, status, sent_message_id, last_error, queue_message_id, edit_active_until, client_message_id, retry_count, version, created_at, updated_at, status_changed_at"

function mapRow(row: ScheduledMessageRow): ScheduledMessage {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    streamId: row.stream_id,
    parentMessageId: row.parent_anchor_id,
    contentJson: row.content_json,
    contentMarkdown: row.content_markdown,
    attachmentIds: Array.isArray(row.attachment_ids) ? row.attachment_ids : [],
    metadata: row.metadata,
    conversationDirective: row.conversation_directive,
    scheduledFor: row.scheduled_for,
    status: row.status as ScheduledMessageStatus,
    sentMessageId: row.sent_message_id,
    lastError: row.last_error,
    queueMessageId: row.queue_message_id,
    editActiveUntil: row.edit_active_until,
    clientMessageId: row.client_message_id,
    retryCount: row.retry_count,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    statusChangedAt: row.status_changed_at,
  }
}

export const ScheduledMessagesRepository = {
  /**
   * Insert a new scheduled message. The (workspace_id, user_id,
   * client_message_id) unique index makes the create idempotent across
   * optimistic retries — if the same client_message_id was already inserted,
   * this throws a unique violation and the service catches it to return the
   * existing row.
   */
  async insert(db: Querier, params: InsertScheduledMessageParams): Promise<ScheduledMessage> {
    const result = await db.query<ScheduledMessageRow>(sql`
      INSERT INTO scheduled_messages (
        id, workspace_id, user_id, stream_id, parent_anchor_id,
        content_json, content_markdown, attachment_ids, metadata,
        conversation_directive, scheduled_for, status, client_message_id
      )
      VALUES (
        ${params.id},
        ${params.workspaceId},
        ${params.userId},
        ${params.streamId},
        ${params.parentMessageId},
        ${JSON.stringify(params.contentJson)}::jsonb,
        ${params.contentMarkdown},
        ${JSON.stringify(params.attachmentIds)}::jsonb,
        ${params.metadata ? JSON.stringify(params.metadata) : null}::jsonb,
        ${params.conversationDirective ? JSON.stringify(params.conversationDirective) : null}::jsonb,
        ${params.scheduledFor},
        ${ScheduledMessageStatuses.PENDING},
        ${params.clientMessageId}
      )
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return mapRow(result.rows[0]!)
  },

  async findById(db: Querier, workspaceId: string, userId: string, id: string): Promise<ScheduledMessage | null> {
    const result = await db.query<ScheduledMessageRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM scheduled_messages
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Worker entry point — looks up a row by (workspaceId, id). Used by the
   * fire worker which receives both ids in the queue payload (INV-8: every
   * read filters on workspace_id even when the primary key is unique).
   */
  async findByIdScoped(db: Querier, workspaceId: string, id: string): Promise<ScheduledMessage | null> {
    const result = await db.query<ScheduledMessageRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM scheduled_messages
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async findByClientMessageId(
    db: Querier,
    workspaceId: string,
    userId: string,
    clientMessageId: string
  ): Promise<ScheduledMessage | null> {
    const result = await db.query<ScheduledMessageRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM scheduled_messages
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND client_message_id = ${clientMessageId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * List rows for a user filtered by status. `pending` orders by scheduled_for
   * ASC; everything else by status_changed_at DESC. Cursor uses tuple
   * comparison so two rows that share the order column don't get skipped.
   */
  async listByUser(
    db: Querier,
    workspaceId: string,
    userId: string,
    opts: ListScheduledOpts
  ): Promise<ScheduledMessage[]> {
    const limit = opts.limit ?? 50
    const hasCursor = opts.cursor !== undefined
    const cursor = opts.cursor ?? ""
    const usePending = opts.status === ScheduledMessageStatuses.PENDING
    const streamFilter = opts.streamId ?? null

    const orderColumn = usePending ? "scheduled_for" : "status_changed_at"
    const direction = usePending ? "ASC" : "DESC"
    const cursorOp = usePending ? ">" : "<"

    const result = await db.query<ScheduledMessageRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM scheduled_messages
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND status = ${opts.status}
        AND (${streamFilter}::text IS NULL OR stream_id = ${streamFilter})
        AND (${!hasCursor} OR (${sql.raw(orderColumn)}, id) ${sql.raw(cursorOp)} (
          SELECT ${sql.raw(orderColumn)}, id FROM scheduled_messages
          WHERE id = ${cursor} AND workspace_id = ${workspaceId} AND user_id = ${userId}
        ))
      ORDER BY ${sql.raw(orderColumn)} ${sql.raw(direction)}, id ${sql.raw(direction)}
      LIMIT ${limit}
    `)
    return result.rows.map(mapRow)
  },

  /**
   * Optimistic concurrency update. Caller passes the `version` it last saw;
   * the CAS rejects when the row has moved on (another save / worker fire /
   * cancel landed). On rejection the caller surfaces a 409 STALE_VERSION so
   * the client can refresh and prompt the user.
   *
   * Multiple editors are supported — only the first save lands; the second
   * gets STALE_VERSION instead of an exclusive-lock 409. The status guard
   * keeps the worker from racing the editor in this same path; the worker
   * holds `status = 'sending'` once it claims the row.
   *
   * `scheduledFor`, `contentJson`, `contentMarkdown`, `attachmentIds`, and
   * `metadata` are all optional; passing `undefined` leaves the column
   * untouched. Passing `null` (where allowed) clears it.
   */
  async update(
    db: Querier,
    params: {
      workspaceId: string
      userId: string
      id: string
      expectedVersion: number
      contentJson?: JSONContent
      contentMarkdown?: string
      attachmentIds?: string[]
      metadata?: Record<string, string> | null
      scheduledFor?: Date
    }
  ): Promise<ScheduledMessage | null> {
    const result = await db.query<ScheduledMessageRow>(sql`
      UPDATE scheduled_messages SET
        content_json = COALESCE(${
          params.contentJson === undefined ? null : JSON.stringify(params.contentJson)
        }::jsonb, content_json),
        content_markdown = COALESCE(${params.contentMarkdown ?? null}, content_markdown),
        attachment_ids = COALESCE(${
          params.attachmentIds === undefined ? null : JSON.stringify(params.attachmentIds)
        }::jsonb, attachment_ids),
        metadata = CASE
          WHEN ${params.metadata === undefined}::boolean THEN metadata
          ELSE ${params.metadata ? JSON.stringify(params.metadata) : null}::jsonb
        END,
        scheduled_for = COALESCE(${params.scheduledFor ?? null}, scheduled_for),
        updated_at = NOW(),
        version = version + 1
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND user_id = ${params.userId}
        AND status = ${ScheduledMessageStatuses.PENDING}
        AND version = ${params.expectedVersion}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Bump the worker fence so an editor session keeps the worker out for the
   * next `ttlSeconds`. Anonymous — any caller (any device, any tab) can bump
   * it; the fence is purely "is anyone editing right now?" not "who owns the
   * row?". Returns the row when the bump landed, null when the row was no
   * longer pending (worker won, user cancelled).
   *
   * Critically does NOT touch `version` — the optimistic CAS in `update()`.
   * If the fence bump bumped it, heartbeats from any device would invalidate
   * the editor's `expectedVersion` and the next save would 409 STALE_VERSION
   * even though no content actually changed.
   */
  async bumpEditFence(
    db: Querier,
    params: { workspaceId: string; id: string; ttlSeconds: number }
  ): Promise<ScheduledMessage | null> {
    const result = await db.query<ScheduledMessageRow>(sql`
      UPDATE scheduled_messages SET
        edit_active_until = GREATEST(
          edit_active_until,
          NOW() + (${params.ttlSeconds} || ' seconds')::interval
        )
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND status = ${ScheduledMessageStatuses.PENDING}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Clear the worker fence so the worker can fire immediately. Called by
   * the dialog's close handler so cancelling out doesn't strand the row
   * behind a 10-minute fence the user no longer cares about. Idempotent
   * and tolerant of post-pending rows (it's a no-op if the row is no
   * longer pending). Like `bumpEditFence`, does NOT touch `version` —
   * the fence is metadata.
   */
  async releaseEditFence(db: Querier, workspaceId: string, id: string): Promise<void> {
    await db.query(sql`
      UPDATE scheduled_messages SET
        edit_active_until = NULL
      WHERE id = ${id}
        AND workspace_id = ${workspaceId}
        AND status = ${ScheduledMessageStatuses.PENDING}
    `)
  },

  /**
   * Race-safe worker CAS (INV-20). Flips status to `sending` when the row is
   * still pending, due now, and no editor session is currently active (the
   * fence has expired).
   *
   * The fence (`edit_active_until`) blocks the WORKER from firing while a
   * user has the edit dialog open — that's the only thing it's for.
   * User-initiated transitions (a save with past `scheduled_for`, or a
   * `sendNow`) pass `bypassFence: true` so the user's own dialog lock
   * doesn't block their own send. Without that, the row gets stuck: the
   * worker defers because of the fence, and the user's PATCH 409s with
   * NOT_PENDING because of the same fence.
   *
   * `force: true` additionally drops the `scheduled_for <= NOW()` guard so a
   * user-initiated Send Now fires a still-future row immediately. This anchors
   * the send on the DB clock (the CAS) rather than a JS `new Date()`: forcing
   * a future row by rewriting `scheduled_for = new Date()` and re-running the
   * guard raced app↔DB clock skew — an app clock a few hundred ms ahead of
   * Postgres put the rewritten time just past the DB's NOW() and the send
   * silently 409'd. Only the user-initiated `sendNow` path forces; the worker
   * and the past-time save keep the guard.
   *
   * Returns null on:
   *  - status not pending (cancelled, already sending/sent, failed)
   *  - scheduled_for in the future AND `force` is false (stale leased queue
   *    row that survived a reschedule cancel — see service.fire's pre-check)
   *  - edit_active_until in the future AND `bypassFence` is false (worker
   *    path only; an editor is active, defer)
   */
  async tryStartSend(
    db: Querier,
    params: { workspaceId: string; id: string; ttlSeconds: number; bypassFence?: boolean; force?: boolean }
  ): Promise<ScheduledMessage | null> {
    const bypassFence = params.bypassFence ?? false
    const force = params.force ?? false
    const result = await db.query<ScheduledMessageRow>(sql`
      UPDATE scheduled_messages SET
        status = ${ScheduledMessageStatuses.SENDING},
        status_changed_at = NOW(),
        edit_active_until = NOW() + (${params.ttlSeconds} || ' seconds')::interval,
        updated_at = NOW(),
        version = version + 1
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND status = ${ScheduledMessageStatuses.PENDING}
        AND (${force}::boolean OR scheduled_for <= NOW())
        AND (
          ${bypassFence}::boolean
          OR edit_active_until IS NULL
          OR edit_active_until <= NOW()
        )
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Mark a row sent. The `sending` status guard makes the transition idempotent
   * — two competing finalizers (worker + atomic-PATCH-when-past-time) can both
   * run their own CAS-to-sending and only one will land.
   */
  async markSent(
    db: Querier,
    params: { workspaceId: string; id: string; sentMessageId: string }
  ): Promise<ScheduledMessage | null> {
    const result = await db.query<ScheduledMessageRow>(sql`
      UPDATE scheduled_messages SET
        status = ${ScheduledMessageStatuses.SENT},
        sent_message_id = ${params.sentMessageId},
        edit_active_until = NULL,
        last_error = NULL,
        status_changed_at = NOW(),
        updated_at = NOW(),
        version = version + 1
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND status = ${ScheduledMessageStatuses.SENDING}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async markFailed(
    db: Querier,
    params: { workspaceId: string; id: string; reason: string }
  ): Promise<ScheduledMessage | null> {
    const result = await db.query<ScheduledMessageRow>(sql`
      UPDATE scheduled_messages SET
        status = ${ScheduledMessageStatuses.FAILED},
        last_error = ${params.reason},
        edit_active_until = NULL,
        status_changed_at = NOW(),
        updated_at = NOW(),
        version = version + 1
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND status IN (${ScheduledMessageStatuses.PENDING}, ${ScheduledMessageStatuses.SENDING})
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async incrementRetryCount(db: Querier, workspaceId: string, id: string): Promise<number> {
    const result = await db.query<{ retry_count: number }>(sql`
      UPDATE scheduled_messages SET
        retry_count = retry_count + 1,
        updated_at = NOW(),
        version = version + 1
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING retry_count
    `)
    return result.rows[0]?.retry_count ?? 0
  },

  async setQueueMessageId(db: Querier, workspaceId: string, id: string, queueMessageId: string | null): Promise<void> {
    await db.query(sql`
      UPDATE scheduled_messages SET
        queue_message_id = ${queueMessageId},
        updated_at = NOW(),
        version = version + 1
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
  },

  async cancel(db: Querier, workspaceId: string, userId: string, id: string): Promise<ScheduledMessage | null> {
    const result = await db.query<ScheduledMessageRow>(sql`
      UPDATE scheduled_messages SET
        status = ${ScheduledMessageStatuses.CANCELLED},
        edit_active_until = NULL,
        status_changed_at = NOW(),
        updated_at = NOW(),
        version = version + 1
      WHERE id = ${id}
        AND workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND status = ${ScheduledMessageStatuses.PENDING}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },
}
