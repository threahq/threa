import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StreamTypes, Visibilities } from "@threahq/types"
import { addTestMember, setupTestDatabase } from "./setup"
import { SyncLogRepository, type SyncLogEntryInput } from "../../src/features/sync"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { streamId, userId, workspaceId } from "../../src/lib/id"

describe("Sync catch-up listing workspace scope (INV-8, INV-62)", () => {
  let pool: Pool

  let wsA: string
  let wsB: string
  let publicB: string

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    await WorkspaceRepository.insert(pool, {
      id,
      name: `Sync scope ${label}`,
      slug: `sync-scope-${label}-${id}`,
      createdBy: userId(),
    })
    return id
  }

  async function seedMember(wid: string) {
    return (await addTestMember(pool, wid, userId())).id
  }

  async function seedStream(wid: string, options: { visibility?: string; root?: string; createdBy: string }) {
    const id = streamId()
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, slug, visibility, parent_stream_id, root_stream_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7)`,
      [
        id,
        wid,
        options.root ? StreamTypes.THREAD : StreamTypes.CHANNEL,
        options.root ? null : `sync-scope-${id}`,
        options.visibility ?? Visibilities.PRIVATE,
        options.root ?? null,
        options.createdBy,
      ]
    )
    return id
  }

  async function addMember(wid: string, stream: string, member: string) {
    await pool.query(`INSERT INTO stream_members (stream_id, member_id, workspace_id) VALUES ($1, $2, $3)`, [
      stream,
      member,
      wid,
    ])
  }

  async function append(
    wid: string,
    entries: Array<Pick<SyncLogEntryInput, "groups"> & { marker: string; eventType?: string; streamId?: string }>
  ) {
    const reserved = await pool.query<{ id: string }>(
      `SELECT nextval('outbox_id_seq') AS id FROM generate_series(1, $1)`,
      [entries.length]
    )
    await SyncLogRepository.appendForWorkspace(
      pool,
      wid,
      entries.map((entry, index) => ({
        outboxEventId: BigInt(reserved.rows[index]!.id),
        eventType: entry.eventType ?? "message:created",
        groups: entry.groups,
        payload: { marker: entry.marker, streamId: entry.streamId },
      }))
    )
  }

  async function visibleMarkers(user: string) {
    const entries = await SyncLogRepository.listEntriesForUser(pool, {
      workspaceId: wsA,
      userId: user,
      permissionGroups: [],
      after: 0n,
      limit: 100,
    })
    return entries.map((entry) => (entry.payload as { marker: string }).marker)
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()

    wsA = await seedWorkspace("a")
    wsB = await seedWorkspace("b")
    const bMember = await seedMember(wsB)
    publicB = await seedStream(wsB, { visibility: Visibilities.PUBLIC, createdBy: bMember })

    await append(wsA, [{ marker: "a-workspace", groups: ["workspace"] }])
    await append(wsB, [
      ...Array.from({ length: 5 }, (_, index) => ({ marker: `b-filler-${index}`, groups: ["workspace"] })),
      { marker: "b-last", groups: ["workspace"] },
    ])
  }, 60_000)

  afterAll(async () => {
    await pool.end()
  })

  test("should hide a stream's entries when the user's only membership row belongs to another workspace", async () => {
    const user = await seedMember(wsA)
    const owner = await seedMember(wsA)
    const stream = await seedStream(wsA, { createdBy: owner })
    await addMember(wsB, stream, user)
    await append(wsA, [{ marker: "a-foreign-membership", groups: [`stream:${stream}`] }])

    expect(await visibleMarkers(user)).toEqual(["a-workspace"])
  })

  test("should hide a stream's entries when its root is a public stream of another workspace", async () => {
    const user = await seedMember(wsA)
    const stream = await seedStream(wsA, { root: publicB, createdBy: user })
    await append(wsA, [{ marker: "a-foreign-root", groups: [`stream:${stream}`] }])

    expect(await visibleMarkers(user)).toEqual(["a-workspace"])
  })

  test("should bound a membership by the workspace's own join entry when another workspace logged a later one", async () => {
    const user = await seedMember(wsA)
    const stream = await seedStream(wsA, { createdBy: user })
    await addMember(wsA, stream, user)
    await append(wsA, [{ marker: "a-member-stream", groups: [`stream:${stream}`] }])
    await append(wsB, [
      {
        marker: "b-member-added",
        eventType: "stream:member_added",
        groups: [`user:${user}`],
        streamId: stream,
      },
    ])

    expect(await visibleMarkers(user)).toEqual(["a-workspace", "a-member-stream"])
  })

  test("should hide an entry that names another workspace's public stream", async () => {
    const user = await seedMember(wsA)
    await append(wsA, [{ marker: "a-names-foreign-stream", groups: [`stream:${publicB}`] }])

    expect(await visibleMarkers(user)).toEqual(["a-workspace"])
  })
})
