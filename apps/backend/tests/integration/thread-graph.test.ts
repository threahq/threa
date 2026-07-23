/**
 * Thread Graph Integration Tests
 *
 * Tests verify:
 * 1. Thread creation from channels sets correct parent and root
 * 2. Nested threads inherit the correct root stream ID
 * 3. Thread listing by parent stream
 * 4. Deep nesting maintains correct ancestry
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { withTestTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService, StreamEventRepository, StreamRepository } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { setupTestDatabase, testMessageContent } from "./setup"
import { userId, workspaceId, messageId, eventId, streamId } from "../../src/lib/id"
import { StreamTypes, Visibilities } from "@threa/types"

describe("Thread Graph", () => {
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

  describe("Thread Creation", () => {
    test("thread from channel has channel as parent and root", async () => {
      const ownerId = userId()
      const wsId = workspaceId()

      await withTestTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Thread Test Workspace",
          slug: `thread-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, ownerId)
      })

      // Create a channel
      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `thread-channel-${Date.now()}`,
        createdBy: ownerId,
        visibility: Visibilities.PUBLIC,
      })

      // Create a message in the channel
      const parentMessage = await eventService.createMessage({
        workspaceId: wsId,
        streamId: channel.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Parent message for thread test"),
      })

      // Create a thread from the channel
      const thread = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: parentMessage.id,
        createdBy: ownerId,
      })

      expect(thread.type).toBe(StreamTypes.THREAD)
      expect(thread.parentStreamId).toBe(channel.id)
      expect(thread.parentMessageId).toBe(parentMessage.id)
      expect(thread.rootStreamId).toBe(channel.id)
      expect(thread.visibility).toBe(Visibilities.PUBLIC)
    })

    test("nested thread inherits root from parent thread", async () => {
      const ownerId = userId()
      const wsId = workspaceId()

      await withTestTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Nested Thread Workspace",
          slug: `nested-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, ownerId)
      })

      // Create channel -> thread1 -> thread2
      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `nested-channel-${Date.now()}`,
        createdBy: ownerId,
        visibility: Visibilities.PUBLIC,
      })

      const msg1 = await eventService.createMessage({
        workspaceId: wsId,
        streamId: channel.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Message 1"),
      })

      const thread1 = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: msg1.id,
        createdBy: ownerId,
      })

      const msg2 = await eventService.createMessage({
        workspaceId: wsId,
        streamId: thread1.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Message 2"),
      })

      const thread2 = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: thread1.id,
        parentAnchorId: msg2.id,
        createdBy: ownerId,
      })

      // thread1's root is channel
      expect(thread1.rootStreamId).toBe(channel.id)

      // thread2's parent is thread1, but root is still channel
      expect(thread2.parentStreamId).toBe(thread1.id)
      expect(thread2.rootStreamId).toBe(channel.id)
    })

    test("deeply nested threads maintain correct root", async () => {
      const ownerId = userId()
      const wsId = workspaceId()

      await withTestTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Deep Thread Workspace",
          slug: `deep-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, ownerId)
      })

      // Create channel -> t1 -> t2 -> t3 -> t4
      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `deep-channel-${Date.now()}`,
        createdBy: ownerId,
        visibility: Visibilities.PUBLIC,
      })

      let parentStream = channel
      const threads = []
      for (let i = 0; i < 4; i++) {
        // Create a message in the current parent stream
        const msg = await eventService.createMessage({
          workspaceId: wsId,
          streamId: parentStream.id,
          authorId: ownerId,
          authorType: "user",
          ...testMessageContent(`Deep message ${i + 1}`),
        })

        const thread = await streamService.createThread({
          workspaceId: wsId,
          parentStreamId: parentStream.id,
          parentAnchorId: msg.id,
          createdBy: ownerId,
        })
        threads.push(thread)
        parentStream = thread
      }

      // All threads should have channel as root
      for (const thread of threads) {
        expect(thread.rootStreamId).toBe(channel.id)
      }

      // Each thread's parent should be the previous one
      expect(threads[0].parentStreamId).toBe(channel.id)
      expect(threads[1].parentStreamId).toBe(threads[0].id)
      expect(threads[2].parentStreamId).toBe(threads[1].id)
      expect(threads[3].parentStreamId).toBe(threads[2].id)
    })
  })

  describe("Thread from Scratchpad", () => {
    test("thread from scratchpad has scratchpad as parent and root", async () => {
      const ownerId = userId()
      const wsId = workspaceId()

      await withTestTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Scratchpad Thread Workspace",
          slug: `scratch-thread-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, ownerId)
      })

      // Create a scratchpad
      const scratchpad = await streamService.createScratchpad({
        workspaceId: wsId,
        createdBy: ownerId,
      })

      // Create a message in the scratchpad
      const parentMessage = await eventService.createMessage({
        workspaceId: wsId,
        streamId: scratchpad.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Scratchpad message for thread"),
      })

      // Create a thread from the scratchpad
      const thread = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: scratchpad.id,
        parentAnchorId: parentMessage.id,
        createdBy: ownerId,
      })

      expect(thread.parentStreamId).toBe(scratchpad.id)
      expect(thread.rootStreamId).toBe(scratchpad.id)
    })
  })

  describe("Thread Membership", () => {
    test("thread creator is automatically added as member", async () => {
      const ownerId = userId()
      const wsId = workspaceId()

      await withTestTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Thread Member Workspace",
          slug: `thread-member-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, ownerId)
      })

      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `member-channel-${Date.now()}`,
        createdBy: ownerId,
        visibility: Visibilities.PUBLIC,
      })

      const parentMessage = await eventService.createMessage({
        workspaceId: wsId,
        streamId: channel.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Message for thread membership test"),
      })

      const thread = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: parentMessage.id,
        createdBy: ownerId,
      })

      // Creator should be a member
      const isMember = await streamService.isMember(thread.id, ownerId)
      expect(isMember).toBe(true)
    })
  })

  describe("Invalid Thread Creation", () => {
    test("creating thread with non-existent parent fails", async () => {
      const ownerId = userId()
      const wsId = workspaceId()

      await withTestTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Invalid Thread Workspace",
          slug: `invalid-thread-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, ownerId)
      })

      await expect(
        streamService.createThread({
          workspaceId: wsId,
          parentStreamId: "stream_nonexistent",
          parentAnchorId: "msg_nonexistent",
          createdBy: ownerId,
        })
      ).rejects.toThrow("Stream not found")
    })
  })

  describe("Thread Idempotency", () => {
    test("creating thread for same parent message returns existing thread", async () => {
      const ownerId = userId()
      const wsId = workspaceId()

      await withTestTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Idempotency Test Workspace",
          slug: `idem-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, ownerId)
      })

      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `idem-channel-${Date.now()}`,
        createdBy: ownerId,
        visibility: Visibilities.PUBLIC,
      })

      // Create actual message to thread from
      const parentMessage = await eventService.createMessage({
        workspaceId: wsId,
        streamId: channel.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Parent message for idempotency test"),
      })

      // Create thread first time
      const thread1 = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: parentMessage.id,
        createdBy: ownerId,
      })

      // Create thread second time with same parent message
      const thread2 = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: parentMessage.id,
        createdBy: ownerId,
      })

      // Should return the same thread
      expect(thread2.id).toBe(thread1.id)
      expect(thread2.createdBy).toBe(thread1.createdBy)
    })

    test("different user creating thread for same message becomes member of existing thread", async () => {
      const ownerId = userId()
      const user2Id = userId()
      const wsId = workspaceId()

      await withTestTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Multi-user Idempotency Workspace",
          slug: `idem-multi-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, ownerId)
        await addTestMember(client, wsId, user2Id)
      })

      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `idem-multi-channel-${Date.now()}`,
        createdBy: ownerId,
        visibility: Visibilities.PUBLIC,
      })

      // Create actual message to thread from
      const parentMessage = await eventService.createMessage({
        workspaceId: wsId,
        streamId: channel.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Parent message for multi-user idempotency test"),
      })

      // First user creates thread
      const thread1 = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: parentMessage.id,
        createdBy: ownerId,
      })

      // Second user tries to create thread for same message
      const thread2 = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: parentMessage.id,
        createdBy: user2Id,
      })

      // Should return same thread
      expect(thread2.id).toBe(thread1.id)
      // createdBy should NOT change - first creator owns it
      expect(thread2.createdBy).toBe(ownerId)

      // Both users should be members
      const isMember1 = await streamService.isMember(thread1.id, ownerId)
      const isMember2 = await streamService.isMember(thread1.id, user2Id)
      expect(isMember1).toBe(true)
      expect(isMember2).toBe(true)
    })
  })

  describe("Reply Count", () => {
    test("creating message in thread increments parent message reply count", async () => {
      const ownerId = userId()
      const wsId = workspaceId()

      await withTestTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Reply Count Test Workspace",
          slug: `reply-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, ownerId)
      })

      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `reply-channel-${Date.now()}`,
        createdBy: ownerId,
        visibility: Visibilities.PUBLIC,
      })

      // Create a message in the channel
      const parentMessage = await eventService.createMessage({
        workspaceId: wsId,
        streamId: channel.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Parent message"),
      })

      // Verify initial reply count is 0
      const initialMessage = await eventService.getMessageById(parentMessage.id)
      expect(initialMessage?.replyCount).toBe(0)

      // Create a thread from the parent message
      const thread = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: parentMessage.id,
        createdBy: ownerId,
      })

      // Send a message in the thread
      await eventService.createMessage({
        workspaceId: wsId,
        streamId: thread.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Reply 1"),
      })

      // Verify reply count is now 1
      const updatedMessage1 = await eventService.getMessageById(parentMessage.id)
      expect(updatedMessage1?.replyCount).toBe(1)

      // Send another message in the thread
      await eventService.createMessage({
        workspaceId: wsId,
        streamId: thread.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Reply 2"),
      })

      // Verify reply count is now 2
      const updatedMessage2 = await eventService.getMessageById(parentMessage.id)
      expect(updatedMessage2?.replyCount).toBe(2)
    })

    test("reply count only tracks direct thread, not nested threads", async () => {
      const ownerId = userId()
      const wsId = workspaceId()

      await withTestTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Nested Reply Count Workspace",
          slug: `nested-reply-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, ownerId)
      })

      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `nested-reply-channel-${Date.now()}`,
        createdBy: ownerId,
        visibility: Visibilities.PUBLIC,
      })

      // Create message in channel
      const channelMessage = await eventService.createMessage({
        workspaceId: wsId,
        streamId: channel.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Channel message"),
      })

      // Create thread from channel message
      const thread1 = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: channelMessage.id,
        createdBy: ownerId,
      })

      // Create message in thread1
      const thread1Message = await eventService.createMessage({
        workspaceId: wsId,
        streamId: thread1.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Thread 1 message"),
      })

      // Channel message should have 1 reply
      const afterThread1Msg = await eventService.getMessageById(channelMessage.id)
      expect(afterThread1Msg?.replyCount).toBe(1)

      // Create nested thread from thread1 message
      const thread2 = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: thread1.id,
        parentAnchorId: thread1Message.id,
        createdBy: ownerId,
      })

      // Create message in nested thread
      await eventService.createMessage({
        workspaceId: wsId,
        streamId: thread2.id,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Thread 2 message"),
      })

      // Channel message should STILL have 1 reply (not 2)
      const afterThread2Msg = await eventService.getMessageById(channelMessage.id)
      expect(afterThread2Msg?.replyCount).toBe(1)

      // Thread 1 message should have 1 reply
      const thread1MsgUpdated = await eventService.getMessageById(thread1Message.id)
      expect(thread1MsgUpdated?.replyCount).toBe(1)
    })
  })

  describe("Event-Anchored Threads", () => {
    async function seedChannel(name: string): Promise<{
      wsId: string
      ownerId: string
      actorId: string
      channelId: string
    }> {
      const ownerId = userId()
      const actorId = userId()
      const wsId = workspaceId()
      await withTestTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: `${name} Workspace`,
          slug: `${name}-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, ownerId)
        await addTestMember(client, wsId, actorId)
      })
      const channel = await streamService.createChannel({
        workspaceId: wsId,
        slug: `${name}-channel-${Date.now()}`,
        createdBy: ownerId,
        visibility: Visibilities.PUBLIC,
      })
      return { wsId, ownerId, actorId, channelId: channel.id }
    }

    test("threading a threadable event anchors on the event, leaves the legacy column null, adds the event actor", async () => {
      const { wsId, ownerId, actorId, channelId } = await seedChannel("event-anchor")

      const event = await StreamEventRepository.insert(pool, {
        id: eventId(),
        streamId: channelId,
        eventType: "delegation:created",
        payload: {},
        actorId,
        actorType: "user",
      })

      const thread = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channelId,
        parentAnchorId: event.id,
        createdBy: ownerId,
      })

      expect(thread.parentAnchorId).toBe(event.id)
      // Event anchors never touch the legacy message column.
      expect(thread.parentMessageId).toBeNull()
      expect(thread.rootStreamId).toBe(channelId)
      // Members: the creator plus the event's user actor.
      expect(await streamService.isMember(thread.id, ownerId)).toBe(true)
      expect(await streamService.isMember(thread.id, actorId)).toBe(true)
    })

    test("a non-threadable event type is rejected with ANCHOR_NOT_THREADABLE", async () => {
      const { wsId, ownerId, actorId, channelId } = await seedChannel("event-nonthreadable")
      const event = await StreamEventRepository.insert(pool, {
        id: eventId(),
        streamId: channelId,
        eventType: "member_added",
        payload: {},
        actorId,
        actorType: "user",
      })

      await expect(
        streamService.createThread({
          workspaceId: wsId,
          parentStreamId: channelId,
          parentAnchorId: event.id,
          createdBy: ownerId,
        })
      ).rejects.toMatchObject({ code: "ANCHOR_NOT_THREADABLE" })
    })

    test("an event on another stream is rejected with ANCHOR_NOT_FOUND", async () => {
      const { wsId, ownerId, actorId, channelId } = await seedChannel("event-crossstream")
      const other = await streamService.createChannel({
        workspaceId: wsId,
        slug: `event-crossstream-other-${Date.now()}`,
        createdBy: ownerId,
        visibility: Visibilities.PUBLIC,
      })
      const event = await StreamEventRepository.insert(pool, {
        id: eventId(),
        streamId: other.id,
        eventType: "delegation:created",
        payload: {},
        actorId,
        actorType: "user",
      })

      await expect(
        streamService.createThread({
          workspaceId: wsId,
          parentStreamId: channelId,
          parentAnchorId: event.id,
          createdBy: ownerId,
        })
      ).rejects.toMatchObject({ code: "ANCHOR_NOT_FOUND" })
    })

    test("message-anchored create dual-writes both the anchor and the legacy column", async () => {
      const { wsId, ownerId, channelId } = await seedChannel("msg-dualwrite")
      const parentMessage = await eventService.createMessage({
        workspaceId: wsId,
        streamId: channelId,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Dual-write parent"),
      })

      const thread = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channelId,
        parentAnchorId: parentMessage.id,
        createdBy: ownerId,
      })

      // Re-read the persisted row: both columns carry the message id during grace.
      const persisted = await StreamRepository.findById(pool, thread.id)
      expect(persisted?.parentAnchorId).toBe(parentMessage.id)
      expect(persisted?.parentMessageId).toBe(parentMessage.id)
    })

    test("a legacy message thread (parent_anchor_id null) resolves idempotently for new code", async () => {
      // Deploy grace window: an OLD replica created the message thread writing only
      // the legacy parent_message_id, leaving parent_anchor_id null. NEW code then
      // re-creates on the same message; the arbiter-less ON CONFLICT must suppress
      // BOTH indexes (the new row conflicts on the legacy index, not the anchor one)
      // so findByAnchor's COALESCE fallback returns the existing row, not a 500.
      const { wsId, ownerId, channelId } = await seedChannel("legacy-msg-thread")
      const parentMessage = await eventService.createMessage({
        workspaceId: wsId,
        streamId: channelId,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Legacy grace-window parent"),
      })

      const legacyThreadId = streamId()
      await pool.query(
        `INSERT INTO streams (
          id, workspace_id, type, visibility, parent_stream_id,
          parent_anchor_id, parent_message_id, root_stream_id, created_by
        ) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8)`,
        [legacyThreadId, wsId, StreamTypes.THREAD, Visibilities.PUBLIC, channelId, parentMessage.id, channelId, ownerId]
      )

      const resolved = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channelId,
        parentAnchorId: parentMessage.id,
        createdBy: ownerId,
      })

      expect(resolved.id).toBe(legacyThreadId)
    })

    test("double-create on the same event anchor is idempotent", async () => {
      const { wsId, ownerId, actorId, channelId } = await seedChannel("event-idempotent")
      const event = await StreamEventRepository.insert(pool, {
        id: eventId(),
        streamId: channelId,
        eventType: "delegation:created",
        payload: {},
        actorId,
        actorType: "user",
      })

      const first = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channelId,
        parentAnchorId: event.id,
        createdBy: ownerId,
      })
      const second = await streamService.createThread({
        workspaceId: wsId,
        parentStreamId: channelId,
        parentAnchorId: event.id,
        createdBy: actorId,
      })

      expect(second.id).toBe(first.id)
      // First creator owns the row; a second caller does not clobber it.
      expect(second.createdBy).toBe(first.createdBy)
    })
  })
})
