import { sql, type Querier } from "../../db"

interface StreamStateRow {
  workspace_id: string
  stream_id: string
  last_processed_at: Date | null
  last_activity_at: Date
}

export interface MemoStreamState {
  workspaceId: string
  streamId: string
  lastProcessedAt: Date | null
  lastActivityAt: Date
}

export interface StreamReadyToProcess {
  workspaceId: string
  streamId: string
}

function mapRowToStreamState(row: StreamStateRow): MemoStreamState {
  return {
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    lastProcessedAt: row.last_processed_at,
    lastActivityAt: row.last_activity_at,
  }
}

const SELECT_FIELDS = `workspace_id, stream_id, last_processed_at, last_activity_at`

export const StreamStateRepository = {
  async findByStream(db: Querier, workspaceId: string, streamId: string): Promise<MemoStreamState | null> {
    const result = await db.query<StreamStateRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM memo_stream_state
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
    `)
    if (!result.rows[0]) return null
    return mapRowToStreamState(result.rows[0])
  },

  async upsertActivity(db: Querier, workspaceId: string, streamId: string): Promise<void> {
    await db.query(sql`
      INSERT INTO memo_stream_state (workspace_id, stream_id, last_activity_at)
      VALUES (${workspaceId}, ${streamId}, NOW())
      ON CONFLICT (workspace_id, stream_id) DO UPDATE
      SET last_activity_at = NOW()
    `)
  },

  /** Claims the stream for one batch unless another batch holds a live claim. */
  async claimBatch(
    db: Querier,
    workspaceId: string,
    streamId: string,
    token: string,
    leaseSeconds: number
  ): Promise<boolean> {
    const result = await db.query(sql`
      INSERT INTO memo_stream_state (workspace_id, stream_id, batch_claim_token, batch_claim_expires_at)
      VALUES (${workspaceId}, ${streamId}, ${token}, NOW() + INTERVAL '1 second' * ${leaseSeconds})
      ON CONFLICT (workspace_id, stream_id) DO UPDATE
      SET batch_claim_token = EXCLUDED.batch_claim_token, batch_claim_expires_at = EXCLUDED.batch_claim_expires_at
      WHERE memo_stream_state.batch_claim_token IS NULL OR memo_stream_state.batch_claim_expires_at <= NOW()
      RETURNING stream_id
    `)
    return result.rows.length > 0
  },

  /** False once another batch has taken the stream over. */
  async renewBatchClaim(
    db: Querier,
    workspaceId: string,
    streamId: string,
    token: string,
    leaseSeconds: number
  ): Promise<boolean> {
    const result = await db.query(sql`
      UPDATE memo_stream_state
      SET batch_claim_expires_at = NOW() + INTERVAL '1 second' * ${leaseSeconds}
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId} AND batch_claim_token = ${token}
      RETURNING stream_id
    `)
    return result.rows.length > 0
  },

  /** Row-locked, so a takeover can't commit while the holder is saving. */
  async holdsBatchClaim(db: Querier, workspaceId: string, streamId: string, token: string): Promise<boolean> {
    const result = await db.query(sql`
      SELECT 1 FROM memo_stream_state
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId} AND batch_claim_token = ${token}
      FOR UPDATE
    `)
    return result.rows.length > 0
  },

  async releaseBatchClaim(db: Querier, workspaceId: string, streamId: string, token: string): Promise<void> {
    await db.query(sql`
      UPDATE memo_stream_state
      SET batch_claim_token = NULL, batch_claim_expires_at = NULL
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId} AND batch_claim_token = ${token}
    `)
  },

  async markProcessed(db: Querier, workspaceId: string, streamId: string): Promise<void> {
    await db.query(sql`
      INSERT INTO memo_stream_state (workspace_id, stream_id, last_processed_at, last_activity_at)
      VALUES (${workspaceId}, ${streamId}, NOW(), NOW())
      ON CONFLICT (workspace_id, stream_id) DO UPDATE
      SET last_processed_at = NOW()
    `)
  },

  /**
   * Find streams ready to process based on debounce logic:
   * - Cap: process at most every 5 minutes per stream (BATCH_CAP_INTERVAL_SECONDS)
   * - Quick: process after 30s quiet per stream (BATCH_QUIET_INTERVAL_SECONDS)
   *
   * A stream is ready if:
   * 1. It has pending items, AND
   * 2. Either: never processed before, OR
   *    - Last processed >= 5 min ago (cap), OR
   *    - Last activity >= 30s ago (quiet period elapsed)
   */
  async findStreamsReadyToProcess(
    db: Querier,
    options?: { capIntervalSeconds?: number; quietIntervalSeconds?: number }
  ): Promise<StreamReadyToProcess[]> {
    const capInterval = options?.capIntervalSeconds ?? 300
    const quietInterval = options?.quietIntervalSeconds ?? 30

    const result = await db.query<{ workspace_id: string; stream_id: string }>(sql`
      SELECT DISTINCT p.workspace_id, p.stream_id
      FROM memo_pending_items p
      LEFT JOIN memo_stream_state s
        ON p.workspace_id = s.workspace_id AND p.stream_id = s.stream_id
      WHERE p.processed_at IS NULL
        AND (
          s.last_processed_at IS NULL
          OR s.last_processed_at < NOW() - INTERVAL '1 second' * ${capInterval}
          OR s.last_activity_at < NOW() - INTERVAL '1 second' * ${quietInterval}
        )
    `)

    return result.rows.map((row) => ({
      workspaceId: row.workspace_id,
      streamId: row.stream_id,
    }))
  },
}
