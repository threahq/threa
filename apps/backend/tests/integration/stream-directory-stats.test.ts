import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { withTransaction, addTestMember, setupTestDatabase, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService, StreamDirectoryStatsRepository } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { userId, workspaceId } from "../../src/lib/id"
import { Visibilities } from "@threahq/types"

describe("StreamDirectoryStatsRepository.listForViewer", () => {
  let pool: Pool
  let streamService: StreamService
  let eventService: EventService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    eventService = new EventService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should return member and activity stats for every stream the viewer can read", async () => {
    const wsId = workspaceId()
    const { ownerId, viewerId } = await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Directory Stats",
        slug: `dir-stats-${wsId}`,
        createdBy: userId(),
      })
      const owner = await addTestMember(client, wsId, userId())
      const viewer = await addTestMember(client, wsId, userId())
      return { ownerId: owner.id, viewerId: viewer.id }
    })

    const channel = (slug: string, visibility: (typeof Visibilities)[keyof typeof Visibilities]) =>
      streamService.createChannel({
        workspaceId: wsId,
        slug: `${slug}-${Date.now()}`,
        displayName: slug,
        createdBy: ownerId,
        visibility,
      })

    const memberPrivate = await channel("member-private", Visibilities.PRIVATE)
    await streamService.addMember(memberPrivate.id, viewerId, wsId, ownerId)
    const publicChannel = await channel("public", Visibilities.PUBLIC)
    await channel("hidden-private", Visibilities.PRIVATE)
    const archived = await channel("archived", Visibilities.PUBLIC)
    await streamService.archiveStream(archived.id, wsId, ownerId)

    const parent = await eventService.createMessage({
      workspaceId: wsId,
      streamId: memberPrivate.id,
      authorId: ownerId,
      authorType: "user",
      ...testMessageContent("parent"),
    })
    await eventService.createMessage({
      workspaceId: wsId,
      streamId: memberPrivate.id,
      authorId: ownerId,
      authorType: "user",
      ...testMessageContent("second"),
    })
    const thread = await streamService.createThread({
      workspaceId: wsId,
      parentStreamId: memberPrivate.id,
      parentAnchorId: parent.id,
      createdBy: ownerId,
      principal: { kind: "user", userId: ownerId },
    })

    const stats = await StreamDirectoryStatsRepository.listForViewer(pool, wsId, viewerId)
    const byId = new Map(stats.map((s) => [s.streamId, s]))
    const idle = new Array(14).fill(0)

    expect(new Set(byId.keys())).toEqual(new Set([memberPrivate.id, publicChannel.id, thread.id]))
    expect(byId.get(memberPrivate.id)).toEqual({
      streamId: memberPrivate.id,
      memberCount: 2,
      recentMemberIds: [viewerId, ownerId],
      activity: [2, ...idle.slice(1)],
    })
    expect(byId.get(publicChannel.id)).toEqual({
      streamId: publicChannel.id,
      memberCount: 1,
      recentMemberIds: [ownerId],
      activity: idle,
    })
  })
})
