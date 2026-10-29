import { sql, type Querier } from "../../db"
import { MESSAGE_BODY_CONTEXT_CATEGORIES, type ContextCategory, type NewStreamContextItem } from "./types"

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

  async deleteByIds(db: Querier, workspaceId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    const result = await db.query(sql`
      DELETE FROM stream_context_items
      WHERE workspace_id = ${workspaceId}
        AND id = ANY(${ids})
    `)
    return result.rowCount ?? 0
  },

  /** A moved doc's subtree takes the new root; the rows stay on the streams they were written on. */
  async reRootStreams(db: Querier, workspaceId: string, streamIds: string[], rootStreamId: string): Promise<number> {
    if (streamIds.length === 0) return 0
    const result = await db.query(sql`
      UPDATE stream_context_items
      SET root_stream_id = ${rootStreamId}
      WHERE workspace_id = ${workspaceId}
        AND stream_id = ANY(${streamIds})
    `)
    return result.rowCount ?? 0
  },

  /** The row a doc's hosting writes on its host; a chip of the doc inside a message is a separate row and stays. */
  async deleteHostedDoc(db: Querier, workspaceId: string, hostStreamId: string, docId: string): Promise<number> {
    const result = await db.query(sql`
      DELETE FROM stream_context_items
      WHERE workspace_id = ${workspaceId}
        AND stream_id = ${hostStreamId}
        AND category = 'doc'
        AND ref_id = ${docId}
        AND source_message_id IS NULL
    `)
    return result.rowCount ?? 0
  },

  async deleteByMessageId(
    db: Querier,
    workspaceId: string,
    messageId: string,
    categories?: readonly ContextCategory[]
  ): Promise<number> {
    const result = categories
      ? await db.query(sql`
          DELETE FROM stream_context_items
          WHERE workspace_id = ${workspaceId}
            AND source_message_id = ${messageId}
            AND category = ANY(${[...categories]}::text[])
        `)
      : await db.query(sql`
          DELETE FROM stream_context_items
          WHERE workspace_id = ${workspaceId}
            AND source_message_id = ${messageId}
        `)
    return result.rowCount ?? 0
  },

  /**
   * Delete-then-insert refresh for an edited message. The caller owns the
   * transaction. Scoped to the categories a message body owns: memo and thread
   * landmarks also carry this `source_message_id` and no path re-creates them.
   */
  async replaceForMessage(
    db: Querier,
    workspaceId: string,
    messageId: string,
    rows: NewStreamContextItem[]
  ): Promise<number> {
    await this.deleteByMessageId(db, workspaceId, messageId, MESSAGE_BODY_CONTEXT_CATEGORIES)
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
