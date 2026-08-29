/**
 * An aside is anchored like a thread (`parentStreamId` + `parentAnchorId`) but
 * is never the anchor's thread: a message sent in it must not bump reply
 * stats or emit `thread:updated` into the host room — that patch hands the
 * host message the aside as its `threadId` (thread card, reply count, and the
 * aside's own draft advertised under the host message).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService, StreamRepository } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { OutboxRepository } from "../../src/lib/outbox"
import { userId, workspaceId } from "../../src/lib/id"

describe("Aside reply stats", () => {
  let pool: Pool
  let streamService: StreamService
  let eventService: EventService
  let wsId: string
  let creator: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    eventService = new EventService(pool)
    wsId = workspaceId()
    await withTransaction(pool, async (client) => {
      creator = (await addTestMember(client, wsId, userId())).id
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Aside Reply Stats Workspace",
        slug: `aside-reply-stats-${wsId.toLowerCase()}`,
        createdBy: creator,
      })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a message sent in an aside emits no thread:updated and bumps no reply count", async () => {
    const channel = await streamService.createChannel({
      workspaceId: wsId,
      slug: `aside-stats-${wsId.toLowerCase()}`,
      visibility: "public",
      createdBy: creator,
    })
    const anchor = await eventService.createMessage({
      workspaceId: wsId,
      streamId: channel.id,
      authorId: creator,
      authorType: "user",
      ...testMessageContent("host message"),
    })
    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchor.id,
      createdBy: creator,
    })

    const baseline = await pool.query("SELECT COALESCE(MAX(id), 0) AS max_id FROM outbox")
    const baselineId = BigInt(baseline.rows[0].max_id)

    const sent = await eventService.createMessage({
      workspaceId: wsId,
      streamId: aside.id,
      authorId: creator,
      authorType: "user",
      ...testMessageContent("private question"),
    })
    await eventService.editMessageInternal({
      workspaceId: wsId,
      streamId: aside.id,
      messageId: sent.id,
      actorId: creator,
      ...testMessageContent("private question, edited"),
    })

    const outboxEvents = await OutboxRepository.fetchAfterId(pool, baselineId)
    expect(outboxEvents.map((event) => event.eventType)).not.toContain("thread:updated")
    expect(outboxEvents.some((event) => event.eventType === "message:created")).toBe(true)

    const asideRow = await StreamRepository.findById(pool, aside.id)
    expect(asideRow?.replyCount ?? 0).toBe(0)
    expect(await StreamRepository.findThreadSummaryByParentMessage(pool, channel.id, anchor.id)).toBeNull()
  })
})
