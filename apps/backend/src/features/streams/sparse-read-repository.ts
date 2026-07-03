import type { Querier } from "../../db"
import { sql } from "../../db"

/**
 * The result of a compaction probe: the greatest message_created event above a
 * member's watermark such that EVERY message from just-above-watermark up to and
 * including it is in the overlay. `null` when the first message above the
 * watermark isn't covered (nothing to absorb).
 */
export interface CompactionTarget {
  eventId: string
  sequence: bigint
}

/**
 * Data access for the sparse read overlay (`stream_member_message_reads`) —
 * individually-read messages above a (stream, member) watermark. Every method
 * is a composable primitive (INV-27); the ordering/transaction guarantees live
 * in the sparse-read application core, not here.
 */
export const SparseReadRepository = {
  /**
   * Bulk-insert overlay rows for `messageIds`, resolving each message's
   * `event_id`/`sequence` from its `message_created` event in `streamId` via the
   * unnest-join on `payload->>'messageId'` (the move flow's house pattern). Ids
   * with no message_created event in the stream are silently dropped (the join
   * yields no row). `ON CONFLICT DO NOTHING` (INV-20/56) — concurrent double
   * apply is idempotent.
   */
  async insertReads(
    db: Querier,
    params: { workspaceId: string; streamId: string; memberId: string; messageIds: string[] }
  ): Promise<void> {
    if (params.messageIds.length === 0) return
    await db.query(sql`
      INSERT INTO stream_member_message_reads (workspace_id, stream_id, member_id, message_id, event_id, sequence)
      SELECT ${params.workspaceId}, ${params.streamId}, ${params.memberId}, e.payload->>'messageId', e.id, e.sequence
      FROM unnest(${params.messageIds}::text[]) AS ids(message_id)
      JOIN stream_events e
        ON e.stream_id = ${params.streamId}
       AND e.event_type = 'message_created'
       AND e.payload->>'messageId' = ids.message_id
      ON CONFLICT (stream_id, member_id, message_id) DO NOTHING
    `)
  },

  /** Remove specific overlay rows by (stream, member, messageIds). */
  async deleteReads(db: Querier, streamId: string, memberId: string, messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return
    await db.query(sql`
      DELETE FROM stream_member_message_reads
      WHERE stream_id = ${streamId} AND member_id = ${memberId}
        AND message_id = ANY(${messageIds}::text[])
    `)
  },

  /** The overlay message ids for one (stream, member), ascending by sequence. */
  async listOverlayIds(db: Querier, streamId: string, memberId: string): Promise<string[]> {
    const result = await db.query<{ message_id: string }>(sql`
      SELECT message_id FROM stream_member_message_reads
      WHERE stream_id = ${streamId} AND member_id = ${memberId}
      ORDER BY sequence ASC
    `)
    return result.rows.map((r) => r.message_id)
  },

  /**
   * Overlay message ids for one member across many streams — the bootstrap
   * `readMessageIds` map in a single batch. Streams with no overlay row are
   * absent from the map (the caller omits empty streams anyway).
   */
  async listOverlayIdsForMember(db: Querier, memberId: string, streamIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>()
    if (streamIds.length === 0) return map
    const result = await db.query<{ stream_id: string; message_id: string }>(sql`
      SELECT stream_id, message_id FROM stream_member_message_reads
      WHERE member_id = ${memberId} AND stream_id = ANY(${streamIds}::text[])
      ORDER BY stream_id, sequence ASC
    `)
    for (const row of result.rows) {
      const list = map.get(row.stream_id)
      if (list) list.push(row.message_id)
      else map.set(row.stream_id, [row.message_id])
    }
    return map
  },

  /** Prune overlay rows at or below `sequence` — the watermark-advance invariant. */
  async pruneAtOrBelow(db: Querier, streamId: string, memberId: string, sequence: bigint): Promise<void> {
    await db.query(sql`
      DELETE FROM stream_member_message_reads
      WHERE stream_id = ${streamId} AND member_id = ${memberId}
        AND sequence <= ${sequence.toString()}
    `)
  },

  /**
   * Delete overlay rows at or above `sequence` — mark-unread's inverse. Regressing
   * to before message M means M and everything after it is unread, so overlay rows
   * for messages at/after M contradict the intent and are dropped.
   */
  async deleteAtOrAbove(db: Querier, streamId: string, memberId: string, sequence: bigint): Promise<void> {
    await db.query(sql`
      DELETE FROM stream_member_message_reads
      WHERE stream_id = ${streamId} AND member_id = ${memberId}
        AND sequence >= ${sequence.toString()}
    `)
  },

  /** Wipe all overlay rows for a member across the given streams (mark-all-as-read). */
  async deleteAllForStreams(db: Querier, memberId: string, streamIds: string[]): Promise<void> {
    if (streamIds.length === 0) return
    await db.query(sql`
      DELETE FROM stream_member_message_reads
      WHERE member_id = ${memberId} AND stream_id = ANY(${streamIds}::text[])
    `)
  },

  /**
   * The compaction target for (stream, member, watermarkSeq): the greatest
   * message_created event W such that every message with `watermarkSeq < sequence
   * <= W` is in the overlay. A window `bool_and(covered)` over ascending sequence
   * flips false at the first uncovered message and stays false, so the last row
   * still `true` is exactly W. `null` when the first message above the watermark
   * isn't covered (no absorbable run).
   */
  async findCompactionTarget(
    db: Querier,
    streamId: string,
    memberId: string,
    watermarkSeq: bigint
  ): Promise<CompactionTarget | null> {
    const result = await db.query<{ event_id: string; sequence: string }>(sql`
      WITH bound AS (
        SELECT MAX(sequence) AS max_seq FROM stream_member_message_reads
        WHERE stream_id = ${streamId} AND member_id = ${memberId}
      ),
      ordered AS (
        SELECT
          e.id AS event_id,
          e.sequence,
          (r.message_id IS NOT NULL) AS covered
        FROM stream_events e
        LEFT JOIN stream_member_message_reads r
          ON r.stream_id = e.stream_id
         AND r.member_id = ${memberId}
         AND r.message_id = e.payload->>'messageId'
        WHERE e.stream_id = ${streamId}
          AND e.event_type = 'message_created'
          AND e.sequence > ${watermarkSeq.toString()}
          -- The target must itself be covered, so the run can never extend past
          -- the overlay's max sequence; bounding here keeps the window scan
          -- proportional to the conversation span, not the member's whole unread
          -- backlog (a never-read busy channel would otherwise scan every event).
          AND e.sequence <= (SELECT max_seq FROM bound)
      ),
      runs AS (
        SELECT event_id, sequence, bool_and(covered) OVER (ORDER BY sequence ASC) AS contiguous
        FROM ordered
      )
      SELECT event_id, sequence FROM runs
      WHERE contiguous
      ORDER BY sequence DESC
      LIMIT 1
    `)
    const row = result.rows[0]
    return row ? { eventId: row.event_id, sequence: BigInt(row.sequence) } : null
  },

  /** Overlay row count for one (stream, member). */
  async countOverlay(db: Querier, streamId: string, memberId: string): Promise<number> {
    const result = await db.query<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM stream_member_message_reads
      WHERE stream_id = ${streamId} AND member_id = ${memberId}
    `)
    return parseInt(result.rows[0].count, 10)
  },

  /**
   * Rehome overlay rows for moved messages: refresh `stream_id`, `event_id`, and
   * `sequence` to the destination values. Runs AFTER the move relocated the
   * `message_created` rows, so the destination stream_events already carry the new
   * sequence; the join reads it back. Every member's overlay row for a moved
   * message follows the message.
   */
  async rehomeReads(
    db: Querier,
    params: { sourceStreamId: string; destinationStreamId: string; messageIds: string[] }
  ): Promise<void> {
    if (params.messageIds.length === 0) return
    await db.query(sql`
      UPDATE stream_member_message_reads r
      SET stream_id = ${params.destinationStreamId}, event_id = e.id, sequence = e.sequence
      FROM stream_events e
      WHERE r.stream_id = ${params.sourceStreamId}
        AND r.message_id = ANY(${params.messageIds}::text[])
        AND e.stream_id = ${params.destinationStreamId}
        AND e.event_type = 'message_created'
        AND e.payload->>'messageId' = r.message_id
    `)
  },
}
