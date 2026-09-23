import type { Querier } from "../../db"
import { sql } from "../../db"

interface StreamReadStateRow {
  workspace_id: string
  stream_id: string
  user_id: string
  last_read_event_id: string | null
  last_read_at: Date | null
  updated_at: Date
  inbox_held: boolean
  inbox_floor_event_id: string | null
}

export interface StreamReadState {
  workspaceId: string
  streamId: string
  userId: string
  lastReadEventId: string | null
  lastReadAt: Date | null
  updatedAt: Date
  inboxHeld: boolean
  /** The read frontier just before the current hold began; null when unheld or held from the start. */
  inboxFloorEventId: string | null
}

function mapRowToReadState(row: StreamReadStateRow): StreamReadState {
  return {
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    userId: row.user_id,
    lastReadEventId: row.last_read_event_id,
    lastReadAt: row.last_read_at,
    updatedAt: row.updated_at,
    inboxHeld: row.inbox_held,
    inboxFloorEventId: row.inbox_floor_event_id,
  }
}

const SELECT_FIELDS =
  "workspace_id, stream_id, user_id, last_read_event_id, last_read_at, updated_at, inbox_held, inbox_floor_event_id"

/**
 * The per-user read watermark — the sole read truth (membership ≠ access ≠ read
 * state). Keyed by (stream, user); a row exists only after the user's first
 * read-state write for that stream — absence means "never read" (frontier before
 * the first message).
 *
 * Writes are upserts and always safe (INV-20): reading never touches a membership
 * surface, so upserting here can't manufacture a member. `workspace_id` is derived
 * from `streams` on insert (INV-8).
 */
