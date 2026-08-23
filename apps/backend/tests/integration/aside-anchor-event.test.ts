/**
 * Aside anchor event (PR2): the `aside:anchored` row is visible exactly to the
 * creator — in the events fetch, in catch-up, and on the wire — and nowhere
 * else. Emitted in the aside-creation transaction (INV-4), author-scoped like
 * command events, with no broadcast slot (INV-61).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService, StreamEventRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { ConversationRepository } from "../../src/features/conversations"
import { SyncLogRepository } from "../../src/features/sync"
import { resolveDeliveryGroups, userGroup, type OutboxEvent } from "../../src/lib/outbox"
import { userId, workspaceId, messageId, conversationId } from "../../src/lib/id"
import type { AsideAnchoredEventPayload, Stream } from "@threa/types"

describe("Aside anchor event", () => {
  let pool: Pool
  let streamService: StreamService
  let wsId: string
  let creator: string
  let member: string
  let sequence = 1n

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    wsId = workspaceId()
    await withTransaction(pool, async (client) => {
      creator = (await addTestMember(client, wsId, userId())).id
      member = (await addTestMember(client, wsId, userId())).id
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Aside Anchor Test Workspace",
        slug: `aside-anchor-ws-${wsId.toLowerCase()}`,
        createdBy: creator,
      })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function createChannel(slug: string): Promise<Stream> {
    return streamService.createChannel({
      workspaceId: wsId,
      slug,
      visibility: "public",
      createdBy: creator,
      memberIds: [member],
    })
  }

  async function insertMessage(streamId: string, authorId: string): Promise<string> {
    const id = messageId()
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        id,
        streamId,
        sequence: sequence++,
        authorId,
        authorType: "user",
        ...testMessageContent("host message"),
      })
    })
    return id
  }

  async function insertConversation(streamId: string): Promise<string> {
    const id = conversationId()
    await withTransaction(pool, async (client) => {
      await ConversationRepository.insert(client, { id, streamId, workspaceId: wsId })
    })
    return id
  }

  /** The anchor rows one viewer gets back from the host stream's events fetch. */
  async function anchorRowsFor(hostStreamId: string, viewerId: string) {
    const events = await StreamEventRepository.list(pool, hostStreamId, { viewerId })
    return events.filter((event) => event.eventType === "aside:anchored")
  }

  /** The `stream:aside_anchored` outbox row for one aside, as the dispatcher reads it. */
  async function outboxRowFor(asideId: string): Promise<OutboxEvent> {
    const result = await pool.query<{ id: string; event_type: string; payload: Record<string, unknown> }>(
      `SELECT id, event_type, payload FROM outbox
       WHERE event_type = 'stream:aside_anchored' AND payload->'event'->'payload'->>'asideId' = $1`,
      [asideId]
    )
    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    expect(row).toMatchObject({
      event_type: "stream:aside_anchored",
      payload: { event: { eventType: "aside:anchored", payload: { asideId } } },
    })
    return { id: BigInt(row.id), eventType: row.event_type, payload: row.payload, createdAt: new Date() } as OutboxEvent
  }

  /** Logs the event under its resolved groups, exactly as the BroadcastHandler
   *  does, and answers who catch-up hands it back to. */
  async function catchUpReceivers(event: OutboxEvent, groups: string[], users: string[]): Promise<string[]> {
    await SyncLogRepository.appendForWorkspace(pool, wsId, [
      { outboxEventId: event.id, eventType: event.eventType, groups, payload: event.payload },
    ])
    const eventId = (event.payload as { event: { id: string } }).event.id
    const received: string[] = []
    for (const user of users) {
      const entries = await SyncLogRepository.listEntriesForUser(pool, {
        workspaceId: wsId,
        userId: user,
        permissionGroups: [],
        after: 0n,
        limit: 100,
      })
      if (entries.some((e) => (e.payload as { event?: { id?: string } }).event?.id === eventId)) received.push(user)
    }
    return received
  }

  test("the anchor row reaches the creator's fetch and never another member's", async () => {
    const channel = await createChannel("aside-anchor-fetch")
    const anchorId = await insertMessage(channel.id, member)
    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
    })

    const creatorRows = await anchorRowsFor(channel.id, creator)
    expect(creatorRows).toHaveLength(1)
    expect(creatorRows[0]).toMatchObject({
      streamId: channel.id,
      actorId: creator,
      actorType: "user",
      // No broadcast slot: the row is invisible to every other viewer, so a slot
      // would be a permanent hole in their chain (INV-61).
      broadcastSequence: null,
      payload: { asideId: aside.id, anchorId } satisfies AsideAnchoredEventPayload,
    })

    expect(await anchorRowsFor(channel.id, member)).toEqual([])
  })

  test("a message-less aside still gets one anchor row, at creation position", async () => {
    const channel = await createChannel("aside-anchor-composer")
    await insertMessage(channel.id, creator)
    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      createdBy: creator,
    })

    const rows = await anchorRowsFor(channel.id, creator)
    expect(rows.map((row) => row.payload)).toEqual([{ asideId: aside.id, anchorId: null }])
    const all = await StreamEventRepository.list(pool, channel.id, { viewerId: creator })
    expect(all[all.length - 1].id).toBe(rows[0].id)
  })

  test("a conversation-anchored aside stamps the conversation on its row", async () => {
    const channel = await createChannel("aside-anchor-conversation")
    const anchorId = await insertMessage(channel.id, member)
    const convId = await insertConversation(channel.id)
    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      conversationId: convId,
      createdBy: creator,
    })

    const rows = await anchorRowsFor(channel.id, creator)
    expect(rows.map((row) => row.payload)).toEqual([{ asideId: aside.id, anchorId, conversationId: convId }])
  })

  test("a conversation outside the host is rejected; a non-member sees only the host 404", async () => {
    const channel = await createChannel("aside-anchor-conv-host")
    const elsewhere = await streamService.createChannel({
      workspaceId: wsId,
      slug: "aside-anchor-conv-elsewhere",
      visibility: "private",
      createdBy: creator,
    })
    const foreignConversation = await insertConversation(elsewhere.id)
    await expect(
      streamService.createAside({
        workspaceId: wsId,
        parentStreamId: channel.id,
        conversationId: foreignConversation,
        createdBy: creator,
      })
    ).rejects.toMatchObject({ status: 400, code: "ASIDE_CONVERSATION_INVALID" })

    // The host access check runs first: a non-member gets the same 404 whether
    // or not the conversation id is real, so the check is no existence oracle.
    const hostConversation = await insertConversation(elsewhere.id)
    await expect(
      streamService.createAside({
        workspaceId: wsId,
        parentStreamId: elsewhere.id,
        conversationId: hostConversation,
        createdBy: member,
      })
    ).rejects.toMatchObject({ status: 404, code: "STREAM_NOT_FOUND" })
  })

  test("outbox delivery targets the creator alone, in live routing and in catch-up", async () => {
    const channel = await createChannel("aside-anchor-routing")
    const anchorId = await insertMessage(channel.id, member)
    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
    })

    const event = await outboxRowFor(aside.id)
    const groups = resolveDeliveryGroups(event)
    expect(groups).toEqual([userGroup(creator)])
    expect(await catchUpReceivers(event, groups!, [creator, member])).toEqual([creator])
  })

  test("the aside's own conversation never lists on the creator's board", async () => {
    const channel = await createChannel("aside-board-feed")
    const hostMessage = await insertMessage(channel.id, creator)
    const hostConversation = await insertConversation(channel.id)
    const aside = await streamService.createAside({ workspaceId: wsId, parentStreamId: channel.id, createdBy: creator })
    const asideMessage = await insertMessage(aside.id, creator)
    const asideConversation = await insertConversation(aside.id)
    await withTransaction(pool, async (client) => {
      await ConversationRepository.addPrimaryMessage(client, wsId, hostConversation, hostMessage, creator)
      await ConversationRepository.addPrimaryMessage(client, wsId, asideConversation, asideMessage, creator)
    })

    const board = await ConversationRepository.findByWorkspaceForViewer(pool, wsId, creator)
    const listed = new Set(board.map((conversation) => conversation.id))
    expect(listed.has(hostConversation)).toBe(true)
    expect(listed.has(asideConversation)).toBe(false)
  })
})
