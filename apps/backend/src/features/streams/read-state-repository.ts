import type { Querier } from "../../db"
import { sql } from "../../db"

interface StreamReadStateRow {
  workspace_id: string
  stream_id: string
  user_id: string
  last_read_event_id: string | null
  last_read_at: Date | null
  updated_at: Date
}

export interface StreamReadState {
  workspaceId: string
  streamId: string
  userId: string
  lastReadEventId: string | null
  lastReadAt: Date | null
  updatedAt: Date
}

function mapRowToReadState(row: StreamReadStateRow): StreamReadState {
  return {
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    userId: row.user_id,
    lastReadEventId: row.last_read_event_id,
    lastReadAt: row.last_read_at,
    updatedAt: row.updated_at,
  }
}

const SELECT_FIELDS = "workspace_id, stream_id, user_id, last_read_event_id, last_read_at, updated_at"

/**
 * The per-user read watermark, re-homed off `stream_members` (membership ≠
 * access ≠ read state). Keyed by (stream, user); a row exists only after the
 * user's first read-state write for that stream — absence means "never read",
 * the same semantics as a NULL `stream_members.last_read_event_id` today.
 *
 * Writes are upserts and always safe (INV-20): unlike `stream_members`, reading
 * never touches a membership surface, so upserting here can't manufacture a
 * member. `workspace_id` is derived from `streams` on insert (INV-8) — the
 * callers write inside the same transaction as the membership write they shadow.
 */