export const ReadStateRepository = {
  /**
   * Monotonic advance: insert when no row exists; on conflict, move the
   * watermark only when the new event's sequence is strictly greater than the
   * current watermark's sequence (both resolved via `stream_events`). A NULL or
   * unresolvable current watermark counts as sequence 0 (before the first
   * message), so any real event advances past it. Race-safe under concurrent
   * readers (INV-20). Returns the post-write row so same-tx callers can source
   * `stream:read` payloads from the effective frontier (which sits above the
   * requested event after a rejected stale advance).
   *
   * `opts.holdInInbox`: when true and the write is accepted (insert, or the
   * monotonic guard passes), sets `inbox_held = true` if the advance crosses at
   * least one `message_created` event authored by someone other than this user
   * — i.e. the read caught up on someone else's message, so the stream stays
   * pinned in the Inbox until explicitly cleared. Otherwise `inbox_held` is
   * left as-is (never cleared here — only `clearInboxHeld` clears it).
   *
   * `held` (the return flag) is `accepted && hold` — this call's own hold
   * rule. Re-emitting `held: true` on an already-held row is harmless.
   *
   * A hold-enabled advance first locks the row ({@link ensureForUpdate}), so
   * the hold rule reads the watermark as committed by any concurrent clear or
   * read instead of a stale statement snapshot. The lock lasts only as long as
   * the caller's transaction: pass a transaction client, never the pool.
   *
   * `inbox_floor_event_id` tracks the read frontier just before the current
   * hold began (for bootstrap arrival lookups): already held → keep it;
   * newly held by this call → the pre-update `last_read_event_id`; otherwise
   * → NULL. Read from `stream_read_state.*` (the locked pre-update row), not
   * `EXCLUDED`.
   */
  async advance(
    db: Querier,
    streamId: string,
    userId: string,
    eventId: string,
    opts: { holdInInbox: boolean }
  ): Promise<{ state: StreamReadState | null; held: boolean }> {
    if (opts.holdInInbox) await ReadStateRepository.ensureForUpdate(db, streamId, userId)
    const result = await db.query<StreamReadStateRow & { hold: boolean }>(
      `
      WITH prior AS (
        SELECT last_read_event_id
        FROM stream_read_state
        WHERE stream_id = $1 AND user_id = $2
      ),
      should_hold AS (
        SELECT $4::boolean AND EXISTS (
          SELECT 1 FROM stream_events e
          LEFT JOIN messages m ON m.id = e.payload->>'messageId'
          WHERE e.stream_id = $1
            AND e.event_type = 'message_created'
            AND e.actor_id IS DISTINCT FROM $2
            AND m.deleted_at IS NULL
            AND e.sequence > COALESCE(
              (SELECT cur_ev.sequence FROM stream_events cur_ev
                 WHERE cur_ev.id = (SELECT last_read_event_id FROM prior)),
              0
            )
            AND e.sequence <= (SELECT new_ev.sequence FROM stream_events new_ev WHERE new_ev.id = $3)
        ) AS hold
      ),
      upserted AS (
        INSERT INTO stream_read_state (workspace_id, stream_id, user_id, last_read_event_id, last_read_at, updated_at, inbox_held)
        SELECT s.workspace_id, $1, $2, $3, NOW(), NOW(), COALESCE((SELECT hold FROM should_hold), false)
        FROM streams s
        WHERE s.id = $1
        ON CONFLICT (stream_id, user_id) DO UPDATE
        SET last_read_event_id = EXCLUDED.last_read_event_id,
            last_read_at = EXCLUDED.last_read_at,
            updated_at = EXCLUDED.updated_at,
            inbox_held = CASE WHEN (SELECT hold FROM should_hold) THEN true ELSE stream_read_state.inbox_held END,
            inbox_floor_event_id = CASE
              WHEN stream_read_state.inbox_held THEN stream_read_state.inbox_floor_event_id
              WHEN (SELECT hold FROM should_hold) THEN stream_read_state.last_read_event_id
              ELSE NULL
            END
        WHERE COALESCE(
            (SELECT new_ev.sequence FROM stream_events new_ev WHERE new_ev.id = EXCLUDED.last_read_event_id),
            0
          ) > COALESCE(
            (SELECT cur_ev.sequence FROM stream_events cur_ev WHERE cur_ev.id = stream_read_state.last_read_event_id),
            0
          )
        RETURNING ${SELECT_FIELDS}
      )
      SELECT upserted.*, COALESCE((SELECT hold FROM should_hold), false) AS hold
      FROM upserted
      `,
      [streamId, userId, eventId, opts.holdInInbox]
    )
    // The monotonic guard rejected a stale advance — RETURNING is empty, so
    // read back the row as it stands (same tx). This call didn't write, so it
    // can't have held anything.
    if (!result.rows[0]) {
      return { state: await ReadStateRepository.get(db, streamId, userId), held: false }
    }
    const row = result.rows[0]
    return { state: mapRowToReadState(row), held: row.hold }
  },

  /**
   * Unconditional set (the regress path — mark-unread). `eventId` may be null to
   * park the watermark before the first message. No sequence comparison: this
   * deliberately moves the pointer backward.
   */
  async set(db: Querier, streamId: string, userId: string, eventId: string | null): Promise<StreamReadState | null> {
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
      RETURNING ${SELECT_FIELDS}
      `,
      [streamId, userId, eventId]
    )
    return result.rows[0] ? mapRowToReadState(result.rows[0]) : null
  },

  /**
   * Batch monotonic advance for one user across many streams (mark-all,
   * clear-inbox catch-up). Same per-row sequence rule as {@link advance};
   * streams whose new event doesn't out-sequence the current watermark are
   * left untouched. `states` is the authoritative post-write row for EVERY
   * attempted stream — including rows where the monotonic guard rejected the
   * attempted lower/equal frontier (a concurrent read already advanced past
   * it), which a bare RETURNING would omit. The re-read rides the caller's
   * transaction, so the snapshot is taken at the same point as the upsert: one
   * frontier per attempted valid stream, no gaps, no duplicates, empty map
   * safe.
   *
   * Never touches `inbox_held` or `inbox_floor_event_id` (no caller of this
   * batch path ever holds — mark-all and clear both catch a stream up
   * without pinning it in the Inbox); a fresh row keeps their defaults.
   */
  async batchAdvance(
    db: Querier,
    userId: string,
    updates: Map<string, string>
  ): Promise<{ states: StreamReadState[] }> {
    if (updates.size === 0) return { states: [] }

    const streamIds = Array.from(updates.keys())
    const eventIds = Array.from(updates.values())

    await db.query(
      `
      WITH input AS (
        SELECT unnest($1::text[]) AS stream_id, unnest($2::text[]) AS event_id
      )
      INSERT INTO stream_read_state (workspace_id, stream_id, user_id, last_read_event_id, last_read_at, updated_at)
      SELECT s.workspace_id, i.stream_id, $3, i.event_id, NOW(), NOW()
      FROM input i
      JOIN streams s ON s.id = i.stream_id
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
    // Authoritative same-tx re-read of every attempted (stream, user) row: the
    // upsert has no RETURNING (rejected rows never appear in one), so this is
    // the only source for the full attempted set — one frontier per stream,
    // no gaps.
    const states = await ReadStateRepository.getBatch(db, userId, streamIds)
    return { states }
  },

  /**
   * Batch {@link ensureForUpdate} for one user: seeds missing rows with a NULL
   * watermark and locks every row in stream-id order, so concurrent batch
   * lockers can't deadlock each other and a concurrent hold-enabled
   * {@link advance} waits until the caller commits.
   */
  async ensureBatchForUpdate(db: Querier, userId: string, streamIds: string[]): Promise<void> {
    if (streamIds.length === 0) return
    await db.query(sql`
      INSERT INTO stream_read_state (workspace_id, stream_id, user_id, last_read_event_id, last_read_at, updated_at)
      SELECT s.workspace_id, s.id, ${userId}, NULL, NULL, NOW()
      FROM streams s
      WHERE s.id = ANY(${streamIds})
      ORDER BY s.id
      ON CONFLICT (stream_id, user_id) DO NOTHING
    `)
    await db.query(sql`
      SELECT stream_id
      FROM stream_read_state
      WHERE user_id = ${userId} AND stream_id = ANY(${streamIds})
      ORDER BY stream_id
      FOR UPDATE
    `)
  },

  /**
   * Explicit "Clear" in the Inbox: unpins the held streams the user
   * acknowledged. Returns only the stream ids that were actually held (a
   * stream already unheld is a no-op, not reported as cleared).
   */
  async clearInboxHeld(db: Querier, workspaceId: string, userId: string, streamIds: string[]): Promise<string[]> {
    if (streamIds.length === 0) return []
    const result = await db.query<{ stream_id: string }>(sql`
      UPDATE stream_read_state
      SET inbox_held = false, inbox_floor_event_id = NULL, updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND stream_id = ANY(${streamIds}) AND inbox_held
      RETURNING stream_id
    `)
    return result.rows.map((r) => r.stream_id)
  },

  /** Every stream currently held in this user's Inbox (bootstrap seed). */
  async listInboxHeldStreamIds(db: Querier, workspaceId: string, userId: string): Promise<string[]> {
    const result = await db.query<{ stream_id: string }>(sql`
      SELECT stream_id
      FROM stream_read_state
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND inbox_held
    `)
    return result.rows.map((r) => r.stream_id)
  },

  /**
   * Inbox arrival per candidate stream: `created_at` of the first non-deleted
   * other-author message above the floor. Held streams measure from the frozen
   * `inbox_floor_event_id` so reading without clearing doesn't move arrival;
   * unheld streams from `last_read_event_id`. Absent from the result = not in
   * the Inbox.
   */
  async listInboxArrivals(
    db: Querier,
    workspaceId: string,
    userId: string,
    streamIds: string[]
  ): Promise<Record<string, Date>> {
    if (streamIds.length === 0) return {}
    const result = await db.query<{ stream_id: string; arrived_at: Date }>(sql`
      WITH candidates AS (
        SELECT unnest(${streamIds}::text[]) AS stream_id
      ),
      state AS (
        SELECT c.stream_id, rs.inbox_held, rs.inbox_floor_event_id, rs.last_read_event_id
        FROM candidates c
        LEFT JOIN stream_read_state rs
          ON rs.stream_id = c.stream_id AND rs.user_id = ${userId} AND rs.workspace_id = ${workspaceId}
      ),
      floor_seq AS (
        SELECT s.stream_id,
          COALESCE(
            (SELECT e.sequence FROM stream_events e
               WHERE e.id = CASE WHEN s.inbox_held THEN s.inbox_floor_event_id ELSE s.last_read_event_id END),
            0
          ) AS floor_sequence
        FROM state s
      )
      SELECT fs.stream_id, arrival.created_at AS arrived_at
      FROM floor_seq fs
      JOIN LATERAL (
        SELECT e.created_at
        FROM stream_events e
        LEFT JOIN messages m ON m.id = e.payload->>'messageId'
        WHERE e.stream_id = fs.stream_id
          AND e.event_type = 'message_created'
          AND e.actor_id IS DISTINCT FROM ${userId}
          AND e.sequence > fs.floor_sequence
          AND m.deleted_at IS NULL
        ORDER BY e.sequence ASC
        LIMIT 1
      ) arrival ON true
    `)
    const arrivals: Record<string, Date> = {}
    for (const row of result.rows) arrivals[row.stream_id] = row.arrived_at
    return arrivals
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
   * the serialization point for concurrent conversation reads on the same
   * (stream, user) (INV-20), for members and non-members alike. Conversations
   * processes streams in sorted order, so the single-row lock introduces no new
   * lock-order hazard. A seeded row carries a NULL watermark (never read =
   * position before the first message). Two statements: ON CONFLICT DO NOTHING
   * returns nothing for an existing row, and FOR UPDATE can't ride the insert.
   * Returns null only for a dangling stream id.
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
