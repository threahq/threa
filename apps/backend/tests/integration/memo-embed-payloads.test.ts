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
import type { JSONContent } from "@threa/types"

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

    await eventService.editMessage({
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

    await eventService.editMessage({
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
      await eventService.editMessage({
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
      await eventService.editMessage({
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

    test("leaves an unedited message's create-time summaries alone", async () => {
      const message = await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: channel,
        authorId: testUserId,
        authorType: "user",
        ...bodyCiting("untouched", [sameStreamMemo]),
      })

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
  })
})
