import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { SyncLogRepository, type SyncLogEntryInput } from "../../src/features/sync"

describe("SyncLogRepository catch-up reads", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function reserveOutboxIds(count: number): Promise<bigint[]> {
    const result = await pool.query<{ id: string }>(
      `SELECT nextval('outbox_id_seq') AS id FROM generate_series(1, $1)`,
      [count]
    )
    return result.rows.map((r) => BigInt(r.id))
  }

  function uniqueId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`
  }

  async function addMembership(streamId: string, userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO stream_members (stream_id, member_id) VALUES ($1, $2) ON CONFLICT (stream_id, member_id) DO NOTHING`,
      [streamId, userId]
    )
  }

  /** Appends one entry and returns its sync id. */
  async function appendEntry(workspaceId: string, entry: Omit<SyncLogEntryInput, "outboxEventId">): Promise<bigint> {
    const [outboxEventId] = await reserveOutboxIds(1)
    const assigned = await SyncLogRepository.appendForWorkspace(pool, workspaceId, [{ ...entry, outboxEventId }])
    return assigned.get(outboxEventId)!
  }

  function listFor(workspaceId: string, userId: string, after = 0n, limit = 100) {
    return SyncLogRepository.listEntriesForUser(pool, { workspaceId, userId, after, limit })
  }

  test("filters entries to the requester's groups: workspace, own user, member streams", async () => {
    const workspaceId = uniqueId("ws")
    const alice = uniqueId("usr")
    const bob = uniqueId("usr")
    const aliceStream = uniqueId("stream")
    const bobStream = uniqueId("stream")
    await addMembership(aliceStream, alice)
    await addMembership(bobStream, bob)

    const workspaceWide = await appendEntry(workspaceId, {
      eventType: "stream:created",
      groups: ["workspace"],
      payload: { workspaceId, kind: "workspace-wide" },
    })
    const aliceOnly = await appendEntry(workspaceId, {
      eventType: "activity:created",
      groups: [`user:${alice}`],
      payload: { workspaceId, kind: "alice-only" },
    })
    const aliceStreamEntry = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${aliceStream}`],
      payload: { workspaceId, kind: "alice-stream" },
    })
    const bobStreamEntry = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${bobStream}`],
      payload: { workspaceId, kind: "bob-stream" },
    })

    const aliceEntries = await listFor(workspaceId, alice)
    expect(aliceEntries.map((e) => e.syncId)).toEqual([workspaceWide, aliceOnly, aliceStreamEntry])

    const bobEntries = await listFor(workspaceId, bob)
    expect(bobEntries.map((e) => e.syncId)).toEqual([workspaceWide, bobStreamEntry])
  })

  test("bounds stream groups by the member_added join position — no pre-join history", async () => {
    const workspaceId = uniqueId("ws")
    const joiner = uniqueId("usr")
    const streamId = uniqueId("stream")

    const preJoin = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${streamId}`],
      payload: { workspaceId, kind: "pre-join" },
    })
    const joinEntry = await appendEntry(workspaceId, {
      eventType: "stream:member_added",
      groups: [`stream:${streamId}`, `user:${joiner}`],
      payload: { workspaceId, streamId, memberId: joiner },
    })
    await addMembership(streamId, joiner)
    const postJoin = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${streamId}`],
      payload: { workspaceId, kind: "post-join" },
    })

    const entries = await listFor(workspaceId, joiner)
    const syncIds = entries.map((e) => e.syncId)
    // The join entry itself arrives via the user group; pre-join stream
    // history stays out of the log path (windowed snapshots cover it).
    expect(syncIds).toEqual([joinEntry, postJoin])
    expect(syncIds).not.toContain(preJoin)
  })

  test("a membership predating the log (no member_added entry) is unbounded", async () => {
    const workspaceId = uniqueId("ws")
    const veteran = uniqueId("usr")
    const streamId = uniqueId("stream")
    await addMembership(streamId, veteran)

    const entry = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${streamId}`],
      payload: { workspaceId, kind: "any" },
    })

    const entries = await listFor(workspaceId, veteran)
    expect(entries.map((e) => e.syncId)).toEqual([entry])
  })

  test("a rejoin moves the bound forward — entries from the left period stay hidden", async () => {
    const workspaceId = uniqueId("ws")
    const userId = uniqueId("usr")
    const streamId = uniqueId("stream")

    await appendEntry(workspaceId, {
      eventType: "stream:member_added",
      groups: [`stream:${streamId}`, `user:${userId}`],
      payload: { workspaceId, streamId, memberId: userId },
    })
    const whileGone = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${streamId}`],
      payload: { workspaceId, kind: "while-gone" },
    })
    const rejoin = await appendEntry(workspaceId, {
      eventType: "stream:member_added",
      groups: [`stream:${streamId}`, `user:${userId}`],
      payload: { workspaceId, streamId, memberId: userId },
    })
    await addMembership(streamId, userId)
    const afterRejoin = await appendEntry(workspaceId, {
      eventType: "message:created",
      groups: [`stream:${streamId}`],
      payload: { workspaceId, kind: "after-rejoin" },
    })

    const syncIds = (await listFor(workspaceId, userId)).map((e) => e.syncId)
    expect(syncIds).not.toContain(whileGone)
    expect(syncIds).toContain(rejoin)
    expect(syncIds).toContain(afterRejoin)
  })

  test("pages by cursor and respects the limit", async () => {
    const workspaceId = uniqueId("ws")
    const userId = uniqueId("usr")

    const ids: bigint[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(
        await appendEntry(workspaceId, {
          eventType: "stream:created",
          groups: ["workspace"],
          payload: { workspaceId, i },
        })
      )
    }

    const firstPage = await listFor(workspaceId, userId, 0n, 2)
    expect(firstPage.map((e) => e.syncId)).toEqual(ids.slice(0, 2))

    const secondPage = await listFor(workspaceId, userId, firstPage[1].syncId, 2)
    expect(secondPage.map((e) => e.syncId)).toEqual(ids.slice(2, 4))
  })

  test("head is the workspace's max sync id, 0 for an empty log", async () => {
    const workspaceId = uniqueId("ws")
    expect(await SyncLogRepository.getHead(pool, workspaceId)).toBe(0n)

    const last = await appendEntry(workspaceId, {
      eventType: "stream:created",
      groups: ["workspace"],
      payload: { workspaceId },
    })
    expect(await SyncLogRepository.getHead(pool, workspaceId)).toBe(last)
  })

  test("entries are isolated per workspace", async () => {
    const workspaceA = uniqueId("ws")
    const workspaceB = uniqueId("ws")
    const userId = uniqueId("usr")

    await appendEntry(workspaceA, {
      eventType: "stream:created",
      groups: ["workspace"],
      payload: { workspaceId: workspaceA },
    })

    expect(await listFor(workspaceB, userId)).toEqual([])
  })
})
