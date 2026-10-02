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
  version: number
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
  /** Bumped on every queue; a batch acknowledges only the version it read. */
  version: number
}

export type PendingItemVersion = Pick<PendingMemoItem, "id" | "version">

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
    version: row.version,
  }
}

const SELECT_FIELDS = `id, workspace_id, stream_id, item_type, item_id, queued_at, processed_at, classified_fingerprint, version`

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
      SET version = memo_pending_items.version + 1,
          queued_at = CASE WHEN memo_pending_items.processed_at IS NULL THEN memo_pending_items.queued_at ELSE EXCLUDED.queued_at END,
          processed_at = NULL,
          failed_attempts = 0
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

  /** Items requeued since they were read keep their newer version and stay pending. */
  async markProcessed(client: PoolClient, workspaceId: string, items: PendingItemVersion[]): Promise<void> {
    if (items.length === 0) return

    await client.query(sql`
      UPDATE memo_pending_items AS p
      SET processed_at = NOW()
      FROM UNNEST(${items.map((i) => i.id)}::text[], ${items.map((i) => i.version)}::int[]) AS v(id, version)
      WHERE p.workspace_id = ${workspaceId} AND p.id = v.id AND p.version = v.version
    `)
  },

  /**
   * Count a failed attempt on each item still at the version read. An item that
   * reaches `maxAttempts` is marked processed, so it stops retrying until its
   * next requeue.
   */
  async recordFailedAttempts(
    client: PoolClient,
    workspaceId: string,
    items: PendingItemVersion[],
    maxAttempts: number
  ): Promise<PendingMemoItem[]> {
    if (items.length === 0) return []

    const result = await client.query<PendingItemRow>(sql`
      UPDATE memo_pending_items AS p
      SET failed_attempts = p.failed_attempts + 1,
          processed_at = CASE WHEN p.failed_attempts + 1 >= ${maxAttempts} THEN NOW() END
      FROM UNNEST(${items.map((i) => i.id)}::text[], ${items.map((i) => i.version)}::int[]) AS v(id, version)
      WHERE p.workspace_id = ${workspaceId} AND p.id = v.id AND p.version = v.version
      RETURNING p.*
    `)
    return result.rows.map(mapRowToPendingItem)
  },

  /**
   * Store what the classifier was shown, so the next pass over the same
   * conversation can tell whether the question has changed. Written only for
   * items that actually reached the model — a skipped item's stored digest is
   * still the right one, and a deferred item was never asked.
   */
  async recordClassifiedFingerprints(
    client: PoolClient,
    workspaceId: string,
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
      WHERE p.id = v.id AND p.workspace_id = ${workspaceId}
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
