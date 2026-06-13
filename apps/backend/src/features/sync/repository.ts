import type { Pool } from "pg"
import { sql, withTransaction, type Querier } from "../../db"

/** One client-routed outbox event headed for the sync log. */
export interface SyncLogEntryInput {
  outboxEventId: bigint
  eventType: string
  groups: string[]
  payload: unknown
}

/** A sync-log entry as returned by catch-up reads. */
export interface SyncLogEntry {
  syncId: bigint
  eventType: string
  payload: unknown
  createdAt: Date
}

interface SyncLogEntryRow {
  sync_id: string
  event_type: string
  payload: unknown
  created_at: Date
}

function mapRowToEntry(row: SyncLogEntryRow): SyncLogEntry {
  return {
    syncId: BigInt(row.sync_id),
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at,
  }
}

export const SyncLogRepository = {
  /**
   * Appends a batch of outbox events to one workspace's sync log, allocating
   * dense, gapless sync ids in input order. Idempotent: events that already
   * have a log entry (sequencer crash-retry, reconciliation-sweep overlap)
   * keep their existing sync id and are not re-inserted.
   *
   * Returns outboxEventId → syncId for every input entry.
   *
   * Concurrency protocol (INV-20): writers lock the workspace's allocator row
   * FIRST (no-op upsert), then read existing entries on a fresh snapshot, then
   * insert only the missing ones. Checking before locking would let two
   * writers both see an event as missing and burn an allocated id into a
   * permanent gap — so any unique-index violation here means a writer broke
   * the lock-first protocol, and the transaction fails loudly instead of
   * absorbing it.
   */
  async appendForWorkspace(
    pool: Pool,
    workspaceId: string,
    entries: SyncLogEntryInput[]
  ): Promise<Map<bigint, bigint>> {
    if (entries.length === 0) {
      return new Map()
    }

    return withTransaction(pool, async (client) => {
      const lockResult = await client.query<{ next_sequence: string }>(sql`
        INSERT INTO workspace_sync_sequences (workspace_id, next_sequence)
        VALUES (${workspaceId}, 1)
        ON CONFLICT (workspace_id) DO UPDATE
          SET next_sequence = workspace_sync_sequences.next_sequence
        RETURNING next_sequence
      `)
      const start = BigInt(lockResult.rows[0].next_sequence)

      const outboxEventIds = entries.map((e) => e.outboxEventId.toString())
      const existingResult = await client.query<{ outbox_event_id: string; sync_id: string }>(sql`
        SELECT outbox_event_id, sync_id
        FROM sync_log
        WHERE workspace_id = ${workspaceId}
          AND outbox_event_id = ANY(${outboxEventIds}::bigint[])
      `)

      const assigned = new Map<bigint, bigint>()
      for (const row of existingResult.rows) {
        assigned.set(BigInt(row.outbox_event_id), BigInt(row.sync_id))
      }

      const missing = entries.filter((e) => !assigned.has(e.outboxEventId))

      if (missing.length > 0) {
        const rows = missing.map((e, i) => {
          const syncId = start + BigInt(i)
          assigned.set(e.outboxEventId, syncId)
          return {
            sync_id: syncId.toString(),
            outbox_event_id: e.outboxEventId.toString(),
            event_type: e.eventType,
            groups: e.groups,
            payload: e.payload,
          }
        })

        await client.query(sql`
          INSERT INTO sync_log (workspace_id, sync_id, outbox_event_id, event_type, groups, payload)
          SELECT ${workspaceId}, r.sync_id::bigint, r.outbox_event_id::bigint, r.event_type,
                 ARRAY(SELECT g FROM jsonb_array_elements_text(r.groups) AS g),
                 r.payload
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
            AS r(sync_id text, outbox_event_id text, event_type text, groups jsonb, payload jsonb)
        `)

        await client.query(sql`
          UPDATE workspace_sync_sequences
          SET next_sequence = ${(start + BigInt(missing.length)).toString()}
          WHERE workspace_id = ${workspaceId}
        `)
      }

      return assigned
    })
  },

  /**
   * Lists log entries after a cursor, filtered to what the requesting user is
   * allowed to see: workspace-group entries, their own user-group entries, and
   * stream-group entries for streams they can read.
   *
   * A stream is readable when the user is a member of it OR a member of its
   * root stream (INV-62) — threads never carry their own access;
   * `checkStreamAccess` resolves a thread's visibility entirely through
   * `root_stream_id`, so a channel member must receive thread events
   * (previews, replies by others) for threads they haven't participated in.
   * The log filter mirrors that exact rule to keep catch-up delivery
   * congruent with live delivery.
   *
   * Each visibility grant is bounded below by its membership's join position —
   * the sync id of the user's latest `stream:member_added` entry for the
   * member stream (threads inherit the ROOT membership's bound) — so joining a
   * stream never replays its pre-join history through the log (over-delivery
   * would leak no-history private streams). Memberships with no member_added
   * entry predate the log itself, so every log entry postdates the join and no
   * bound is needed. The member_added entry itself reaches the joiner through
   * their user group. When several grants cover one stream (direct thread
   * member AND root member), any grant whose bound passes admits the entry.
   */
  async listEntriesForUser(
    db: Querier,
    params: { workspaceId: string; userId: string; after: bigint; limit: number }
  ): Promise<SyncLogEntry[]> {
    const { workspaceId, userId, after, limit } = params
    const result = await db.query<SyncLogEntryRow>(sql`
      WITH join_bounds AS (
        SELECT DISTINCT ON (payload->>'streamId') payload->>'streamId' AS stream_id, sync_id AS join_sync_id
        FROM sync_log
        WHERE workspace_id = ${workspaceId}
          AND event_type = 'stream:member_added'
          AND groups @> ARRAY['user:' || ${userId}]
        ORDER BY payload->>'streamId', sync_id DESC
      ),
      memberships AS (
        SELECT sm.stream_id, COALESCE(jb.join_sync_id, 0) AS bound
        FROM stream_members sm
        LEFT JOIN join_bounds jb ON jb.stream_id = sm.stream_id
        WHERE sm.member_id = ${userId}
      ),
      visible_streams AS (
        SELECT stream_id, bound FROM memberships
        UNION ALL
        SELECT s.id, m.bound
        FROM streams s
        JOIN memberships m ON m.stream_id = s.root_stream_id
        WHERE s.workspace_id = ${workspaceId}
      )
      SELECT l.sync_id, l.event_type, l.payload, l.created_at
      FROM sync_log l
      WHERE l.workspace_id = ${workspaceId}
        AND l.sync_id > ${after.toString()}
        AND (
          l.groups && ARRAY['workspace', 'user:' || ${userId}]
          OR EXISTS (
            SELECT 1
            FROM visible_streams vs
            WHERE l.groups @> ARRAY['stream:' || vs.stream_id]
              AND l.sync_id > vs.bound
          )
        )
      ORDER BY l.sync_id
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToEntry)
  },

  /**
   * Heads for a batch of workspaces in one statement (INV-56), for the
   * heartbeat tick. Workspaces with no log entries are absent from the map;
   * callers default them to 0.
   */
  async getHeads(db: Querier, workspaceIds: string[]): Promise<Map<string, bigint>> {
    if (workspaceIds.length === 0) {
      return new Map()
    }
    const result = await db.query<{ workspace_id: string; head: string }>(sql`
      SELECT workspace_id, MAX(sync_id) AS head
      FROM sync_log
      WHERE workspace_id = ANY(${workspaceIds})
      GROUP BY workspace_id
    `)
    return new Map(result.rows.map((row) => [row.workspace_id, BigInt(row.head)]))
  },

  /** Max visible sync id for a workspace (0 when the log is empty). */
  async getHead(db: Querier, workspaceId: string): Promise<bigint> {
    const result = await db.query<{ head: string }>(sql`
      SELECT COALESCE(MAX(sync_id), 0) AS head FROM sync_log WHERE workspace_id = ${workspaceId}
    `)
    return BigInt(result.rows[0].head)
  },

  /**
   * The retention floor: the highest sync id pruned for a workspace (0 when
   * nothing has been pruned). A catch-up cursor at or below this floor cannot
   * be healed from the log — the entries it would replay are gone — so the
   * caller signals a full bootstrap. See docs/plans/sync-v2-log-retention.md.
   */
  async getRetainedFrom(db: Querier, workspaceId: string): Promise<bigint> {
    const result = await db.query<{ retained_from: string }>(sql`
      SELECT retained_from FROM sync_log_retention_state WHERE workspace_id = ${workspaceId}
    `)
    return BigInt(result.rows[0]?.retained_from ?? 0)
  },

  /**
   * Prunes one bounded batch of expired sync_log entries across every
   * workspace: rows older than `cutoff` whose sync_id is at or below
   * `head - minKeep` for their workspace. The count floor keeps the most
   * recent `minKeep` entries even past the horizon, so a quiet workspace's
   * returning client still catches up from the log instead of bootstrapping.
   *
   * Heads come from `workspace_sync_sequences` (next_sequence - 1), not a
   * MAX over the log: the allocator keeps sync ids dense and gapless
   * (appendForWorkspace's lock-first protocol), so head = next_sequence - 1
   * exactly, and this avoids a full-table aggregate every batch.
   *
   * Bounded by `limit` (INV-56 set-based, but a first run over months of
   * backlog must not hold one long transaction). The prunable set is a
   * contiguous sync_id prefix per workspace, so re-running converges and
   * advancing `retained_from` to any pruned id is always safe — a stale-high
   * floor can only force an unnecessary bootstrap, never hide a gap.
   *
   * Returns the highest pruned sync_id per workspace and the total rows
   * deleted this batch — the caller drives exhaustion off `deletedCount`
   * (`< limit` ⇒ window drained), since the per-workspace map size counts
   * workspaces, not rows.
   */
  async pruneExpiredEntries(
    db: Querier,
    params: { cutoff: Date; minKeep: number; limit: number }
  ): Promise<{ prunedThrough: Map<string, bigint>; deletedCount: number }> {
    const result = await db.query<{ workspace_id: string; pruned_through: string; pruned_count: string }>(sql`
      WITH heads AS (
        SELECT workspace_id, next_sequence - 1 AS head
        FROM workspace_sync_sequences
      ),
      victims AS (
        SELECT l.ctid
        FROM sync_log l
        JOIN heads h ON h.workspace_id = l.workspace_id
        WHERE l.created_at < ${params.cutoff}
          AND l.sync_id <= h.head - ${params.minKeep}
        LIMIT ${params.limit}
      ),
      deleted AS (
        DELETE FROM sync_log l
        USING victims v
        WHERE l.ctid = v.ctid
        RETURNING l.workspace_id, l.sync_id
      )
      SELECT workspace_id, MAX(sync_id) AS pruned_through, COUNT(*) AS pruned_count
      FROM deleted
      GROUP BY workspace_id
    `)
    const prunedThrough = new Map<string, bigint>()
    let deletedCount = 0
    for (const row of result.rows) {
      prunedThrough.set(row.workspace_id, BigInt(row.pruned_through))
      deletedCount += Number(row.pruned_count)
    }
    return { prunedThrough, deletedCount }
  },

  /**
   * Monotonically advances each workspace's retention floor to the highest
   * sync id pruned for it. GREATEST makes concurrent or repeated runs (and
   * multiple backend instances) idempotent.
   */
  async advanceRetainedFrom(db: Querier, prunedThrough: Map<string, bigint>): Promise<void> {
    if (prunedThrough.size === 0) {
      return
    }
    const rows = Array.from(prunedThrough, ([workspaceId, retainedFrom]) => ({
      workspace_id: workspaceId,
      retained_from: retainedFrom.toString(),
    }))
    await db.query(sql`
      INSERT INTO sync_log_retention_state (workspace_id, retained_from)
      SELECT r.workspace_id, r.retained_from::bigint
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        AS r(workspace_id text, retained_from text)
      ON CONFLICT (workspace_id) DO UPDATE
        SET retained_from = GREATEST(sync_log_retention_state.retained_from, EXCLUDED.retained_from),
            updated_at = NOW()
    `)
  },

  /**
   * Initializes the sweep floor at "now" — the log starts at deploy, so
   * pre-log outbox history is never treated as missing.
   */
  async ensureSweepState(db: Querier): Promise<void> {
    await db.query(sql`
      INSERT INTO sync_log_sweep_state (singleton, swept_until)
      VALUES ('sweep', NOW())
      ON CONFLICT (singleton) DO NOTHING
    `)
  },

  async getSweptUntil(db: Querier): Promise<Date | null> {
    const result = await db.query<{ swept_until: Date }>(sql`
      SELECT swept_until FROM sync_log_sweep_state WHERE singleton = 'sweep'
    `)
    return result.rows[0]?.swept_until ?? null
  },

  /** Monotone advance; concurrent sweepers are idempotent so GREATEST suffices. */
  async advanceSweptUntil(db: Querier, until: Date): Promise<void> {
    await db.query(sql`
      UPDATE sync_log_sweep_state
      SET swept_until = GREATEST(swept_until, ${until})
      WHERE singleton = 'sweep'
    `)
  },

  /**
   * The latest instant the outbox is provably frozen up to: `delayMs` behind
   * the DB clock, clamped by the oldest running transaction's start. Rows get
   * `created_at = NOW()` = transaction start, so once every transaction that
   * started before T has ended, the set of rows with created_at < T can never
   * grow — a sweep over it is exhaustive, not probabilistic.
   */
  async getFrozenCutoff(db: Querier, delayMs: number): Promise<Date> {
    const result = await db.query<{ cutoff: Date }>(sql`
      SELECT LEAST(
        NOW() - (${delayMs}::int * interval '1 millisecond'),
        COALESCE(
          (SELECT MIN(xact_start) FROM pg_stat_activity
           WHERE xact_start IS NOT NULL AND datname = current_database()),
          NOW()
        )
      ) AS cutoff
    `)
    return result.rows[0].cutoff
  },

  /**
   * Outbox rows in [since, until) with no sync_log entry, in id order.
   * Already-sequenced rows drop out via the anti-join, so re-running over the
   * same window converges.
   */
  async listUnsequencedOutboxEvents(
    db: Querier,
    params: { since: Date; until: Date; limit: number }
  ): Promise<Array<{ id: bigint; eventType: string; payload: unknown; createdAt: Date }>> {
    const result = await db.query<{ id: string; event_type: string; payload: unknown; created_at: Date }>(sql`
      SELECT o.id, o.event_type, o.payload, o.created_at
      FROM outbox o
      WHERE o.created_at >= ${params.since}
        AND o.created_at < ${params.until}
        AND NOT EXISTS (SELECT 1 FROM sync_log s WHERE s.outbox_event_id = o.id)
      ORDER BY o.id
      LIMIT ${params.limit}
    `)
    return result.rows.map((row) => ({
      id: BigInt(row.id),
      eventType: row.event_type,
      payload: row.payload,
      createdAt: row.created_at,
    }))
  },
}
