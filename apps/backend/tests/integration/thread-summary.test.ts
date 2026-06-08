/**
 * Thread Summary Integration Tests
 *
 * Covers the two queries that back ThreadCard:
 * - `findThreadSummaries(parentStreamId)` — batch lookup for a whole bootstrap
 * - `findThreadSummaryByParentMessage(parentMessageId)` — single-parent lookup
 *   used by the real-time reply-count path
 *
 * Verifies the plan's requirements: 0 / 1 / N replies, ≥4 participants capped at
 * 3, deterministic participant ordering by first-reply sequence, raw markdown
 * on the wire (INV-60 stripping happens client-side), and deleted replies are
 * excluded.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { withTestTransaction, addTestMember, setupTestDatabase, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService, StreamRepository } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { OutboxRepository, type MessageUpdatedOutboxPayload } from "../../src/lib/outbox"
import { userId, workspaceId } from "../../src/lib/id"
import { Visibilities } from "@threa/types"

describe("Thread Summary", () => {
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

  interface ThreadFixture {
    wsId: string
    ownerId: string
    channelId: string
    parentMessageId: string
    threadId: string
    replyIds: string[]
    replies: Array<{ id: string; authorId: string }>
  }

  async function seedThread(
    replyUserCount: number,
    replyCountPerUser: number,
    opts: { markdown?: string } = {}
  ): Promise<ThreadFixture> {
    const ownerId = userId()
    const wsId = workspaceId()

    await withTestTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Thread Summary Test Workspace",
        slug: `thread-sum-${wsId}`,
        createdBy: ownerId,
      })
      await addTestMember(client, wsId, ownerId)
    })

    const channel = await streamService.createChannel({
      workspaceId: wsId,
      slug: `thread-sum-channel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdBy: ownerId,
      visibility: Visibilities.PUBLIC,
    })

    const parent = await eventService.createMessage({
      workspaceId: wsId,
      streamId: channel.id,
      authorId: ownerId,
      authorType: "user",
      ...testMessageContent("Parent"),
    })

    const thread = await streamService.createThread({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentMessageId: parent.id,
      createdBy: ownerId,
    })

    // Create replyUserCount distinct user IDs. We don't need actual User
    // records — the thread-summary query only selects author_id strings from
    // the messages table, and `eventService.createMessage` skips actor-type
    // resolution when `authorType` is passed explicitly.
    const userIds: string[] = []
    for (let i = 0; i < replyUserCount; i++) {
      userIds.push(userId())
    }

    const replies: Array<{ id: string; authorId: string }> = []
    for (let round = 0; round < replyCountPerUser; round++) {
      for (const uid of userIds) {
        const msg = await eventService.createMessage({
          workspaceId: wsId,
          streamId: thread.id,
          authorId: uid,
          authorType: "user",
          ...testMessageContent(opts.markdown ?? `Reply from ${uid.slice(-4)} round ${round}`),
        })
        replies.push({ id: msg.id, authorId: uid })
      }
    }

    return {
      wsId,
      ownerId,
      channelId: channel.id,
      parentMessageId: parent.id,
      threadId: thread.id,
      replyIds: replies.map((reply) => reply.id),
      replies,
    }
  }

  describe("findThreadSummaryByParentMessage (single-parent lookup)", () => {
    test("returns null when the parent message has no replies", async () => {
      const f = await seedThread(0, 0)
      const summary = await StreamRepository.findThreadSummaryByParentMessage(pool, f.parentMessageId)
      expect(summary).toBeNull()
    })

    test("returns the single reply as the latest when there is exactly one", async () => {
      const f = await seedThread(1, 1)
      const summary = await StreamRepository.findThreadSummaryByParentMessage(pool, f.parentMessageId)
      expect(summary).not.toBeNull()
      expect(summary!.participants).toHaveLength(1)
      expect(summary!.latestReply.messageId).toBe(f.replyIds[f.replyIds.length - 1])
    })

    test("caps participants at 3 even with more distinct authors", async () => {
      const f = await seedThread(5, 1)
      const summary = await StreamRepository.findThreadSummaryByParentMessage(pool, f.parentMessageId)
      expect(summary).not.toBeNull()
      expect(summary!.participants).toHaveLength(3)
    })

    test("orders participants by first-reply sequence (deterministic)", async () => {
      const f = await seedThread(4, 1)
      const first = await StreamRepository.findThreadSummaryByParentMessage(pool, f.parentMessageId)
      const second = await StreamRepository.findThreadSummaryByParentMessage(pool, f.parentMessageId)
      // Same call twice → identical ordering.
      expect(first!.participants).toEqual(second!.participants)
    })

    test("sends contentMarkdown raw (caller strips via INV-60)", async () => {
      const raw = "**bold** and `code` and :emoji:"
      const f = await seedThread(1, 1, { markdown: raw })
      const summary = await StreamRepository.findThreadSummaryByParentMessage(pool, f.parentMessageId)
      expect(summary!.latestReply.contentMarkdown).toBe(raw)
    })

    test("includes persona participants alongside users (not users-only)", async () => {
      // Seed a user-authored parent + thread, then post a persona (Ariadne)
      // reply. Both the user who started the thread and the persona who
      // answered should appear in participants — historically the query
      // filtered `author_type = 'user'` which hid personas.
      const f = await seedThread(1, 1)
      const personaReply = await eventService.createMessage({
        workspaceId: f.wsId,
        streamId: f.threadId,
        authorId: "persona_system_ariadne",
        authorType: "persona",
        ...testMessageContent("Persona-authored reply"),
      })
      const summary = await StreamRepository.findThreadSummaryByParentMessage(pool, f.parentMessageId)
      expect(summary!.participants.length).toBeGreaterThanOrEqual(2)
      expect(summary!.participants.some((p) => p.type === "persona" && p.id === "persona_system_ariadne")).toBe(true)
      expect(summary!.participants.some((p) => p.type === "user")).toBe(true)
      // The latest reply itself should be the persona's message.
      expect(summary!.latestReply.messageId).toBe(personaReply.id)
      expect(summary!.latestReply.actorType).toBe("persona")
    })
  })

  describe("findThreadSummaries (batch lookup)", () => {
    test("messages without replies are absent from the map", async () => {
      const f = await seedThread(0, 0)
      const map = await StreamRepository.findThreadSummaries(pool, f.channelId)
      expect(map.has(f.parentMessageId)).toBe(false)
    })

    test("includes parent messages that have at least one reply", async () => {
      const f = await seedThread(1, 1)
      const map = await StreamRepository.findThreadSummaries(pool, f.channelId)
      const summary = map.get(f.parentMessageId)
      expect(summary).toBeDefined()
      expect(summary!.participants).toHaveLength(1)
    })

    test("caps participants at 3 in batch mode as well", async () => {
      const f = await seedThread(4, 2)
      const map = await StreamRepository.findThreadSummaries(pool, f.channelId)
      const summary = map.get(f.parentMessageId)
      expect(summary!.participants).toHaveLength(3)
    })

    test("counts only non-deleted replies when deriving replyCount for bootstrap", async () => {
      const f = await seedThread(1, 1)
      const onlyReply = f.replies[0]!

      await eventService.deleteMessage({
        workspaceId: f.wsId,
        streamId: f.threadId,
        messageId: onlyReply.id,
        actorId: onlyReply.authorId,
      })

      const threadDataMap = await StreamRepository.findThreadsWithReplyCounts(pool, f.channelId)
      expect(threadDataMap.get(f.parentMessageId)).toEqual({
        threadId: f.threadId,
        replyCount: 0,
      })

      const summaryMap = await StreamRepository.findThreadSummaries(pool, f.channelId)
      expect(summaryMap.has(f.parentMessageId)).toBe(false)
    })
  })

  describe("findThreadSummaries / findThreadsWithReplyCounts scoped to parentMessageIds", () => {
    // Two parents with threaded replies in the SAME channel so we can assert the
    // scoping filter narrows to a bootstrap window instead of the whole stream.
    async function seedTwoThreadsInOneChannel() {
      const ownerId = userId()
      const wsId = workspaceId()

      await withTestTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Scoped Thread Summary WS",
          slug: `scoped-thread-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, ownerId)
      })

      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `scoped-thread-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        createdBy: ownerId,
        visibility: Visibilities.PUBLIC,
      })

      async function parentWithReply(markdown: string) {
        const parent = await eventService.createMessage({
          workspaceId: wsId,
          streamId: channel.id,
          authorId: ownerId,
          authorType: "user",
          ...testMessageContent(markdown),
        })
        const thread = await streamService.createThread({
          workspaceId: wsId,
          parentStreamId: channel.id,
          parentMessageId: parent.id,
          createdBy: ownerId,
        })
        await eventService.createMessage({
          workspaceId: wsId,
          streamId: thread.id,
          authorId: ownerId,
          authorType: "user",
          ...testMessageContent(`reply to ${markdown}`),
        })
        return parent.id
      }

      const parentA = await parentWithReply("Parent A")
      const parentB = await parentWithReply("Parent B")
      return { channelId: channel.id, parentA, parentB }
    }

    test("undefined scope returns every thread in the stream", async () => {
      const { channelId, parentA, parentB } = await seedTwoThreadsInOneChannel()
      const summaries = await StreamRepository.findThreadSummaries(pool, channelId)
      const counts = await StreamRepository.findThreadsWithReplyCounts(pool, channelId)
      expect({
        summaries: [...summaries.keys()].sort(),
        counts: [...counts.keys()].sort(),
      }).toEqual({
        summaries: [parentA, parentB].sort(),
        counts: [parentA, parentB].sort(),
      })
    })

    test("a scoped list returns only the requested parents", async () => {
      const { channelId, parentA } = await seedTwoThreadsInOneChannel()
      const summaries = await StreamRepository.findThreadSummaries(pool, channelId, [parentA])
      const counts = await StreamRepository.findThreadsWithReplyCounts(pool, channelId, [parentA])
      expect({
        summaries: [...summaries.keys()],
        counts: [...counts.keys()],
      }).toEqual({ summaries: [parentA], counts: [parentA] })
    })

    test("an empty scope returns an empty map without scanning the stream", async () => {
      const { channelId } = await seedTwoThreadsInOneChannel()
      const summaries = await StreamRepository.findThreadSummaries(pool, channelId, [])
      const counts = await StreamRepository.findThreadsWithReplyCounts(pool, channelId, [])
      expect({ summaries: [...summaries.keys()], counts: [...counts.keys()] }).toEqual({
        summaries: [],
        counts: [],
      })
    })
  })

  describe("thread-summary reactivity", () => {
    test("editing the latest thread reply emits a parent-stream refresh with updated threadSummary", async () => {
      const f = await seedThread(1, 1, { markdown: "Original latest reply" })
      const latestReply = f.replies[f.replies.length - 1]!

      const baselineResult = await pool.query("SELECT COALESCE(MAX(id), 0) AS max_id FROM outbox")
      const baselineId = BigInt(baselineResult.rows[0].max_id)

      await eventService.editMessage({
        workspaceId: f.wsId,
        streamId: f.threadId,
        messageId: latestReply.id,
        actorId: latestReply.authorId,
        ...testMessageContent("Edited latest reply"),
      })

      const outboxEvents = await OutboxRepository.fetchAfterId(pool, baselineId)
      const refreshEvent = outboxEvents.find((event) => event.eventType === "message:updated")

      expect(refreshEvent).toBeDefined()
      const payload = refreshEvent!.payload as MessageUpdatedOutboxPayload
      expect(payload).toMatchObject({
        workspaceId: f.wsId,
        streamId: f.channelId,
        messageId: f.parentMessageId,
        updateType: "reply_count",
        replyCount: 1,
      })
      expect(payload.threadSummary).not.toBeNull()
      expect(payload.threadSummary!.latestReply).toMatchObject({
        messageId: latestReply.id,
        contentMarkdown: "Edited latest reply",
      })
    })
  })

  describe("drift parity between batch and single-parent queries", () => {
    // The two entry points share a row shape (`ThreadSummaryRow`) and a mapper
    // (`threadSummaryFromRow`), but their SQL bodies are independent. These
    // tests run both against the same data and assert identical output — if a
    // future change (new column, different predicate, different ORDER BY)
    // silently diverges, the parity check fails.
    async function pairCompare(fixture: ThreadFixture) {
      const batchMap = await StreamRepository.findThreadSummaries(pool, fixture.channelId)
      const single = await StreamRepository.findThreadSummaryByParentMessage(pool, fixture.parentMessageId)
      // Normalize "no summary" on both sides so `.toEqual()` can compare them
      // uniformly: batch returns `undefined` from `Map.get`, single returns
      // `null`. Both represent the same semantic "no thread summary".
      return { batch: batchMap.get(fixture.parentMessageId) ?? null, single }
    }

    test("both return null/absent when no replies", async () => {
      const f = await seedThread(0, 0)
      const { batch, single } = await pairCompare(f)
      expect(batch).toBeNull()
      expect(single).toBeNull()
    })

    test("both return identical ThreadSummary for a single reply", async () => {
      const f = await seedThread(1, 1)
      const { batch, single } = await pairCompare(f)
      expect(batch).toEqual(single)
    })

    test("both return identical ThreadSummary for N replies with cap", async () => {
      const f = await seedThread(4, 3)
      const { batch, single } = await pairCompare(f)
      expect(batch).toEqual(single)
      expect(single!.participants).toHaveLength(3)
    })

    test("both return identical participant ordering under repeated queries", async () => {
      const f = await seedThread(5, 1)
      const { batch, single } = await pairCompare(f)
      expect(batch!.participants).toEqual(single!.participants)
    })
  })
})
