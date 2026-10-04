import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { Visibilities } from "@threahq/types"
import { addTestMember, setupTestDatabase, withTransaction } from "./setup"
import { ReadStateRepository, StreamService } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { userId, workspaceId } from "../../src/lib/id"

describe("Read state and sparse overlay workspace scope (INV-8)", () => {
  let pool: Pool
  let streamService: StreamService

  let wsA: string
  let wsB: string
  let author: string
  let bAuthor: string

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id,
        name: `Read scope ${label}`,
        slug: `read-scope-${label}-${id}`,
        createdBy: userId(),
      })
    })
    return id
  }

  async function seedMember(wid: string) {
    return withTransaction(pool, async (client) => (await addTestMember(client, wid, userId())).id)
  }

  async function seedChannel(wid: string, createdBy: string = author) {
    const channel = await streamService.createChannel({
      workspaceId: wid,
      slug: `read-scope-${Math.random().toString(36).slice(2, 10)}`,
      createdBy,
      visibility: Visibilities.PUBLIC,
    })
    return channel.id
  }

  async function addReadState(
    wid: string,
    stream: string,
    user: string,
    state: { lastReadEventId?: string; held?: boolean; floorEventId?: string } = {}
  ) {
    await pool.query(
      `INSERT INTO stream_read_state (workspace_id, stream_id, user_id, last_read_event_id, inbox_held, inbox_floor_event_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [wid, stream, user, state.lastReadEventId ?? null, state.held ?? false, state.floorEventId ?? null]
    )
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)

    wsA = await seedWorkspace("a")
    wsB = await seedWorkspace("b")
    author = await seedMember(wsA)
    bAuthor = await seedMember(wsB)
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should return no read state when only another workspace holds the row for that stream and user", async () => {
    const stream = await seedChannel(wsB, bAuthor)
    const user = userId()
    await addReadState(wsB, stream, user)

    expect(await ReadStateRepository.ensureForUpdate(pool, wsA, stream, user)).toBeNull()
  })

  test("should land its own read state beside another workspace's row when both hold the same stream and user ids", async () => {
    const stream = await seedChannel(wsA)
    const user = userId()
    await addReadState(wsB, stream, user, { held: true })

    const own = await ReadStateRepository.ensureForUpdate(pool, wsA, stream, user)
    const rows = await pool.query<{ workspace_id: string; inbox_held: boolean }>(
      "SELECT workspace_id, inbox_held FROM stream_read_state WHERE stream_id = $1 AND user_id = $2 ORDER BY inbox_held",
      [stream, user]
    )

    expect({ own: own?.workspaceId, rows: rows.rows }).toEqual({
      own: wsA,
      rows: [
        { workspace_id: wsA, inbox_held: false },
        { workspace_id: wsB, inbox_held: true },
      ],
    })
  })

  test("should leave another workspace's read state unlocked when batch ensuring for update", async () => {
    const stream = await seedChannel(wsA)
    const user = userId()
    await addReadState(wsB, stream, user)

    const unlocked = await withTransaction(pool, async (client) => {
      await ReadStateRepository.ensureBatchForUpdate(client, wsA, user, [stream])
      const probe = await pool.query(
        `SELECT workspace_id FROM stream_read_state WHERE stream_id = $1 AND user_id = $2 FOR UPDATE SKIP LOCKED`,
        [stream, user]
      )
      return probe.rows
    })

    expect(unlocked).toEqual([{ workspace_id: wsB }])
  })
})
