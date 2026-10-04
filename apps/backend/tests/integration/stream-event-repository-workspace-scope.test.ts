import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AuthorTypes, Visibilities } from "@threahq/types"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"
import { EventService } from "../../src/features/messaging"
import { SparseReadRepository, StreamEventRepository, StreamService } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { eventId, messageId, userId, workspaceId } from "../../src/lib/id"

describe("StreamEventRepository workspace scope (INV-8)", () => {
  let pool: Pool
  let streamService: StreamService
  let eventService: EventService
  let suffix: string

  let wsA: string
  let wsB: string
  let userA: string

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    const user = await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id,
        name: `Event scope ${label}`,
        slug: `event-scope-${label}-${id}`,
        createdBy: userId(),
      })
      return addTestMember(client, id, userId())
    })
    return { id, userId: user.id }
  }

  async function sendMessage(workspace: string, streamId: string, authorId: string, text: string) {
    const message = await eventService.createMessage({
      workspaceId: workspace,
      streamId,
      authorId,
      authorType: "user",
      ...testMessageContent(text),
    })
    return message.id
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
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should ignore another workspace's events and read overlay in the same stream when counting unread", async () => {
    const channel = await streamService.createChannel({
      workspaceId: wsA,
      slug: `event-scope-decoy-${suffix}`,
      createdBy: userA,
      visibility: Visibilities.PUBLIC,
    })
    await sendMessage(wsA, channel.id, userA, "One")
    await sendMessage(wsA, channel.id, userA, "Two")
    const [first] = await StreamEventRepository.list(pool, wsA, channel.id)
    const decoyMessageId = messageId()
    // Above both of A's messages, so a watermark lookup without workspace_id reads every A event as read.
    await StreamEventRepository.allocateSequences(pool, wsB, channel.id, { total: 2, broadcast: 0 })
    const decoy = await StreamEventRepository.insert(pool, {
      id: eventId(),
      workspaceId: wsB,
      streamId: channel.id,
      eventType: "message_created",
      payload: { messageId: decoyMessageId },
      actorId: userA,
      actorType: AuthorTypes.USER,
    })
    await SparseReadRepository.insertReads(pool, {
      workspaceId: wsB,
      streamId: channel.id,
      memberId: userA,
      messageIds: [decoyMessageId],
    })

    const unread = async (lastReadEventId: string) =>
      (
        await StreamEventRepository.countUnreadByStreamBatch(pool, wsA, [
          { streamId: channel.id, memberId: userA, lastReadEventId },
        ])
      ).get(channel.id)

    expect({
      readThroughFirst: await unread(first.id),
      readThroughDecoy: await unread(decoy.id),
    }).toEqual({
      readThroughFirst: { unreadCount: 1, totalCount: 2 },
      readThroughDecoy: { unreadCount: 2, totalCount: 2 },
    })
  })
})
