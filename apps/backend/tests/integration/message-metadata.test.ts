import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { EventService } from "../../src/features/messaging/event-service"
import { userId, workspaceId, streamId } from "../../src/lib/id"

describe("Message metadata", () => {
  let pool: Pool
  let testUserId: string
  let testWorkspaceId: string
  let testStreamId: string
  let otherStreamId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()

    testUserId = userId()
    testWorkspaceId = workspaceId()
    testStreamId = streamId()
    otherStreamId = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Metadata WS",
        slug: `md-ws-${testWorkspaceId}`,
        createdBy: testUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, testUserId)).id
      for (const id of [testStreamId, otherStreamId]) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: testWorkspaceId,
          type: "scratchpad",
          visibility: "private",
          companionMode: "off",
          createdBy: testUserId,
        })
      }
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("persists and returns metadata round-trip on the projection", async () => {
    const service = new EventService(pool)
    const metadata = { source: "github", "github.pr.id": "1", "github.event": "opened" }

    const msg = await service.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("with metadata"),
      metadata,
    })

    expect(msg.metadata).toEqual(metadata)

    const refetched = await MessageRepository.findById(pool, testWorkspaceId, msg.id)
    expect(refetched?.metadata).toEqual(metadata)
  })

  test("defaults metadata to empty object when omitted", async () => {
    const service = new EventService(pool)

    const msg = await service.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("no metadata"),
    })

    expect(msg.metadata).toEqual({})
  })

  test("findByMetadata requires AND-containment across all keys", async () => {
    const service = new EventService(pool)
    const prId = `and-${Date.now()}`

    const matching = await service.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("should match"),
      metadata: { "github.pr.id": prId, "github.event": "opened", source: "github" },
    })

    // Only partially matches (wrong event) — must be excluded.
    await service.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("wrong event"),
      metadata: { "github.pr.id": prId, "github.event": "closed", source: "github" },
    })

    const hits = await MessageRepository.findByMetadata(pool, {
      workspaceId: testWorkspaceId,
      streamIds: [testStreamId, otherStreamId],
      filter: { "github.pr.id": prId, "github.event": "opened" },
    })

    expect(hits.map((m) => m.id)).toEqual([matching.id])
  })

  test("findByMetadata scopes results to accessible streams", async () => {
    const service = new EventService(pool)
    const prId = `scope-${Date.now()}`

    // Message in otherStreamId — caller only has access to testStreamId.
    await service.createMessage({
      workspaceId: testWorkspaceId,
      streamId: otherStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("in other stream"),
      metadata: { "github.pr.id": prId },
    })

    const hits = await MessageRepository.findByMetadata(pool, {
      workspaceId: testWorkspaceId,
      streamIds: [testStreamId], // otherStreamId NOT included
      filter: { "github.pr.id": prId },
    })

    expect(hits).toEqual([])
  })

  test("findByMetadata with streamId filter intersects with accessible streams", async () => {
    const service = new EventService(pool)
    const prId = `stream-filter-${Date.now()}`

    const inA = await service.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("A"),
      metadata: { "github.pr.id": prId },
    })
    await service.createMessage({
      workspaceId: testWorkspaceId,
      streamId: otherStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("B"),
      metadata: { "github.pr.id": prId },
    })

    const hits = await MessageRepository.findByMetadata(pool, {
      workspaceId: testWorkspaceId,
      streamIds: [testStreamId, otherStreamId],
      filter: { "github.pr.id": prId },
      streamId: testStreamId,
    })

    expect(hits.map((m) => m.id)).toEqual([inA.id])
  })

  test("findByMetadata excludes soft-deleted messages", async () => {
    const service = new EventService(pool)
    const prId = `deleted-${Date.now()}`

    const msg = await service.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("to be deleted"),
      metadata: { "github.pr.id": prId },
    })

    await MessageRepository.softDelete(pool, testWorkspaceId, msg.id)

    const hits = await MessageRepository.findByMetadata(pool, {
      workspaceId: testWorkspaceId,
      streamIds: [testStreamId],
      filter: { "github.pr.id": prId },
    })
    expect(hits).toEqual([])
  })

  test("findByMetadata returns [] for empty input (filter or accessible streams)", async () => {
    const a = await MessageRepository.findByMetadata(pool, {
      workspaceId: testWorkspaceId,
      streamIds: [testStreamId],
      filter: {},
    })
    const b = await MessageRepository.findByMetadata(pool, {
      workspaceId: testWorkspaceId,
      streamIds: [],
      filter: { "github.pr.id": "x" },
    })
    expect(a).toEqual([])
    expect(b).toEqual([])
  })
})
