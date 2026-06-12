import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { withTransaction } from "./setup"
import { StreamService, StreamEventRepository, StreamMemberRepository } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { streamId, userId, workspaceId } from "../../src/lib/id"
import { setupTestDatabase, testMessageContent } from "./setup"

describe("Unread Counts", () => {
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

  beforeEach(async () => {
    await pool.query("DELETE FROM reactions")
    await pool.query("DELETE FROM messages")
    await pool.query("DELETE FROM stream_events")
    await pool.query("DELETE FROM stream_sequences")
    await pool.query("DELETE FROM stream_members")
    await pool.query("DELETE FROM streams")
    await pool.query(
      "DELETE FROM outbox WHERE id > (SELECT COALESCE(MAX(last_processed_id), 0) FROM outbox_listeners WHERE listener_id = 'broadcast')"
    )
  })

  describe("countUnreadByStreamBatch", () => {
    test("should return 0 unread when lastReadEventId matches latest event", async () => {
      const testStreamId = streamId()
      const testWorkspaceId = workspaceId()
      const testUserId = userId()

      // Create a stream and add a message
      await withTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)`,
          [testStreamId, testWorkspaceId, testUserId]
        )
        await StreamMemberRepository.insert(client, testStreamId, testUserId)
      })

      const message = await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: testStreamId,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("Hello"),
      })

      // Get the event ID for this message
      const events = await StreamEventRepository.list(pool, testStreamId)
      const lastEventId = events[0].id

      // Count unreads with lastReadEventId = latest event
      const counts = await streamService.getUnreadCounts([{ streamId: testStreamId, lastReadEventId: lastEventId }])

      expect(counts.get(testStreamId)).toEqual({ unreadCount: 0, totalCount: 1 })
    })

    test("should return correct unread count when messages exist after lastReadEventId", async () => {
      const testStreamId = streamId()
      const testWorkspaceId = workspaceId()
      const testUserId = userId()

      await withTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)`,
          [testStreamId, testWorkspaceId, testUserId]
        )
        await StreamMemberRepository.insert(client, testStreamId, testUserId)
      })

      // Create 3 messages
      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: testStreamId,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("Message 1"),
      })

      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: testStreamId,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("Message 2"),
      })

      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: testStreamId,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("Message 3"),
      })

      // Get the first event as last read
      const events = await StreamEventRepository.list(pool, testStreamId)
      const firstEventId = events[0].id

      // Should have 2 unread (messages 2 and 3)
      const counts = await streamService.getUnreadCounts([{ streamId: testStreamId, lastReadEventId: firstEventId }])

      expect(counts.get(testStreamId)).toEqual({ unreadCount: 2, totalCount: 3 })
    })

    test("should return all messages as unread when lastReadEventId is null", async () => {
      const testStreamId = streamId()
      const testWorkspaceId = workspaceId()
      const testUserId = userId()

      await withTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)`,
          [testStreamId, testWorkspaceId, testUserId]
        )
        await StreamMemberRepository.insert(client, testStreamId, testUserId)
      })

      // Create 3 messages
      for (let i = 1; i <= 3; i++) {
        await eventService.createMessage({
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent(`Message ${i}`),
        })
      }

      // Count with null lastReadEventId (never read)
      const counts = await streamService.getUnreadCounts([{ streamId: testStreamId, lastReadEventId: null }])

      expect(counts.get(testStreamId)).toEqual({ unreadCount: 3, totalCount: 3 })
    })

    test("should not count user's own message as unread", async () => {
      const testStreamId = streamId()
      const testWorkspaceId = workspaceId()
      const authorId = userId()
      const otherUserId = userId()

      // Create a stream with two members
      await withTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'channel', 'private', $3)`,
          [testStreamId, testWorkspaceId, authorId]
        )
        await StreamMemberRepository.insert(client, testStreamId, authorId)
        await StreamMemberRepository.insert(client, testStreamId, otherUserId)
      })

      // Author sends a message
      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: testStreamId,
        authorId: authorId,
        authorType: "user",
        ...testMessageContent("Hello from author"),
      })

      // Author's lastReadEventId should have been updated to include their own message
      const authorMembership = await streamService.getMembership(testStreamId, authorId)
      expect(authorMembership?.lastReadEventId).not.toBeNull()

      // Author should have 0 unread
      const authorCounts = await streamService.getUnreadCounts([
        { streamId: testStreamId, lastReadEventId: authorMembership!.lastReadEventId },
      ])
      expect(authorCounts.get(testStreamId)).toEqual({ unreadCount: 0, totalCount: 1 })

      // Other user should have 1 unread (their lastReadEventId is still null)
      const otherMembership = await streamService.getMembership(testStreamId, otherUserId)
      expect(otherMembership?.lastReadEventId).toBeNull()

      const otherCounts = await streamService.getUnreadCounts([
        { streamId: testStreamId, lastReadEventId: otherMembership!.lastReadEventId },
      ])
      expect(otherCounts.get(testStreamId)).toEqual({ unreadCount: 1, totalCount: 1 })
    })

    test("should handle multiple streams in batch", async () => {
      const stream1 = streamId()
      const stream2 = streamId()
      const testWorkspaceId = workspaceId()
      const testUserId = userId()

      await withTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)`,
          [stream1, testWorkspaceId, testUserId]
        )
        await client.query(
          `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)`,
          [stream2, testWorkspaceId, testUserId]
        )
        await StreamMemberRepository.insert(client, stream1, testUserId)
        await StreamMemberRepository.insert(client, stream2, testUserId)
      })

      // Stream 1: 2 messages
      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: stream1,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("Stream 1 - Message 1"),
      })
      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: stream1,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("Stream 1 - Message 2"),
      })

      // Stream 2: 3 messages
      for (let i = 1; i <= 3; i++) {
        await eventService.createMessage({
          workspaceId: testWorkspaceId,
          streamId: stream2,
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent(`Stream 2 - Message ${i}`),
        })
      }

      // Get first event from stream1, read all of stream2
      const events1 = await StreamEventRepository.list(pool, stream1)
      const events2 = await StreamEventRepository.list(pool, stream2)

      const counts = await streamService.getUnreadCounts([
        { streamId: stream1, lastReadEventId: events1[0].id }, // Read 1, unread 1
        { streamId: stream2, lastReadEventId: events2[2].id }, // Read all 3, unread 0
      ])

      expect(counts.get(stream1)).toEqual({ unreadCount: 1, totalCount: 2 })
      expect(counts.get(stream2)).toEqual({ unreadCount: 0, totalCount: 3 })
    })
  })

  describe("markAllAsRead", () => {
    test("should update all stream memberships to latest event", async () => {
      const stream1 = streamId()
      const stream2 = streamId()
      const testWorkspaceId = workspaceId()
      const testUserId = userId()
      const otherUserId = userId()

      await withTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)`,
          [stream1, testWorkspaceId, testUserId]
        )
        await client.query(
          `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)`,
          [stream2, testWorkspaceId, testUserId]
        )
        await StreamMemberRepository.insert(client, stream1, testUserId)
        await StreamMemberRepository.insert(client, stream2, testUserId)
        await StreamMemberRepository.insert(client, stream1, otherUserId)
        await StreamMemberRepository.insert(client, stream2, otherUserId)
      })

      // Add messages from another user so testUserId has unread messages
      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: stream1,
        authorId: otherUserId,
        authorType: "user",
        ...testMessageContent("Stream 1 message"),
      })
      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: stream2,
        authorId: otherUserId,
        authorType: "user",
        ...testMessageContent("Stream 2 message"),
      })

      // Mark all as read
      const updatedStreamIds = await streamService.markAllAsRead(testWorkspaceId, testUserId)

      expect(updatedStreamIds).toHaveLength(2)
      expect(updatedStreamIds).toContain(stream1)
      expect(updatedStreamIds).toContain(stream2)

      // Verify memberships are updated
      const membership1 = await streamService.getMembership(stream1, testUserId)
      const membership2 = await streamService.getMembership(stream2, testUserId)

      expect(membership1?.lastReadEventId).not.toBeNull()
      expect(membership2?.lastReadEventId).not.toBeNull()

      // Verify unread counts are now 0
      const counts = await streamService.getUnreadCounts([
        { streamId: stream1, lastReadEventId: membership1!.lastReadEventId },
        { streamId: stream2, lastReadEventId: membership2!.lastReadEventId },
      ])

      expect(counts.get(stream1)).toEqual({ unreadCount: 0, totalCount: 1 })
      expect(counts.get(stream2)).toEqual({ unreadCount: 0, totalCount: 1 })
    })

    test("should only update streams that have unread messages", async () => {
      const stream1 = streamId()
      const stream2 = streamId()
      const testWorkspaceId = workspaceId()
      const testUserId = userId()

      await withTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)`,
          [stream1, testWorkspaceId, testUserId]
        )
        await client.query(
          `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)`,
          [stream2, testWorkspaceId, testUserId]
        )
        await StreamMemberRepository.insert(client, stream1, testUserId)
        await StreamMemberRepository.insert(client, stream2, testUserId)
      })

      // Add message to stream1 only
      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: stream1,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("Stream 1 message"),
      })

      // Mark stream1 as read first
      const events1 = await StreamEventRepository.list(pool, stream1)
      await streamService.markAsRead(testWorkspaceId, stream1, testUserId, events1[0].id)

      // Now markAllAsRead should return empty (both are already read or have no messages)
      const updatedStreamIds = await streamService.markAllAsRead(testWorkspaceId, testUserId)

      expect(updatedStreamIds).toHaveLength(0)
    })

    test("should only affect streams in the specified workspace", async () => {
      const stream1 = streamId()
      const stream2 = streamId()
      const workspace1 = workspaceId()
      const workspace2 = workspaceId()
      const testUserId = userId()
      const otherUserId = userId()

      await withTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)`,
          [stream1, workspace1, testUserId]
        )
        await client.query(
          `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)`,
          [stream2, workspace2, testUserId]
        )
        await StreamMemberRepository.insert(client, stream1, testUserId)
        await StreamMemberRepository.insert(client, stream2, testUserId)
        await StreamMemberRepository.insert(client, stream1, otherUserId)
        await StreamMemberRepository.insert(client, stream2, otherUserId)
      })

      // Add messages from another user so testUserId has unread messages
      await eventService.createMessage({
        workspaceId: workspace1,
        streamId: stream1,
        authorId: otherUserId,
        authorType: "user",
        ...testMessageContent("Workspace 1 message"),
      })
      await eventService.createMessage({
        workspaceId: workspace2,
        streamId: stream2,
        authorId: otherUserId,
        authorType: "user",
        ...testMessageContent("Workspace 2 message"),
      })

      // Mark all as read in workspace1 only
      const updatedStreamIds = await streamService.markAllAsRead(workspace1, testUserId)

      expect(updatedStreamIds).toHaveLength(1)
      expect(updatedStreamIds).toContain(stream1)
      expect(updatedStreamIds).not.toContain(stream2)

      // Stream2 should still have unread (otherUserId sent a message that testUserId hasn't read)
      const membership2 = await streamService.getMembership(stream2, testUserId)
      expect(membership2?.lastReadEventId).toBeNull()
    })
  })

  describe("batchUpdateLastReadEventId", () => {
    test("should update multiple memberships in a single query", async () => {
      const stream1 = streamId()
      const stream2 = streamId()
      const stream3 = streamId()
      const testWorkspaceId = workspaceId()
      const testUserId = userId()

      await withTransaction(pool, async (client) => {
        for (const id of [stream1, stream2, stream3]) {
          await client.query(
            `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)`,
            [id, testWorkspaceId, testUserId]
          )
          await StreamMemberRepository.insert(client, id, testUserId)
        }
      })

      // Add messages
      const eventIds: string[] = []
      for (const streamId of [stream1, stream2, stream3]) {
        await eventService.createMessage({
          workspaceId: testWorkspaceId,
          streamId,
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent("Test message"),
        })
        const events = await StreamEventRepository.list(pool, streamId)
        eventIds.push(events[0].id)
      }

      // Batch update
      const updates = new Map<string, string>([
        [stream1, eventIds[0]],
        [stream2, eventIds[1]],
        [stream3, eventIds[2]],
      ])

      await withTransaction(pool, async (client) => {
        await StreamMemberRepository.batchUpdateLastReadEventId(client, testUserId, updates)
      })

      // Verify all were updated
      const m1 = await streamService.getMembership(stream1, testUserId)
      const m2 = await streamService.getMembership(stream2, testUserId)
      const m3 = await streamService.getMembership(stream3, testUserId)

      expect(m1?.lastReadEventId).toBe(eventIds[0])
      expect(m2?.lastReadEventId).toBe(eventIds[1])
      expect(m3?.lastReadEventId).toBe(eventIds[2])
    })
  })

  // Sync-v2 phase 2c: the unread counter events carry absolute values so
  // replayed/duplicated sync-log entries converge instead of compounding.
  // Clients derive unread = latestOrdinal - lastReadOrdinal; these tests pin
  // the ordinal payloads end-to-end through the real write paths.
  describe("absolute counter payloads", () => {
    async function setupStreamWithMembers(): Promise<{
      testStreamId: string
      testWorkspaceId: string
      authorId: string
      readerId: string
    }> {
      const testStreamId = streamId()
      const testWorkspaceId = workspaceId()
      const authorId = userId()
      const readerId = userId()

      await withTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'channel', 'private', $3)`,
          [testStreamId, testWorkspaceId, authorId]
        )
        await StreamMemberRepository.insert(client, testStreamId, authorId)
        await StreamMemberRepository.insert(client, testStreamId, readerId)
      })

      return { testStreamId, testWorkspaceId, authorId, readerId }
    }

    async function listOutboxPayloads(eventType: string, streamIdValue: string): Promise<Array<Record<string, any>>> {
      const result = await pool.query(
        `SELECT payload FROM outbox WHERE event_type = $1 AND payload->>'streamId' = $2 ORDER BY id`,
        [eventType, streamIdValue]
      )
      return result.rows.map((row) => row.payload)
    }

    test("stream:activity carries the message's sequence and ordinal", async () => {
      const { testStreamId, testWorkspaceId, authorId } = await setupStreamWithMembers()

      for (let i = 1; i <= 3; i++) {
        await eventService.createMessage({
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          authorId,
          authorType: "user",
          ...testMessageContent(`Message ${i}`),
        })
      }

      const payloads = await listOutboxPayloads("stream:activity", testStreamId)
      expect(payloads).toHaveLength(3)
      expect(payloads.map((p) => p.messageOrdinal)).toEqual([1, 2, 3])

      // Sequences are the events' per-stream sequences, in order.
      const events = await StreamEventRepository.list(pool, testStreamId)
      expect(payloads.map((p) => p.sequence)).toEqual(events.map((e) => e.sequence.toString()))
    })

    test("stream:read carries the read position in message-ordinal space", async () => {
      const { testStreamId, testWorkspaceId, authorId, readerId } = await setupStreamWithMembers()

      for (let i = 1; i <= 3; i++) {
        await eventService.createMessage({
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          authorId,
          authorType: "user",
          ...testMessageContent(`Message ${i}`),
        })
      }

      // Read up to the second message: ordinal 2 of 3.
      const events = await StreamEventRepository.list(pool, testStreamId)
      await streamService.markAsRead(testWorkspaceId, testStreamId, readerId, events[1].id)

      const payloads = await listOutboxPayloads("stream:read", testStreamId)
      expect(payloads).toHaveLength(1)
      expect(payloads[0]).toEqual({
        workspaceId: testWorkspaceId,
        authorId: readerId,
        streamId: testStreamId,
        lastReadEventId: events[1].id,
        lastReadSequence: events[1].sequence.toString(),
        lastReadOrdinal: 2,
      })

      // The derived unread matches the authoritative count: 3 - 2 = 1.
      const counts = await streamService.getUnreadCounts([{ streamId: testStreamId, lastReadEventId: events[1].id }])
      expect(counts.get(testStreamId)).toEqual({ unreadCount: 1, totalCount: 3 })
    })

    test("stream:read_all carries per-stream absolute read positions", async () => {
      const { testStreamId, testWorkspaceId, authorId, readerId } = await setupStreamWithMembers()

      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: testStreamId,
        authorId,
        authorType: "user",
        ...testMessageContent("Only message"),
      })

      await streamService.markAllAsRead(testWorkspaceId, readerId)

      const result = await pool.query(
        `SELECT payload FROM outbox WHERE event_type = 'stream:read_all' AND payload->>'authorId' = $1 ORDER BY id`,
        [readerId]
      )
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].payload).toEqual({
        workspaceId: testWorkspaceId,
        authorId: readerId,
        streamIds: [testStreamId],
        reads: [{ streamId: testStreamId, lastReadOrdinal: 1 }],
      })
    })

    test("getMessageOrdinalForEvent counts only messages at or below the event's sequence", async () => {
      const { testStreamId, testWorkspaceId, authorId } = await setupStreamWithMembers()

      for (let i = 1; i <= 2; i++) {
        await eventService.createMessage({
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          authorId,
          authorType: "user",
          ...testMessageContent(`Message ${i}`),
        })
      }

      const events = await StreamEventRepository.list(pool, testStreamId)
      const first = await StreamEventRepository.getMessageOrdinalForEvent(pool, testStreamId, events[0].id)
      expect(first).toEqual({ sequence: events[0].sequence, messageOrdinal: 1 })

      expect(await StreamEventRepository.getMessageOrdinalForEvent(pool, testStreamId, "evt_missing")).toBeNull()
      expect(await StreamEventRepository.countMessagesThrough(pool, testStreamId, events[1].sequence)).toBe(2)
    })
  })
})