export const ReadStateRepository = {
  /**
   * Monotonic advance: insert when no row exists; on conflict, move the
   * watermark only when the new event's sequence is strictly greater than the
   * current watermark's sequence (both resolved via `stream_events`). A NULL or
   * unresolvable current watermark counts as sequence 0 (before the first
   * message), so any real event advances past it. Race-safe under concurrent
   * readers (INV-20). Returns the post-write row so same-tx callers can source
   * `stream:read` payloads from the standalone frontier (which may sit above
   * the membership watermark after a rejected stale advance).
   */
  async advance(db: Querier, streamId: string, userId: string, eventId: string): Promise<StreamReadState | null> {
    const result = await db.query<StreamReadStateRow>(
      `
      INSERT INTO stream_read_state (workspace_id, stream_id, user_id, last_read_event_id, last_read_at, updated_at)
      SELECT s.workspace_id, $1, $2, $3, NOW(), NOW()
      FROM streams s
      WHERE s.id = $1
      ON CONFLICT (stream_id, user_id) DO UPDATE
      SET last_read_event_id = EXCLUDED.last_read_event_id,
          last_read_at = EXCLUDED.last_read_at,
          updated_at = EXCLUDED.updated_at
      WHERE COALESCE(
          (SELECT new_ev.sequence FROM stream_events new_ev WHERE new_ev.id = EXCLUDED.last_read_event_id),
          0
        ) > COALESCE(
          (SELECT cur_ev.sequence FROM stream_events cur_ev WHERE cur_ev.id = stream_read_state.last_read_event_id),
          0
        )
      RETURNING ${SELECT_FIELDS}
      `,
      [streamId, userId, eventId]
    )
    // The monotonic guard rejected a stale advance — RETURNING is empty, so
    // read back the row as it stands (same tx).
    return result.rows[0] ? mapRowToReadState(result.rows[0]) : ReadStateRepository.get(db, streamId, userId)
  },

  /**
   * Unconditional set (the regress path — mark-unread). `eventId` may be null to
   * park the watermark before the first message. No sequence comparison: this
   * deliberately moves the pointer backward.
   */
  async set(db: Querier, streamId: string, userId: string, eventId: string | null): Promise<void> {
    await db.query(
      `
      INSERT INTO stream_read_state (workspace_id, stream_id, user_id, last_read_event_id, last_read_at, updated_at)
      SELECT s.workspace_id, $1, $2, $3, NOW(), NOW()
      FROM streams s
      WHERE s.id = $1
      ON CONFLICT (stream_id, user_id) DO UPDATE
      SET last_read_event_id = EXCLUDED.last_read_event_id,
          last_read_at = EXCLUDED.last_read_at,
          updated_at = EXCLUDED.updated_at
      `,
      [streamId, userId, eventId]
    )
  },

  /**
   * Batch monotonic advance for one user across many streams (mark-all). Same
   * per-row sequence rule as {@link advance}; streams whose new event doesn't
   * out-sequence the current watermark are left untouched.
   */
  async batchAdvance(db: Querier, userId: string, updates: Map<string, string>): Promise<void> {
    if (updates.size === 0) return

    const streamIds = Array.from(updates.keys())
    const eventIds = Array.from(updates.values())

    await db.query(
      `
      INSERT INTO stream_read_state (workspace_id, stream_id, user_id, last_read_event_id, last_read_at, updated_at)
      SELECT s.workspace_id, u.stream_id, $3, u.event_id, NOW(), NOW()
      FROM (SELECT unnest($1::text[]) AS stream_id, unnest($2::text[]) AS event_id) u
      JOIN streams s ON s.id = u.stream_id
      ON CONFLICT (stream_id, user_id) DO UPDATE
      SET last_read_event_id = EXCLUDED.last_read_event_id,
          last_read_at = EXCLUDED.last_read_at,
          updated_at = EXCLUDED.updated_at
      WHERE COALESCE(
          (SELECT new_ev.sequence FROM stream_events new_ev WHERE new_ev.id = EXCLUDED.last_read_event_id),
          0
        ) > COALESCE(
          (SELECT cur_ev.sequence FROM stream_events cur_ev WHERE cur_ev.id = stream_read_state.last_read_event_id),
          0
        )
      `,
      [streamIds, eventIds, userId]
    )
  },

  /** Batch unconditional set for many users on one stream (channel-creation born-read). */
  async setForUsers(db: Querier, streamId: string, userIds: string[], eventId: string): Promise<void> {
    if (userIds.length === 0) return

    await db.query(
      `
      INSERT INTO stream_read_state (workspace_id, stream_id, user_id, last_read_event_id, last_read_at, updated_at)
      SELECT s.workspace_id, $1, u.user_id, $2, NOW(), NOW()
      FROM streams s, unnest($3::text[]) AS u(user_id)
      WHERE s.id = $1
      ON CONFLICT (stream_id, user_id) DO UPDATE
      SET last_read_event_id = EXCLUDED.last_read_event_id,
          last_read_at = EXCLUDED.last_read_at,
          updated_at = EXCLUDED.updated_at
      `,
      [streamId, eventId, userIds]
    )
  },

  /**
   * A3 fix mirror (sparse-read design): after a move relocates events out of a
   * source stream, any read-state row whose `last_read_event_id` is one of those
   * moved events now counts unread against a foreign thread-space sequence.
   * Repoint each to the nearest surviving prior event in the source stream
   * (greatest sequence strictly below the moved event's original source
   * sequence), or null when nothing prior survives. Set-based (INV-56); MUST run
   * AFTER the move so the moved rows are already gone from the source and can't
   * be chosen as their own predecessor. `last_read_at` is deliberately left
   * untouched: this is an automated correction, not a read, and the timestamp
   * feeds the conversation card's time fallback — bumping it would falsely mark
   * every older sequenceless/non-member-thread row as read.
   */
  async repointForMovedEvents(
    db: Querier,
    sourceStreamId: string,
    movedEvents: Array<{ eventId: string; sequence: bigint }>
  ): Promise<void> {
    if (movedEvents.length === 0) return
    const eventIds = movedEvents.map((e) => e.eventId)
    const sequences = movedEvents.map((e) => e.sequence.toString())
    await db.query(
      `
      WITH moved AS (
        SELECT unnest($2::text[]) AS event_id, unnest($3::bigint[]) AS src_seq
      ),
      repoint AS (
        SELECT rs.user_id,
          (SELECT e.id FROM stream_events e
             WHERE e.stream_id = $1 AND e.sequence < moved.src_seq
             ORDER BY e.sequence DESC LIMIT 1) AS new_event_id
        FROM stream_read_state rs
        JOIN moved ON moved.event_id = rs.last_read_event_id
        WHERE rs.stream_id = $1
      )
      UPDATE stream_read_state rs
      SET last_read_event_id = repoint.new_event_id, updated_at = NOW()
      FROM repoint
      WHERE rs.stream_id = $1 AND rs.user_id = repoint.user_id
      `,
      [sourceStreamId, eventIds, sequences]
    )
  },

  /**
   * Ensure a row exists for this (stream, user) and return it locked FOR UPDATE —
   * the non-member leg's serialization point (INV-20). Members are serialized by
   * their locked `stream_members` row; a non-member leg has no membership row, so
   * its read-state row carries the lock instead: concurrent conversation reads on
   * the same leg take the same single-row lock (conversations processes streams
   * in sorted order, so no new lock-order hazard). A seeded row carries a NULL
   * watermark (never read = position before the first message). Two statements:
   * ON CONFLICT DO NOTHING returns nothing for an existing row, and FOR UPDATE
   * can't ride the insert. Returns null only for a dangling stream id.
   */
  async ensureForUpdate(db: Querier, streamId: string, userId: string): Promise<StreamReadState | null> {
    await db.query(
      `
      INSERT INTO stream_read_state (workspace_id, stream_id, user_id, last_read_event_id, last_read_at, updated_at)
      SELECT s.workspace_id, $1, $2, NULL, NULL, NOW()
      FROM streams s
      WHERE s.id = $1
      ON CONFLICT (stream_id, user_id) DO NOTHING
      `,
      [streamId, userId]
    )
    const result = await db.query<StreamReadStateRow>(
      `
      SELECT ${SELECT_FIELDS}
      FROM stream_read_state
      WHERE stream_id = $1 AND user_id = $2
      FOR UPDATE
      `,
      [streamId, userId]
    )
    return result.rows[0] ? mapRowToReadState(result.rows[0]) : null
  },

  async get(db: Querier, streamId: string, userId: string): Promise<StreamReadState | null> {
    const result = await db.query<StreamReadStateRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM stream_read_state
      WHERE stream_id = ${streamId} AND user_id = ${userId}
    `)
    return result.rows[0] ? mapRowToReadState(result.rows[0]) : null
  },

  async getBatch(db: Querier, userId: string, streamIds: string[]): Promise<StreamReadState[]> {
    if (streamIds.length === 0) return []
    const result = await db.query<StreamReadStateRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM stream_read_state
      WHERE user_id = ${userId} AND stream_id = ANY(${streamIds})
    `)
    return result.rows.map(mapRowToReadState)
  },

  /** Every read position for one user in one workspace (bootstrap assembly). */
  async listForUser(db: Querier, workspaceId: string, userId: string): Promise<StreamReadState[]> {
    const result = await db.query<StreamReadStateRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM stream_read_state
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
    return result.rows.map(mapRowToReadState)
  },

  async deleteForWorkspace(db: Querier, workspaceId: string): Promise<void> {
    await db.query(sql`
      DELETE FROM stream_read_state WHERE workspace_id = ${workspaceId}
    `)
  },

  async deleteForUser(db: Querier, workspaceId: string, userId: string): Promise<void> {
    await db.query(sql`
      DELETE FROM stream_read_state WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
  },
}
