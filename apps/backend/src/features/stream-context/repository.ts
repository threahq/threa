import { sql, type Querier } from "../../db"
import type { NewStreamContextItem } from "./types"

export const StreamContextRepository = {
  /**
   * Set-based insert (INV-56), idempotent on the identity index so retries and
   * the backfill can coexist with the write path.
   */
  async insertMany(db: Querier, rows: NewStreamContextItem[]): Promise<number> {
    if (rows.length === 0) return 0
    const result = await db.query(sql`
      INSERT INTO stream_context_items (
        id, workspace_id, stream_id, root_stream_id, category, ref_kind, ref_id, group_key,
        source_message_id, author_id, occurred_at, sequence, snippet, detail
      )
      SELECT * FROM UNNEST(
        ${rows.map((r) => r.id)}::text[],
        ${rows.map((r) => r.workspaceId)}::text[],
        ${rows.map((r) => r.streamId)}::text[],
        ${rows.map((r) => r.rootStreamId)}::text[],
        ${rows.map((r) => r.category)}::text[],
        ${rows.map((r) => r.refKind)}::text[],
        ${rows.map((r) => r.refId)}::text[],
        ${rows.map((r) => r.groupKey)}::text[],
        ${rows.map((r) => r.sourceMessageId)}::text[],
        ${rows.map((r) => r.authorId)}::text[],
        ${rows.map((r) => r.occurredAt)}::timestamptz[],
        ${rows.map((r) => (r.sequence === null ? null : r.sequence.toString()))}::bigint[],
        ${rows.map((r) => r.snippet)}::text[],
        ${rows.map((r) => JSON.stringify(r.detail))}::jsonb[]
      )
      ON CONFLICT (workspace_id, stream_id, category, ref_id, COALESCE(source_message_id, '')) DO NOTHING
    `)
    return result.rowCount ?? 0
  },

  async deleteByMessageId(db: Querier, workspaceId: string, messageId: string): Promise<number> {
    const result = await db.query(sql`
      DELETE FROM stream_context_items
      WHERE workspace_id = ${workspaceId}
        AND source_message_id = ${messageId}
    `)
    return result.rowCount ?? 0
  },

  /** Delete-then-insert refresh for an edited message. The caller owns the transaction. */
  async replaceForMessage(
    db: Querier,
    workspaceId: string,
    messageId: string,
    rows: NewStreamContextItem[]
  ): Promise<number> {
    await this.deleteByMessageId(db, workspaceId, messageId)
    return this.insertMany(db, rows)
  },

  /**
   * Re-home every row owned by the moved messages onto the destination thread.
   * The move re-sequences the messages in the destination stream, so the rows'
   * `sequence` has to be rewritten too — keeping the source stream's number
   * would make it a tie-break/jump key from a different counter.
   */
  async reparentMessages(
    db: Querier,
    workspaceId: string,
    messages: Array<{ messageId: string; sequence: bigint }>,
    streamId: string,
    rootStreamId: string
  ): Promise<number> {
    if (messages.length === 0) return 0
    const result = await db.query(sql`
      UPDATE stream_context_items AS sci
      SET stream_id = ${streamId}, root_stream_id = ${rootStreamId}, sequence = moved.sequence
      FROM (
        SELECT * FROM UNNEST(
          ${messages.map((m) => m.messageId)}::text[],
          ${messages.map((m) => m.sequence.toString())}::bigint[]
        ) AS t(message_id, sequence)
      ) AS moved
      WHERE sci.workspace_id = ${workspaceId}
        AND sci.source_message_id = moved.message_id
    `)
    return result.rowCount ?? 0
  },
}
