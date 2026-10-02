import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StreamTypes, Visibilities } from "@threahq/types"
import { addTestMember, setupTestDatabase } from "./setup"
import { ActivityRepository } from "../../src/features/activity"
import { SearchRepository } from "../../src/features/search"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { activityId, streamId, userId, workspaceId } from "../../src/lib/id"

describe("Archive filter and activity sealed-stream workspace scope (INV-8)", () => {
  let pool: Pool

  let wsA: string
  let wsB: string
  let viewer: string

  let activeA: string
  let archivedA: string
  let sealedChild: string
  let childOfForeignArchive: string
  let foreignArchived: string

  let activityActive: string
  let activitySealed: string
  let activityForeignStream: string
  let activityChildOfForeign: string
  let activityOtherWorkspace: string

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    await WorkspaceRepository.insert(pool, {
      id,
      name: `Archive scope ${label}`,
      slug: `archive-scope-${label}-${id}`,
      createdBy: userId(),
    })
    return id
  }

  async function seedMember(wid: string) {
    return (await addTestMember(pool, wid, userId())).id
  }

  async function seedStream(
    wid: string,
    options: { type?: string; parent?: string; root?: string; archived?: boolean; createdBy: string }
  ) {
    const id = streamId()
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, slug, visibility, parent_stream_id, root_stream_id, created_by, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        wid,
        options.type ?? StreamTypes.CHANNEL,
        options.type === StreamTypes.THREAD ? null : `archive-scope-${id}`,
        Visibilities.PUBLIC,
        options.parent ?? null,
        options.root ?? null,
        options.createdBy,
        options.archived ? new Date() : null,
      ]
    )
    return id
  }

  async function seedActivity(stream: string, wid = wsA) {
    const id = activityId()
    await pool.query(
      `INSERT INTO user_activity (id, workspace_id, user_id, activity_type, stream_id, actor_id, actor_type)
       VALUES ($1, $2, $3, 'mention', $4, $5, 'user')`,
      [id, wid, viewer, stream, userId()]
    )
    return id
  }

  const sorted = (ids: string[]) => [...ids].sort()

  beforeAll(async () => {
    pool = await setupTestDatabase()

    wsA = await seedWorkspace("a")
    wsB = await seedWorkspace("b")
    viewer = await seedMember(wsA)
    const bMember = await seedMember(wsB)

    activeA = await seedStream(wsA, { createdBy: viewer })
    archivedA = await seedStream(wsA, { archived: true, createdBy: viewer })
    sealedChild = await seedStream(wsA, {
      type: StreamTypes.THREAD,
      parent: archivedA,
      root: archivedA,
      createdBy: viewer,
    })
    foreignArchived = await seedStream(wsB, { archived: true, createdBy: bMember })
    childOfForeignArchive = await seedStream(wsA, { parent: foreignArchived, createdBy: viewer })

    activityActive = await seedActivity(activeA)
    activitySealed = await seedActivity(archivedA)
    activityForeignStream = await seedActivity(foreignArchived)
    activityChildOfForeign = await seedActivity(childOfForeignArchive)
    activityOtherWorkspace = await seedActivity(activeA, wsB)
  }, 60_000)

  afterAll(async () => {
    await pool.end()
  })

  test("should keep a stream active when its parent is an archived stream of another workspace", async () => {
    const streams = await SearchRepository.getPublicStreams(pool, wsA)

    expect(sorted(streams)).toEqual(sorted([activeA, childOfForeignArchive]))
  })

  test("should list only the workspace's own sealed subtree as archived when the archived filter is on", async () => {
    const streams = await SearchRepository.getPublicStreams(pool, wsA, { archiveStatus: ["archived"] })

    expect(sorted(streams)).toEqual(sorted([archivedA, sealedChild]))
  })

  test("should hide an activity row only when its stream is sealed in the workspace when listing activity", async () => {
    const rows = await ActivityRepository.listByUser(pool, viewer, wsA)

    expect(sorted(rows.map((row) => row.id))).toEqual(
      sorted([activityActive, activityForeignStream, activityChildOfForeign])
    )
  })

  test("should page from a cursor only when the cursor row belongs to the workspace", async () => {
    const rows = await ActivityRepository.listByUser(pool, viewer, wsA, { cursor: activityOtherWorkspace })

    expect(rows).toEqual([])
  })

  test("should count an activity row only when its stream is not sealed in the workspace when counting unread", async () => {
    const counts = await ActivityRepository.countUnreadGrouped(pool, viewer, wsA)

    expect({
      total: counts.total,
      streams: sorted([...counts.totalByStream.keys()]),
    }).toEqual({
      total: 3,
      streams: sorted([activeA, foreignArchived, childOfForeignArchive]),
    })
  })

  test("should report a stream as sealed only through the workspace's own streams when finding an activity row", async () => {
    const found = await Promise.all(
      [activityActive, activitySealed, activityForeignStream, activityChildOfForeign].map(async (id) => {
        const result = await ActivityRepository.findForUser(pool, wsA, viewer, id)
        return [id, result?.streamSealed]
      })
    )

    expect(Object.fromEntries(found)).toEqual({
      [activityActive]: false,
      [activitySealed]: true,
      [activityForeignStream]: false,
      [activityChildOfForeign]: false,
    })
  })

  test("should not find another workspace's activity row when looking it up by id", async () => {
    const found = await ActivityRepository.findForUser(pool, wsA, viewer, activityOtherWorkspace)

    expect(found).toBeNull()
  })
})
