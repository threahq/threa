/**
 * Memo-embed summaries on the message payloads.
 *
 * The card renders from the payload and never fetches, so every path that can
 * change which memos a message cites has to put the right set there — and a
 * wrong set is not a cosmetic bug, it is a card describing a different memo
 * than the one it links to.
 *
 * The edit cases are the ones worth the fixture cost: the client applies an
 * edit by SPREADING the payload over the stored one, so `memoEmbeds` has to be
 * present-and-empty rather than omitted, or a removed reference keeps its card.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { MemoRepository } from "../../src/features/memos"
import type { MessageCreatedPayload, MessageEditedPayload } from "../../src/features/messaging"
import { userId, workspaceId, streamId, messageId, memoId } from "../../src/lib/id"
import type { JSONContent } from "@threahq/types"

/** A body citing `memoIds`, as the composer and the markdown parser both build it. */
function bodyCiting(text: string, memoIds: string[]): { contentJson: JSONContent; contentMarkdown: string } {
  return {
    contentJson: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text },
            ...memoIds.map((memoId) => ({ type: "memoEmbed", attrs: { memoId, title: "Cited" } })),
          ],
        },
      ],
    },
    contentMarkdown: `${text}${memoIds.map((id) => ` [Cited](memo:${id})`).join("")}`,
  }
}

