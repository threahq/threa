import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import path from "path"
import { setupTestDatabase } from "./setup"
import { SyncLogRepository, type SyncLogEntryInput } from "../../src/features/sync"

// Exercises the real migration artifact (the same SQL that ships) against
// seeded sync_log rows: the content-based sweep must delete exactly the legacy
// counter entries the client guard `isLegacyUnreadCounterEntry` skips, leave
// every non-legacy and non-counter row intact, and never advance the retention
// floor (the deleted set is sparse, so a floor advance would falsely mark
// surviving lower-id rows as pruned).
const MIGRATION_PATH = path.join(
  import.meta.dir,
  "../../src/db/migrations/20260613083239_prune_legacy_counter_entries.sql"
)

describe("prune_legacy_counter_entries migration", () => {
  let pool: Pool
  let migrationSql: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    migrationSql = await Bun.file(MIGRATION_PATH).text()
  })

  afterAll(async () => {
    await pool.end()
  })

  function uniqueId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`
  }

  async function reserveOutboxIds(count: number): Promise<bigint[]> {
    const result = await pool.query<{ id: string }>(
      `SELECT nextval('outbox_id_seq') AS id FROM generate_series(1, $1)`,
      [count]
    )
    return result.rows.map((r) => BigInt(r.id))
  }

  async function append(
    workspaceId: string,
    entries: Array<Omit<SyncLogEntryInput, "outboxEventId">>
  ): Promise<bigint[]> {
    const outboxIds = await reserveOutboxIds(entries.length)
    const withIds = entries.map((e, i) => ({ ...e, outboxEventId: outboxIds[i] }))
    const assigned = await SyncLogRepository.appendForWorkspace(pool, workspaceId, withIds)
    return outboxIds.map((id) => assigned.get(id)!)
  }

  async function survivingSyncIds(workspaceId: string): Promise<Set<string>> {
    const result = await pool.query<{ sync_id: string }>(
      `SELECT sync_id FROM sync_log WHERE workspace_id = $1 ORDER BY sync_id`,
      [workspaceId]
    )
    return new Set(result.rows.map((r) => r.sync_id))
  }

  test("deletes only field-less counter entries, keeps survivors and floor", async () => {
    const workspaceId = uniqueId("ws")
    const streamId = uniqueId("stream")
    const group = `stream:${streamId}`

    // Legacy: the four counter types missing their absolute fields (and a
    // wrong-typed variant), exactly what isLegacyUnreadCounterEntry returns true on.
    const legacyIds = await append(workspaceId, [
      { eventType: "stream:activity", groups: [group], payload: { streamId } },
      { eventType: "stream:activity", groups: [group], payload: { streamId, messageOrdinal: "5" } },
      { eventType: "stream:read", groups: [group], payload: { streamId } },
      { eventType: "stream:read_all", groups: [group], payload: {} },
      { eventType: "activity:created", groups: [group], payload: { streamId } },
      { eventType: "activity:created", groups: [group], payload: { streamId, counts: { mentionCount: 1 } } },
    ])

    // Survivors: non-legacy counter entries (absolute fields present) plus a
    // non-counter entry, all interleaved so the deleted set is sparse.
    const survivorIds = await append(workspaceId, [
      { eventType: "stream:activity", groups: [group], payload: { streamId, messageOrdinal: 5 } },
      { eventType: "stream:read", groups: [group], payload: { streamId, lastReadOrdinal: 3 } },
      {
        eventType: "stream:read_all",
        groups: [group],
        payload: { reads: [{ streamId, lastReadOrdinal: 2 }] },
      },
      {
        eventType: "activity:created",
        groups: [group],
        payload: { streamId, counts: { mentionCount: 1, activityCount: 2 } },
      },
      { eventType: "message:created", groups: [group], payload: { messageId: uniqueId("msg") } },
    ])

    // Seed a retention floor to prove the sweep leaves it untouched.
    await pool.query(`INSERT INTO sync_log_retention_state (workspace_id, retained_from) VALUES ($1, $2)`, [
      workspaceId,
      "7",
    ])

    await pool.query(migrationSql)

    const surviving = await survivingSyncIds(workspaceId)
    for (const id of legacyIds) {
      expect(surviving.has(id.toString())).toBe(false)
    }
    for (const id of survivorIds) {
      expect(surviving.has(id.toString())).toBe(true)
    }

    const floor = await pool.query<{ retained_from: string }>(
      `SELECT retained_from FROM sync_log_retention_state WHERE workspace_id = $1`,
      [workspaceId]
    )
    expect(floor.rows[0].retained_from).toBe("7")
  })

  test("is idempotent — a second run deletes nothing", async () => {
    const workspaceId = uniqueId("ws")
    const streamId = uniqueId("stream")
    const group = `stream:${streamId}`

    await append(workspaceId, [
      { eventType: "stream:activity", groups: [group], payload: { streamId } },
      { eventType: "stream:activity", groups: [group], payload: { streamId, messageOrdinal: 9 } },
    ])

    await pool.query(migrationSql)
    const afterFirst = await survivingSyncIds(workspaceId)
    await pool.query(migrationSql)
    const afterSecond = await survivingSyncIds(workspaceId)

    expect([...afterSecond].sort()).toEqual([...afterFirst].sort())
    expect(afterSecond.size).toBe(1)
  })
})
