import { sql, type Querier } from "../../db"

/** How far a partner workspace has applied each host stream of a connection, by host event sequence. */
export const StreamConnectionCursorRepository = {
  async findForStream(db: Querier, workspaceId: string, connectionId: string, streamId: string): Promise<bigint> {
    const result = await db.query<{ host_sequence: string }>(sql`
      SELECT host_sequence FROM stream_connection_cursors
      WHERE workspace_id = ${workspaceId} AND connection_id = ${connectionId} AND stream_id = ${streamId}
    `)
    return result.rows[0] ? BigInt(result.rows[0].host_sequence) : 0n
  },

  async upsert(
    db: Querier,
    params: { workspaceId: string; connectionId: string; streamId: string; hostSequence: bigint }
  ): Promise<void> {
    await db.query(sql`
      INSERT INTO stream_connection_cursors (workspace_id, connection_id, stream_id, host_sequence)
      VALUES (${params.workspaceId}, ${params.connectionId}, ${params.streamId}, ${params.hostSequence.toString()})
      ON CONFLICT (workspace_id, connection_id, stream_id)
      DO UPDATE SET host_sequence = EXCLUDED.host_sequence, updated_at = NOW()
    `)
  },
}
