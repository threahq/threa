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
   * root stream — threads never carry their own access; `checkStreamAccess`
   * resolves a thread's visibility entirely through `root_stream_id`, so a
   * channel member must receive thread events (previews, replies by others)
   * for threads they haven't participated in. The log filter mirrors that
   * exact rule to keep catch-up delivery congruent with live delivery.
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

  /** Max visible sync id for a workspace (0 when the log is empty). */
  async getHead(db: Querier, workspaceId: string): Promise<bigint> {
    const result = await db.query<{ head: string }>(sql`
      SELECT COALESCE(MAX(sync_id), 0) AS head FROM sync_log WHERE workspace_id = ${workspaceId}
    `)
    return BigInt(result.rows[0].head)
  },
}
