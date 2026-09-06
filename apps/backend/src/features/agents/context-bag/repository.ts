import type { Querier } from "../../../db"
import { sql } from "../../../db"
import type { ContextBag, ContextIntent } from "@threahq/types"
import { streamContextAttachmentId } from "../../../lib/id"
import type { LastRenderedSnapshot, StoredContextBag } from "./types"

interface StreamContextAttachmentRow {
  id: string
  workspace_id: string
  stream_id: string
  intent: string
  refs: unknown
  last_rendered: unknown
  created_by: string
  created_at: Date
  updated_at: Date
}

function mapRow(row: StreamContextAttachmentRow): StoredContextBag {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    intent: row.intent as ContextIntent,
    refs: (row.refs ?? []) as ContextBag["refs"],
    lastRendered: (row.last_rendered ?? null) as LastRenderedSnapshot | null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const SELECT_FIELDS = `id, workspace_id, stream_id, intent, refs, last_rendered, created_by, created_at, updated_at`

export interface InsertContextBagParams {
  workspaceId: string
  streamId: string
  intent: ContextIntent
  refs: ContextBag["refs"]
  createdBy: string
}

export const ContextBagRepository = {
  /**
   * Look up the bag attached to a stream.
   *
   * Workspace-scoped per INV-8: cross-workspace queries cannot leak a bag
   * even if a streamId collision ever occurs. The unique index on
   * `(stream_id, intent)` from `20260425130000_context_bag_unique_intent`
   * makes the LIMIT 1 result deterministic for the v1 single-intent case;
   * an explicit `ORDER BY created_at ASC` pins behavior if multiple intents
   * land on the same stream later.
   */
  async findByStream(db: Querier, workspaceId: string, streamId: string): Promise<StoredContextBag | null> {
    const result = await db.query<StreamContextAttachmentRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM stream_context_attachments
      WHERE workspace_id = ${workspaceId}
        AND stream_id = ${streamId}
      ORDER BY created_at ASC
      LIMIT 1
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Race-safe upsert (INV-20). Two write paths can land here for the same
   * `(stream_id, intent)`: the `createScratchpad` transaction and the
   * standalone precompute endpoint. The unique index from
   * `20260425130000_context_bag_unique_intent` makes the conflict explicit; we
   * reconcile by replacing the refs payload (the latest writer wins on
   * payload, which matches user intent — they just pressed "send" with this
   * exact bag) and refreshing `updated_at`. `created_by`/`created_at` stay
   * pinned to the original author so audit history isn't rewritten.
   */
  async insert(db: Querier, params: InsertContextBagParams): Promise<StoredContextBag> {
    const id = streamContextAttachmentId()
    const refsJson = JSON.stringify(params.refs)
    const result = await db.query<StreamContextAttachmentRow>(sql`
      INSERT INTO stream_context_attachments (
        id, workspace_id, stream_id, intent, refs, created_by
      ) VALUES (
        ${id}, ${params.workspaceId}, ${params.streamId}, ${params.intent}, ${refsJson}::jsonb, ${params.createdBy}
      )
      ON CONFLICT (stream_id, intent) DO UPDATE
        SET refs = EXCLUDED.refs,
            updated_at = NOW()
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRow(result.rows[0])
  },

  /**
   * Workspace-scoped UPDATE per INV-8 — the snapshot only lands when the
   * row id actually belongs to the calling workspace. Idempotent.
   */
  async updateLastRendered(
    db: Querier,
    workspaceId: string,
    id: string,
    snapshot: LastRenderedSnapshot
  ): Promise<void> {
    const json = JSON.stringify(snapshot)
    await db.query(sql`
      UPDATE stream_context_attachments
      SET last_rendered = ${json}::jsonb, updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `)
  },
}