describe("memo embed summaries on message payloads", () => {
  let pool: Pool
  let eventService: EventService
  let testWorkspaceId: string
  let testUserId: string
  let channel: string
  let privateElsewhere: string
  let sameStreamMemo: string
  let unreachableMemo: string
  let secondMemo: string
  let sequence = 1n

  async function seedMemo(sourceStreamId: string, title: string): Promise<string> {
    const id = memoId()
    const msgId = messageId()
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        id: msgId,
        streamId: sourceStreamId,
        sequence: sequence++,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("source"),
      })
      await MemoRepository.insert(client, {
        id,
        workspaceId: testWorkspaceId,
        memoType: "message",
        sourceMessageId: msgId,
        title,
        abstract: "abstract",
        keyPoints: [],
        sourceMessageIds: [msgId],
        participantIds: [testUserId],
        knowledgeType: "decision",
        tags: ["settings"],
        status: "active",
      })
    })
    return id
  }

  async function payloadOf(messageIdToFind: string, eventType: string): Promise<Record<string, unknown>> {
    const events = await eventService.listEvents(channel, { limit: 200 })
    const match = events.find(
      (e) => e.eventType === eventType && (e.payload as { messageId?: string }).messageId === messageIdToFind
    )
    if (!match) throw new Error(`no ${eventType} event for ${messageIdToFind}`)
    return match.payload as Record<string, unknown>
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eventService = new EventService(pool)
    testWorkspaceId = workspaceId()
    testUserId = userId()
    channel = streamId()
    privateElsewhere = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Memo Embed Payloads",
        slug: `memo-payloads-${testWorkspaceId}`,
        createdBy: testUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, testUserId)).id
      for (const id of [channel, privateElsewhere]) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: testWorkspaceId,
          type: "channel",
          visibility: "private",
          slug: `s-${id.slice(-8)}`,
          createdBy: testUserId,
        })
      }
    })

    sameStreamMemo = await seedMemo(channel, "Theme switch")
    secondMemo = await seedMemo(channel, "Timezone change")
    unreachableMemo = await seedMemo(privateElsewhere, "Acquisition target")
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a created message carries the summary for a memo the room can read", async () => {
    const message = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: channel,
      authorId: testUserId,
      authorType: "user",
      ...bodyCiting("see this", [sameStreamMemo]),
    })

    const payload = (await payloadOf(message.id, "message_created")) as MessageCreatedPayload
    expect(payload.memoEmbeds).toEqual([
      {
        memoId: sameStreamMemo,
        title: "Theme switch",
        knowledgeType: "decision",
        memoType: "message",
        tags: ["settings"],
        updatedAt: expect.any(String),
        version: expect.any(Number),
      },
    ])
  })

  test("a created message omits a memo the room cannot read", async () => {
    const message = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: channel,
      authorId: testUserId,
      authorType: "user",
      ...bodyCiting("pasted from elsewhere", [unreachableMemo]),
    })

    const payload = (await payloadOf(message.id, "message_created")) as MessageCreatedPayload
    expect(payload.memoEmbeds).toBeUndefined()
  })

  test("summaries follow the order the memos are cited in", async () => {
    const message = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: channel,
      authorId: testUserId,
      authorType: "user",
      ...bodyCiting("both, and one nobody can read", [secondMemo, unreachableMemo, sameStreamMemo]),
    })

    const payload = (await payloadOf(message.id, "message_created")) as MessageCreatedPayload
    expect(payload.memoEmbeds?.map((s) => s.memoId)).toEqual([secondMemo, sameStreamMemo])
  })

  test("an edit that adds a reference carries the new summary", async () => {
    const message = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: channel,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("nothing cited yet"),
    })

    await eventService.editMessageInternal({
      workspaceId: testWorkspaceId,
      messageId: message.id,
      streamId: channel,
      actorId: testUserId,
      ...bodyCiting("now with a memo", [sameStreamMemo]),
    })

    const payload = (await payloadOf(message.id, "message_edited")) as MessageEditedPayload
    expect(payload.memoEmbeds.map((s) => s.memoId)).toEqual([sameStreamMemo])
  })

  // The spread-over-stored-payload trap: omitting the key would leave the card
  // for a memo the body no longer mentions.
  test("an edit that removes every reference carries an empty array, not nothing", async () => {
    const message = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: channel,
      authorId: testUserId,
      authorType: "user",
      ...bodyCiting("cited", [sameStreamMemo]),
    })

    await eventService.editMessageInternal({
      workspaceId: testWorkspaceId,
      messageId: message.id,
      streamId: channel,
      actorId: testUserId,
      ...testMessageContent("no longer cited"),
    })

    const payload = (await payloadOf(message.id, "message_edited")) as MessageEditedPayload
    expect(payload).toHaveProperty("memoEmbeds")
    expect(payload.memoEmbeds).toEqual([])
  })

  describe("bootstrap enrichment", () => {
    // `message_edited` is filtered out of a bootstrap response and the create
    // payload is overlaid with current content, so without a refresh the window
    // would describe the memos the message cited BEFORE the edit.
    test("re-resolves an edited message's summaries against its current body", async () => {
      const message = await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: channel,
        authorId: testUserId,
        authorType: "user",
        ...bodyCiting("first", [sameStreamMemo]),
      })
      await eventService.editMessageInternal({
        workspaceId: testWorkspaceId,
        messageId: message.id,
        streamId: channel,
        actorId: testUserId,
        ...bodyCiting("swapped", [secondMemo]),
      })

      const events = await eventService.listEvents(channel, { limit: 200 })
      const enriched = await eventService.enrichBootstrapEvents(events, new Map(), new Map(), {
        workspaceId: testWorkspaceId,
        streamId: channel,
      })

      const payload = enriched.find(
        (e) => e.eventType === "message_created" && (e.payload as MessageCreatedPayload).messageId === message.id
      )?.payload as MessageCreatedPayload
      expect(payload.memoEmbeds?.map((s) => s.memoId)).toEqual([secondMemo])
    })

    test("clears the summaries when the edit dropped every reference", async () => {
      const message = await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: channel,
        authorId: testUserId,
        authorType: "user",
        ...bodyCiting("cited", [sameStreamMemo]),
      })
      await eventService.editMessageInternal({
        workspaceId: testWorkspaceId,
        messageId: message.id,
        streamId: channel,
        actorId: testUserId,
        ...testMessageContent("dropped"),
      })

      const events = await eventService.listEvents(channel, { limit: 200 })
      const enriched = await eventService.enrichBootstrapEvents(events, new Map(), new Map(), {
        workspaceId: testWorkspaceId,
        streamId: channel,
      })

      const payload = enriched.find(
        (e) => e.eventType === "message_created" && (e.payload as MessageCreatedPayload).messageId === message.id
      )?.payload as MessageCreatedPayload
      expect(payload.memoEmbeds).toEqual([])
    })

    // A message stored before summaries shipped has no memoEmbeds key at all.
    // With the per-card fetch deleted up-stack, its card would render label-only
    // forever — enrichment has to resolve it, not just edited messages.
    test("resolves summaries for a message stored before summaries shipped", async () => {
      const message = await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: channel,
        authorId: testUserId,
        authorType: "user",
        ...bodyCiting("stored before summaries existed", [sameStreamMemo]),
      })
      await pool.query(`UPDATE stream_events SET payload = payload - 'memoEmbeds' WHERE payload->>'messageId' = $1`, [
        message.id,
      ])

      const events = await eventService.listEvents(channel, { limit: 200 })
      const enriched = await eventService.enrichBootstrapEvents(events, new Map(), new Map(), {
        workspaceId: testWorkspaceId,
        streamId: channel,
      })

      const payload = enriched.find(
        (e) => e.eventType === "message_created" && (e.payload as MessageCreatedPayload).messageId === message.id
      )?.payload as MessageCreatedPayload
      expect(payload.memoEmbeds?.map((s) => s.memoId)).toEqual([sameStreamMemo])
    })

    test("leaves a message citing only an unreachable memo without the key", async () => {
      const message = await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: channel,
        authorId: testUserId,
        authorType: "user",
        ...bodyCiting("cites what this room can't read", [unreachableMemo]),
      })

      const events = await eventService.listEvents(channel, { limit: 200 })
      const enriched = await eventService.enrichBootstrapEvents(events, new Map(), new Map(), {
        workspaceId: testWorkspaceId,
        streamId: channel,
      })

      const payload = enriched.find(
        (e) => e.eventType === "message_created" && (e.payload as MessageCreatedPayload).messageId === message.id
      )?.payload as MessageCreatedPayload
      expect(payload.memoEmbeds).toBeUndefined()
    })

    // The stored payload is a snapshot; a retitle that never touched the
    // message must still reach a cold load. This is also what heals a first
    // citation that raced a concurrent memo edit.
    test("re-resolves an unedited message rather than trusting its stored summary", async () => {
      const retitled = await seedMemo(channel, "Before the retitle")
      const message = await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: channel,
        authorId: testUserId,
        authorType: "user",
        ...bodyCiting("untouched", [retitled]),
      })
      await pool.query(`UPDATE memos SET title = 'After the retitle' WHERE id = $1`, [retitled])

      const events = await eventService.listEvents(channel, { limit: 200 })
      const enriched = await eventService.enrichBootstrapEvents(events, new Map(), new Map(), {
        workspaceId: testWorkspaceId,
        streamId: channel,
      })

      const payload = enriched.find(
        (e) => e.eventType === "message_created" && (e.payload as MessageCreatedPayload).messageId === message.id
      )?.payload as MessageCreatedPayload
      expect(payload.memoEmbeds?.map((s) => s.title)).toEqual(["After the retitle"])
    })

    // Serving a stored summary after the memo's source went private is a fresh
    // delivery of withheld content to whoever bootstraps next — the retraction
    // must be an explicit empty array, or the client keeps the stored card.
    test("retracts a stored summary once the memo's source goes private", async () => {
      const publicElsewhere = streamId()
      await withTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: publicElsewhere,
          workspaceId: testWorkspaceId,
          type: "channel",
          visibility: "public",
          slug: `s-${publicElsewhere.slice(-8)}`,
          createdBy: testUserId,
        })
      })
      const memoGoingPrivate = await seedMemo(publicElsewhere, "Public while cited")
      const message = await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: channel,
        authorId: testUserId,
        authorType: "user",
        ...bodyCiting("cited while public", [memoGoingPrivate]),
      })
      const stored = (await payloadOf(message.id, "message_created")) as MessageCreatedPayload
      expect(stored.memoEmbeds?.map((s) => s.memoId)).toEqual([memoGoingPrivate])

      await pool.query(`UPDATE streams SET visibility = 'private' WHERE id = $1`, [publicElsewhere])

      const events = await eventService.listEvents(channel, { limit: 200 })
      const enriched = await eventService.enrichBootstrapEvents(events, new Map(), new Map(), {
        workspaceId: testWorkspaceId,
        streamId: channel,
      })

      const payload = enriched.find(
        (e) => e.eventType === "message_created" && (e.payload as MessageCreatedPayload).messageId === message.id
      )?.payload as MessageCreatedPayload
      expect(payload.memoEmbeds).toEqual([])
    })
  })
})
