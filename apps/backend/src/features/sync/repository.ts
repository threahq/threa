import type { Pool } from "pg"
import { sql, withTransaction } from "../../db"

/** One client-routed outbox event headed for the sync log. */
export interface SyncLogEntryInput {
  outboxEventId: bigint
  eventType: string
  groups: string[]
  payload: unknown
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
}
