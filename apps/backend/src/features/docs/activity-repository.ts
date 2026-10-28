import { sql, type Querier } from "../../db"

export interface DocActivityCursor {
  foldedSequence: bigint
  /** The doc's top-level block ids at the last fold; null before the first. */
  blockIds: string[] | null
}

export const DocActivityStateRepository = {
  /** Creates the doc's cursor row if missing and holds its row lock until the transaction ends. */
  async lockCursor(db: Querier, workspaceId: string, docId: string): Promise<DocActivityCursor> {
    const result = await db.query<{ folded_sequence: string; block_ids: string[] | null }>(sql`
      INSERT INTO doc_activity_state (workspace_id, doc_id)
      VALUES (${workspaceId}, ${docId})
      ON CONFLICT (workspace_id, doc_id) DO UPDATE SET folded_sequence = doc_activity_state.folded_sequence
      RETURNING folded_sequence, block_ids
    `)
    const row = result.rows[0]!
    return { foldedSequence: BigInt(row.folded_sequence), blockIds: row.block_ids }
  },

  /** Caller holds the row lock (`lockCursor`). */
  async setCursor(db: Querier, workspaceId: string, docId: string, cursor: DocActivityCursor): Promise<void> {
    await db.query(sql`
      UPDATE doc_activity_state
      SET folded_sequence = ${cursor.foldedSequence.toString()}, block_ids = ${cursor.blockIds}, updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND doc_id = ${docId}
    `)
  },
}
