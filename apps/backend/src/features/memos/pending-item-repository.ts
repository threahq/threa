import { PoolClient } from "pg"
import { sql } from "../../db"
import type { PendingItemType } from "@threahq/types"

interface PendingItemRow {
  id: string
  workspace_id: string
  stream_id: string
  item_type: string
  item_id: string
  queued_at: Date
  processed_at: Date | null
  classified_fingerprint: string | null
}

export interface PendingMemoItem {
  id: string
  workspaceId: string
  streamId: string
  itemType: PendingItemType
  itemId: string
  queuedAt: Date
  processedAt: Date | null
  /** Digest of the classifier inputs at the last pass; null = never classified. */
  classifiedFingerprint: string | null
}

export interface QueuePendingItemParams {
  id: string
  workspaceId: string
  streamId: string
  itemType: PendingItemType
  itemId: string
}

function mapRowToPendingItem(row: PendingItemRow): PendingMemoItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    itemType: row.item_type as PendingItemType,
    itemId: row.item_id,
    queuedAt: row.queued_at,
    processedAt: row.processed_at,
    classifiedFingerprint: row.classified_fingerprint,
  }
}

const SELECT_FIELDS = `id, workspace_id, stream_id, item_type, item_id, queued_at, processed_at, classified_fingerprint`

export const PendingItemRepository = {
  async queue(client: PoolClient, items: QueuePendingItemParams[]): Promise<PendingMemoItem[]> {
    if (items.length === 0) return []

    const result = await client.query<PendingItemRow>(sql`
      INSERT INTO memo_pending_items (id, workspace_id, stream_id, item_type, item_id)
      SELECT * FROM UNNEST(
        ${items.map((i) => i.id)}::text[],
        ${items.map((i) => i.workspaceId)}::text[],
        ${items.map((i) => i.streamId)}::text[],
        ${items.map((i) => i.itemType)}::text[],
        ${items.map((i) => i.itemId)}::text[]
      )
      ON CONFLICT (workspace_id, item_type, item_id) DO UPDATE
      SET queued_at = EXCLUDED.queued_at,
          processed_at = NULL
      WHERE memo_pending_items.processed_at IS NOT NULL
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return result.rows.map(mapRowToPendingItem)
  },

  async findUnprocessed(
    client: PoolClient,
    workspaceId: string,
    streamId: string,
    options?: { limit?: number }
  ): Promise<PendingMemoItem[]> {
    const limit = options?.limit ?? 50

    const result = await client.query<PendingItemRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM memo_pending_items
      WHERE workspace_id = ${workspaceId}
        AND stream_id = ${streamId}
        AND processed_at IS NULL
      ORDER BY queued_at ASC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToPendingItem)
  },

  async markProcessed(client: PoolClient, ids: string[]): Promise<void> {
    if (ids.length === 0) return

    await client.query(sql`
      UPDATE memo_pending_items
      SET processed_at = NOW()
      WHERE id = ANY(${ids})
    `)
  },

  /**
   * Store what the classifier was shown, so the next pass over the same
   * conversation can tell whether the question has changed. Written only for
   * items that actually reached the model — a skipped item's stored digest is
   * still the right one, and a deferred item was never asked.
   */
  async recordClassifiedFingerprints(
    client: PoolClient,
    entries: Array<{ id: string; fingerprint: string }>
  ): Promise<void> {
    if (entries.length === 0) return

    await client.query(sql`
      UPDATE memo_pending_items AS p
      SET classified_fingerprint = v.fingerprint
      FROM UNNEST(
        ${entries.map((e) => e.id)}::text[],
        ${entries.map((e) => e.fingerprint)}::text[]
      ) AS v(id, fingerprint)
      WHERE p.id = v.id
    `)
  },

  async countUnprocessed(client: PoolClient, workspaceId: string, streamId?: string): Promise<number> {
    if (streamId) {
      const result = await client.query<{ count: string }>(sql`
        SELECT COUNT(*) as count FROM memo_pending_items
        WHERE workspace_id = ${workspaceId}
          AND stream_id = ${streamId}
          AND processed_at IS NULL
      `)
      return parseInt(result.rows[0].count, 10)
    }

    const result = await client.query<{ count: string }>(sql`
      SELECT COUNT(*) as count FROM memo_pending_items
      WHERE workspace_id = ${workspaceId}
        AND processed_at IS NULL
    `)
    return parseInt(result.rows[0].count, 10)
  },
}
