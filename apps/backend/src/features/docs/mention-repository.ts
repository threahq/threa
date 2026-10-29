import { sql, type Querier } from "../../db"

export interface DocMentionClaim {
  blockId: string
  userId: string
}

export const DocMentionStateRepository = {
  /**
   * Creates the (doc, author) row if missing and holds its row lock until the transaction ends.
   * `now` is the transaction's database clock, the one `stream_events.created_at` is stamped with.
   */
  async lockSettledSequence(
    db: Querier,
    workspaceId: string,
    docId: string,
    actorId: string
  ): Promise<{ settledSequence: bigint; now: Date }> {
    const result = await db.query<{ settled_sequence: string; now: Date }>(sql`
      INSERT INTO doc_mention_state (workspace_id, doc_id, actor_id)
      VALUES (${workspaceId}, ${docId}, ${actorId})
      ON CONFLICT (workspace_id, doc_id, actor_id) DO UPDATE SET settled_sequence = doc_mention_state.settled_sequence
      RETURNING settled_sequence, NOW() AS now
    `)
    const row = result.rows[0]!
    return { settledSequence: BigInt(row.settled_sequence), now: row.now }
  },

  /** Caller holds the row lock (`lockSettledSequence`). */
  async setSettledSequence(
    db: Querier,
    workspaceId: string,
    docId: string,
    actorId: string,
    settledSequence: bigint
  ): Promise<void> {
    await db.query(sql`
      UPDATE doc_mention_state
      SET settled_sequence = ${settledSequence.toString()}, updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND doc_id = ${docId} AND actor_id = ${actorId}
    `)
  },

  /** The blocks the author's latest block-touching write touched, as last recorded; null before the first. */
  async findLastBlockIds(db: Querier, workspaceId: string, docId: string, actorId: string): Promise<string[] | null> {
    const result = await db.query<{ last_block_ids: string[] | null }>(sql`
      SELECT last_block_ids FROM doc_mention_state
      WHERE workspace_id = ${workspaceId} AND doc_id = ${docId} AND actor_id = ${actorId}
    `)
    return result.rows[0]?.last_block_ids ?? null
  },

  async setLastBlockIds(
    db: Querier,
    workspaceId: string,
    docId: string,
    actorId: string,
    blockIds: string[]
  ): Promise<void> {
    await db.query(sql`
      INSERT INTO doc_mention_state (workspace_id, doc_id, actor_id, last_block_ids)
      VALUES (${workspaceId}, ${docId}, ${actorId}, ${blockIds})
      ON CONFLICT (workspace_id, doc_id, actor_id)
      DO UPDATE SET last_block_ids = EXCLUDED.last_block_ids, updated_at = NOW()
    `)
  },
}

export const DocMentionEditRepository = {
  /** Per block, the latest `doc:edited` sequence after `afterSequence` at which an actor other than `actorId` touched it. */
  async latestTouchesByOthers(
    db: Querier,
    params: { workspaceId: string; docId: string; actorId: string; afterSequence: bigint; blockIds: string[] }
  ): Promise<Map<string, bigint>> {
    if (params.blockIds.length === 0) return new Map()
    const result = await db.query<{ block_id: string; sequence: string }>(sql`
      SELECT touched.block_id, MAX(se.sequence)::text AS sequence
      FROM stream_events se
      CROSS JOIN LATERAL jsonb_array_elements_text(se.payload->'touchedBlockIds') AS touched(block_id)
      WHERE se.workspace_id = ${params.workspaceId}
        AND se.stream_id = ${params.docId}
        AND se.event_type = 'doc:edited'
        AND se.actor_id <> ${params.actorId}
        AND se.sequence > ${params.afterSequence.toString()}
        AND touched.block_id = ANY(${params.blockIds}::text[])
      GROUP BY touched.block_id
    `)
    return new Map(result.rows.map((row) => [row.block_id, BigInt(row.sequence)]))
  },
}

export const DocMentionNotificationRepository = {
  /** Claims each (block, user) pair not already notified; returns only the pairs this call claimed. */
  async claim(
    db: Querier,
    params: { workspaceId: string; docId: string; actorId: string; claims: DocMentionClaim[] }
  ): Promise<DocMentionClaim[]> {
    if (params.claims.length === 0) return []
    const result = await db.query<{ block_id: string; user_id: string }>(sql`
      INSERT INTO doc_mention_notifications (workspace_id, doc_id, block_id, user_id, actor_id)
      SELECT ${params.workspaceId}, ${params.docId}, t.block_id, t.user_id, ${params.actorId}
      FROM UNNEST(
        ${params.claims.map((claim) => claim.blockId)}::text[],
        ${params.claims.map((claim) => claim.userId)}::text[]
      ) AS t(block_id, user_id)
      ON CONFLICT (workspace_id, doc_id, block_id, user_id) DO NOTHING
      RETURNING block_id, user_id
    `)
    return result.rows.map((row) => ({ blockId: row.block_id, userId: row.user_id }))
  },
}
