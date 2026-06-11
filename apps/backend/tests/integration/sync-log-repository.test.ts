import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { SyncLogRepository, type SyncLogEntryInput } from "../../src/features/sync"

describe("SyncLogRepository", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  // Outbox event ids in the real system come from one global BIGSERIAL; tests
  // reserve unique ids the same way so parallel test files can't collide on
  // the sync_log unique index.
  async function reserveOutboxIds(count: number): Promise<bigint[]> {
    const result = await pool.query<{ id: string }>(
      `SELECT nextval('outbox_id_seq') AS id FROM generate_series(1, $1)`,
      [count]
    )
    return result.rows.map((r) => BigInt(r.id))
  }

  function makeEntry(outboxEventId: bigint, overrides?: Partial<SyncLogEntryInput>): SyncLogEntryInput {
    return {
      outboxEventId,
      eventType: "message:created",
      groups: ["stream:stream_test"],
      payload: { workspaceId: "ws_x", event: { id: `evt_${outboxEventId}` } },
      ...overrides,
    }
  }

  function uniqueWorkspaceId(): string {
    return `ws_test_${crypto.randomUUID().replaceAll("-", "")}`
  }

  async function fetchLog(workspaceId: string) {
    const result = await pool.query<{
      sync_id: string
      outbox_event_id: string
      event_type: string
      groups: string[]
      payload: unknown
    }>(
      `SELECT sync_id, outbox_event_id, event_type, groups, payload FROM sync_log WHERE workspace_id = $1 ORDER BY sync_id`,
      [workspaceId]
    )
    return result.rows
  }

  test("allocates dense sync ids from 1 in input order and round-trips groups + payload", async () => {
    const workspaceId = uniqueWorkspaceId()
    const ids = await reserveOutboxIds(3)
    const sealedPayload = { workspaceId, sealed: { v: 1, ciphertext: "bRq+aGVsbG8=", nonce: "AAAA" } }
    const entries = [
      makeEntry(ids[0]),
      makeEntry(ids[1], { eventType: "stream:activity", groups: ["stream:stream_a", "stream:stream_b"] }),
      makeEntry(ids[2], { eventType: "message:created", payload: sealedPayload }),
    ]

    const assigned = await SyncLogRepository.appendForWorkspace(pool, workspaceId, entries)

    expect([...assigned.entries()]).toEqual([
      [ids[0], 1n],
      [ids[1], 2n],
      [ids[2], 3n],
    ])

    const rows = await fetchLog(workspaceId)
    expect(rows).toEqual([
      expect.objectContaining({
        sync_id: "1",
        outbox_event_id: ids[0].toString(),
        event_type: "message:created",
        groups: ["stream:stream_test"],
      }),
      expect.objectContaining({
        sync_id: "2",
        groups: ["stream:stream_a", "stream:stream_b"],
      }),
      // E2EE passthrough: sealed payloads land in the log untouched
      expect.objectContaining({
        sync_id: "3",
        payload: sealedPayload,
      }),
    ])
  })

  test("is idempotent: re-appending the same events returns the original sync ids without new rows", async () => {
    const workspaceId = uniqueWorkspaceId()
    const ids = await reserveOutboxIds(2)
    const entries = [makeEntry(ids[0]), makeEntry(ids[1])]

    const first = await SyncLogRepository.appendForWorkspace(pool, workspaceId, entries)
    const retry = await SyncLogRepository.appendForWorkspace(pool, workspaceId, entries)

    expect(retry).toEqual(first)
    expect(await fetchLog(workspaceId)).toHaveLength(2)
  })

  test("a partially-sequenced batch (crash retry) keeps existing ids and extends densely", async () => {
    const workspaceId = uniqueWorkspaceId()
    const ids = await reserveOutboxIds(3)

    const first = await SyncLogRepository.appendForWorkspace(pool, workspaceId, [makeEntry(ids[0]), makeEntry(ids[1])])
    const retry = await SyncLogRepository.appendForWorkspace(pool, workspaceId, [
      makeEntry(ids[0]),
      makeEntry(ids[1]),
      makeEntry(ids[2]),
    ])

    expect(retry.get(ids[0])).toBe(first.get(ids[0])!)
    expect(retry.get(ids[1])).toBe(first.get(ids[1])!)
    expect(retry.get(ids[2])).toBe(3n)
  })

  test("sequences are independent per workspace", async () => {
    const workspaceA = uniqueWorkspaceId()
    const workspaceB = uniqueWorkspaceId()
    const ids = await reserveOutboxIds(2)

    const a = await SyncLogRepository.appendForWorkspace(pool, workspaceA, [makeEntry(ids[0])])
    const b = await SyncLogRepository.appendForWorkspace(pool, workspaceB, [makeEntry(ids[1])])

    expect(a.get(ids[0])).toBe(1n)
    expect(b.get(ids[1])).toBe(1n)
  })

  test("concurrent appends to one workspace stay dense and gapless", async () => {
    const workspaceId = uniqueWorkspaceId()
    const batches = 8
    const perBatch = 5
    const ids = await reserveOutboxIds(batches * perBatch)

    const results = await Promise.all(
      Array.from({ length: batches }, (_, b) =>
        SyncLogRepository.appendForWorkspace(
          pool,
          workspaceId,
          ids.slice(b * perBatch, (b + 1) * perBatch).map((id) => makeEntry(id))
        )
      )
    )

    const allAssigned = results.flatMap((m) => [...m.values()]).sort((a, b) => (a < b ? -1 : 1))
    expect(allAssigned).toEqual(Array.from({ length: batches * perBatch }, (_, i) => BigInt(i + 1)))

    const rows = await fetchLog(workspaceId)
    expect(rows.map((r) => r.sync_id)).toEqual(Array.from({ length: batches * perBatch }, (_, i) => String(i + 1)))
  })
})
