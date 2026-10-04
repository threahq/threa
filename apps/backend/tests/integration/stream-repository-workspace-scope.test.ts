import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StreamTypes, Visibilities } from "@threahq/types"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"
import { EventService } from "../../src/features/messaging"
import { StreamRepository, StreamService } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { streamId, userId, workspaceId } from "../../src/lib/id"

describe("StreamRepository workspace scope (INV-8)", () => {
  let pool: Pool
  let streamService: StreamService
  let eventService: EventService
  let suffix: string

  let wsA: string
  let wsB: string
  let userA: string
  let channelA: string
  let channelSlugA: string
  let messageA: string
  let threadA: string
  let replyA: string
  let channelB: string
  let threadB: string

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    const user = await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id,
        name: `Scope ${label}`,
        slug: `scope-${label}-${id}`,
        createdBy: userId(),
      })
      return addTestMember(client, id, userId())
    })
    return { id, userId: user.id }
  }

  function sortedIds(streams: Array<{ id: string }>) {
    return streams.map((stream) => stream.id).sort()
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    eventService = new EventService(pool)
    suffix = Math.random().toString(36).slice(2, 8)

    const a = await seedWorkspace("a")
    const b = await seedWorkspace("b")
    wsA = a.id
    wsB = b.id
    userA = a.userId

    channelSlugA = `scope-alpha-${suffix}`
    const channel = await streamService.createChannel({
      workspaceId: wsA,
      slug: channelSlugA,
      createdBy: userA,
      visibility: Visibilities.PUBLIC,
    })
    channelA = channel.id

    const message = await eventService.createMessage({
      workspaceId: wsA,
      streamId: channelA,
      authorId: userA,
      authorType: "user",
      ...testMessageContent("Parent"),
    })
    messageA = message.id

    const thread = await streamService.createThread({
      workspaceId: wsA,
      parentStreamId: channelA,
      parentAnchorId: messageA,
      createdBy: userA,
      principal: { kind: "user", userId: userA },
    })
    threadA = thread.id

    const reply = await eventService.createMessage({
      workspaceId: wsA,
      streamId: threadA,
      authorId: userA,
      authorType: "user",
      ...testMessageContent("Reply"),
    })
    replyA = reply.id

    const channelOfB = await streamService.createChannel({
      workspaceId: wsB,
      slug: `scope-beta-${suffix}`,
      createdBy: b.userId,
      visibility: Visibilities.PUBLIC,
    })
    channelB = channelOfB.id

    // Rooted at A's public channel: only a missing workspace pin on the access-root lookup would admit it.
    threadB = streamId()
    await StreamRepository.insert(pool, {
      id: threadB,
      workspaceId: wsB,
      type: StreamTypes.THREAD,
      visibility: Visibilities.PRIVATE,
      parentStreamId: channelB,
      parentAnchorId: `msg_${suffix}`,
      rootStreamId: channelA,
      createdBy: b.userId,
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should return the stream only for its own workspace when finding by id", async () => {
    expect({
      a: await StreamRepository.findById(pool, wsA, channelA),
      b: await StreamRepository.findById(pool, wsB, channelA),
    }).toEqual({ a: expect.objectContaining({ id: channelA, workspaceId: wsA }), b: null })
  })

  test("should return the stream only for its own workspace when finding by ids", async () => {
    const ids = [channelA, threadA]
    expect({
      a: sortedIds(await StreamRepository.findByIds(pool, wsA, ids)),
      b: await StreamRepository.findByIds(pool, wsB, ids),
    }).toEqual({ a: [...ids].sort(), b: [] })
  })

  test("should return the stream only for its own workspace when finding for share", async () => {
    expect({
      a: await StreamRepository.findByIdForShare(pool, wsA, channelA),
      b: await StreamRepository.findByIdForShare(pool, wsB, channelA),
    }).toEqual({ a: expect.objectContaining({ id: channelA }), b: null })
  })

  test("should return the stream only for its own workspace when locking for update", async () => {
    const found = await withTransaction(pool, async (client) => ({
      a: await StreamRepository.findByIdForUpdateBlocking(client, wsA, channelA),
      b: await StreamRepository.findByIdForUpdateBlocking(client, wsB, channelA),
    }))
    expect(found).toEqual({ a: expect.objectContaining({ id: channelA }), b: null })
  })

  test("should return the thread only for its own workspace when finding by anchor", async () => {
    expect({
      a: await StreamRepository.findByAnchor(pool, wsA, channelA, messageA),
      b: await StreamRepository.findByAnchor(pool, wsB, channelA, messageA),
    }).toEqual({ a: expect.objectContaining({ id: threadA }), b: null })
  })

  test("should return thread ids only for their own workspace when finding threads for message ids", async () => {
    const forA = await StreamRepository.findThreadsForMessageIds(pool, wsA, channelA, [messageA])
    const forB = await StreamRepository.findThreadsForMessageIds(pool, wsB, channelA, [messageA])
    expect({ a: Object.fromEntries(forA), b: Object.fromEntries(forB) }).toEqual({
      a: { [messageA]: threadA },
      b: {},
    })
  })

  test("should return reply counts only for their own workspace when finding threads with reply counts", async () => {
    const forA = await StreamRepository.findThreadsWithReplyCounts(pool, wsA, channelA)
    const forB = await StreamRepository.findThreadsWithReplyCounts(pool, wsB, channelA)
    expect({ a: Object.fromEntries(forA), b: Object.fromEntries(forB) }).toEqual({
      a: { [messageA]: { threadId: threadA, replyCount: 1 } },
      b: {},
    })
  })

  test("should return summaries only for their own workspace when finding thread summaries", async () => {
    const forA = await StreamRepository.findThreadSummaries(pool, wsA, channelA)
    const forB = await StreamRepository.findThreadSummaries(pool, wsB, channelA)
    expect({ a: Object.fromEntries(forA), b: Object.fromEntries(forB) }).toEqual({
      a: { [messageA]: expect.objectContaining({ latestReply: expect.objectContaining({ messageId: replyA }) }) },
      b: {},
    })
  })

  test("should return the summary only for its own workspace when finding it by parent message", async () => {
    expect({
      a: await StreamRepository.findThreadSummaryByParentMessage(pool, wsA, channelA, messageA),
      b: await StreamRepository.findThreadSummaryByParentMessage(pool, wsB, channelA, messageA),
    }).toEqual({ a: expect.objectContaining({ latestReply: expect.objectContaining({ messageId: replyA }) }), b: null })
  })

  test("should report ancestry only within the stream's own workspace when checking isAncestor", async () => {
    expect({
      a: await StreamRepository.isAncestor(pool, wsA, channelA, threadA),
      b: await StreamRepository.isAncestor(pool, wsB, channelA, threadA),
    }).toEqual({ a: true, b: false })
  })

  test("should list descendants only within the stream's own workspace when listing self and descendants", async () => {
    expect({
      a: (await StreamRepository.listSelfAndDescendantIds(pool, wsA, channelA)).sort(),
      b: await StreamRepository.listSelfAndDescendantIds(pool, wsB, channelA),
    }).toEqual({ a: [channelA, threadA].sort(), b: [] })
  })

  test("should list the chain only within the stream's own workspace when listing ancestor chain ids", async () => {
    expect({
      a: (await StreamRepository.listAncestorChainIds(pool, wsA, [threadA])).sort(),
      b: await StreamRepository.listAncestorChainIds(pool, wsB, [threadA]),
    }).toEqual({ a: [channelA, threadA].sort(), b: [] })
  })

  describe("listWithPreviews", () => {
    test("should list only its own workspace's streams when no filter is given", async () => {
      expect({
        a: sortedIds(await StreamRepository.listWithPreviews(pool, wsA)),
        b: sortedIds(await StreamRepository.listWithPreviews(pool, wsB)),
      }).toEqual({ a: [channelA, threadA].sort(), b: [channelB, threadB].sort() })
    })

    test("should list only its own workspace's streams when filtering by types", async () => {
      const filters = { types: [StreamTypes.THREAD] }
      expect({
        a: sortedIds(await StreamRepository.listWithPreviews(pool, wsA, filters)),
        b: sortedIds(await StreamRepository.listWithPreviews(pool, wsB, filters)),
      }).toEqual({ a: [threadA], b: [threadB] })
    })

    test("should list only its own workspace's streams when filtering by viewer", async () => {
      const filters = { viewerUserId: userA }
      expect({
        a: sortedIds(await StreamRepository.listWithPreviews(pool, wsA, filters)),
        b: sortedIds(await StreamRepository.listWithPreviews(pool, wsB, filters)),
      }).toEqual({ a: [channelA, threadA].sort(), b: [channelB] })
    })

    test("should list only its own workspace's streams when filtering by types and viewer", async () => {
      const filters = { types: [StreamTypes.THREAD], viewerUserId: userA }
      expect({
        a: sortedIds(await StreamRepository.listWithPreviews(pool, wsA, filters)),
        b: sortedIds(await StreamRepository.listWithPreviews(pool, wsB, filters)),
      }).toEqual({ a: [threadA], b: [] })
    })
  })

  describe("searchByName", () => {
    test("should search only its own workspace's streams when no types are given", async () => {
      const params = { streamIds: [channelA, threadA], query: channelSlugA }
      expect({
        a: sortedIds(await StreamRepository.searchByName(pool, { ...params, workspaceId: wsA })),
        b: await StreamRepository.searchByName(pool, { ...params, workspaceId: wsB }),
      }).toEqual({ a: [channelA], b: [] })
    })

    test("should search only its own workspace's streams when filtering by types", async () => {
      const params = { streamIds: [channelA, threadA], query: channelSlugA, types: [StreamTypes.CHANNEL] }
      expect({
        a: sortedIds(await StreamRepository.searchByName(pool, { ...params, workspaceId: wsA })),
        b: await StreamRepository.searchByName(pool, { ...params, workspaceId: wsB }),
      }).toEqual({ a: [channelA], b: [] })
    })
  })

  test("should return the streams only for their own workspace when locking many for update", async () => {
    const found = await withTransaction(pool, async (client) => ({
      a: sortedIds(await StreamRepository.findByIdsForUpdateBlocking(client, wsA, [channelA])),
      b: await StreamRepository.findByIdsForUpdateBlocking(client, wsB, [channelA]),
    }))
    expect(found).toEqual({ a: [channelA], b: [] })
  })

  test("should return the streams only for their own workspace when listing by ids", async () => {
    expect({
      a: sortedIds(await StreamRepository.listByIds(pool, wsA, [channelA])),
      b: await StreamRepository.listByIds(pool, wsB, [channelA]),
    }).toEqual({ a: [channelA], b: [] })
  })

  test("should return anchors only for their own workspace when finding anchors with replies", async () => {
    expect({
      a: [...(await StreamRepository.findAnchorsWithReplies(pool, wsA, channelA, [messageA]))],
      b: [...(await StreamRepository.findAnchorsWithReplies(pool, wsB, channelA, [messageA]))],
    }).toEqual({ a: [messageA], b: [] })
  })

  test("should leave the counts unchanged when adjusting them through another workspace", async () => {
    const counts = async () => {
      const [channel, thread] = await Promise.all([
        StreamRepository.findById(pool, wsA, channelA),
        StreamRepository.findById(pool, wsA, threadA),
      ])
      return { messageCount: channel?.messageCount, replyCount: thread?.replyCount }
    }
    const before = await counts()

    const throughB = await withTransaction(pool, async (client) => ({
      bump: await StreamRepository.bumpThreadReplyCount(client, wsB, threadA, 5),
      adjust: await StreamRepository.adjustMessageCount(client, wsB, channelA, 5),
      recount: await StreamRepository.recountMessages(client, wsB, channelA),
    }))

    expect({ throughB, after: await counts() }).toEqual({
      throughB: { bump: null, adjust: null, recount: null },
      after: before,
    })
  })

  test("should leave the stream unchanged when updating it through another workspace", async () => {
    const channel = await streamService.createChannel({
      workspaceId: wsA,
      slug: `scope-update-${suffix}`,
      description: "original",
      createdBy: userA,
      visibility: Visibilities.PUBLIC,
    })

    expect({
      updatedThroughB: await StreamRepository.update(pool, wsB, channel.id, { description: "changed" }),
      readBackThroughA: await StreamRepository.findById(pool, wsA, channel.id),
    }).toEqual({ updatedThroughB: null, readBackThroughA: expect.objectContaining({ description: "original" }) })
  })
})
