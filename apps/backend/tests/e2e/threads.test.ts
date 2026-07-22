/**
 * E2E Thread Tests - black box testing via HTTP.
 *
 * Tests verify:
 * 1. Thread creation via API
 * 2. Bootstrap returns threadId and replyCount for messages with threads
 * 3. Reply count reflects actual message count in thread
 */

import { describe, test, expect } from "bun:test"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createScratchpad,
  sendMessage,
  createThread,
  getBootstrap,
  listEvents,
  moveMessagesToThread,
  validateMoveMessagesToThread,
} from "../client"

// Generate unique identifier for this test run to avoid collisions
const testRunId = Math.random().toString(36).substring(7)
const testEmail = (name: string) => `${name}-${testRunId}@test.com`

interface MessageCreatedPayload {
  messageId: string
  content: string
  contentFormat: string
  threadId?: string
  replyCount?: number
}

describe("Thread E2E Tests", () => {
  describe("Thread Creation", () => {
    test("should create thread via API", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("thread-create"), "Thread Create Test")
      const workspace = await createWorkspace(client, `Thread Create WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // Create a message
      const message = await sendMessage(client, workspace.id, scratchpad.id, "Parent message")

      // Create thread from the message
      const thread = await createThread(client, workspace.id, scratchpad.id, message.id)

      expect(thread.id).toMatch(/^stream_/)
      expect(thread.type).toBe("thread")
      expect(thread.parentStreamId).toBe(scratchpad.id)
      expect(thread.parentAnchorId).toBe(message.id)
    })

    test("should return existing thread when creating duplicate", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("thread-idem"), "Thread Idempotency Test")
      const workspace = await createWorkspace(client, `Thread Idem WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      const message = await sendMessage(client, workspace.id, scratchpad.id, "Parent message")

      // Create thread twice
      const thread1 = await createThread(client, workspace.id, scratchpad.id, message.id)
      const thread2 = await createThread(client, workspace.id, scratchpad.id, message.id)

      expect(thread2.id).toBe(thread1.id)
    })
  })

  describe("Bootstrap Reply Count", () => {
    test("should return replyCount=0 for message with empty thread", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("reply-zero"), "Reply Zero Test")
      const workspace = await createWorkspace(client, `Reply Zero WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // Create a message
      const message = await sendMessage(client, workspace.id, scratchpad.id, "Parent message")

      // Create thread (but don't send any messages in it)
      const thread = await createThread(client, workspace.id, scratchpad.id, message.id)

      // Bootstrap parent stream
      const bootstrap = await getBootstrap(client, workspace.id, scratchpad.id)

      // Find the message event
      const messageEvent = bootstrap.events.find(
        (e) => e.eventType === "message_created" && (e.payload as MessageCreatedPayload).messageId === message.id
      )

      expect(messageEvent).toBeDefined()
      const payload = messageEvent!.payload as MessageCreatedPayload
      expect(payload.threadId).toBe(thread.id)
      expect(payload.replyCount).toBe(0)
    })

    test("should return correct replyCount for message with thread messages", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("reply-count"), "Reply Count Test")
      const workspace = await createWorkspace(client, `Reply Count WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // Create a message
      const parentMessage = await sendMessage(client, workspace.id, scratchpad.id, "Parent message")

      // Create thread
      const thread = await createThread(client, workspace.id, scratchpad.id, parentMessage.id)

      // Send 3 messages in the thread
      await sendMessage(client, workspace.id, thread.id, "Reply 1")
      await sendMessage(client, workspace.id, thread.id, "Reply 2")
      await sendMessage(client, workspace.id, thread.id, "Reply 3")

      // Bootstrap parent stream
      const bootstrap = await getBootstrap(client, workspace.id, scratchpad.id)

      // Find the parent message event
      const messageEvent = bootstrap.events.find(
        (e) => e.eventType === "message_created" && (e.payload as MessageCreatedPayload).messageId === parentMessage.id
      )

      expect(messageEvent).toBeDefined()
      const payload = messageEvent!.payload as MessageCreatedPayload
      expect(payload.threadId).toBe(thread.id)
      expect(payload.replyCount).toBe(3)
    })

    test("should not include threadId or replyCount for messages without threads", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("no-thread"), "No Thread Test")
      const workspace = await createWorkspace(client, `No Thread WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // Create a message (no thread)
      const message = await sendMessage(client, workspace.id, scratchpad.id, "Regular message")

      // Bootstrap
      const bootstrap = await getBootstrap(client, workspace.id, scratchpad.id)

      // Find the message event
      const messageEvent = bootstrap.events.find(
        (e) => e.eventType === "message_created" && (e.payload as MessageCreatedPayload).messageId === message.id
      )

      expect(messageEvent).toBeDefined()
      const payload = messageEvent!.payload as MessageCreatedPayload
      expect(payload.threadId).toBeUndefined()
      expect(payload.replyCount).toBeUndefined()
    })

    test("should return correct replyCount for multiple messages with threads", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("multi-thread"), "Multi Thread Test")
      const workspace = await createWorkspace(client, `Multi Thread WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // Create two messages
      const message1 = await sendMessage(client, workspace.id, scratchpad.id, "First parent")
      const message2 = await sendMessage(client, workspace.id, scratchpad.id, "Second parent")

      // Create threads for both
      const thread1 = await createThread(client, workspace.id, scratchpad.id, message1.id)
      const thread2 = await createThread(client, workspace.id, scratchpad.id, message2.id)

      // Send different number of messages in each thread
      await sendMessage(client, workspace.id, thread1.id, "Thread 1 - Reply 1")
      await sendMessage(client, workspace.id, thread1.id, "Thread 1 - Reply 2")

      await sendMessage(client, workspace.id, thread2.id, "Thread 2 - Reply 1")
      await sendMessage(client, workspace.id, thread2.id, "Thread 2 - Reply 2")
      await sendMessage(client, workspace.id, thread2.id, "Thread 2 - Reply 3")
      await sendMessage(client, workspace.id, thread2.id, "Thread 2 - Reply 4")
      await sendMessage(client, workspace.id, thread2.id, "Thread 2 - Reply 5")

      // Bootstrap parent stream
      const bootstrap = await getBootstrap(client, workspace.id, scratchpad.id)

      // Find both message events
      const event1 = bootstrap.events.find(
        (e) => e.eventType === "message_created" && (e.payload as MessageCreatedPayload).messageId === message1.id
      )
      const event2 = bootstrap.events.find(
        (e) => e.eventType === "message_created" && (e.payload as MessageCreatedPayload).messageId === message2.id
      )

      expect(event1).toBeDefined()
      expect(event2).toBeDefined()

      const payload1 = event1!.payload as MessageCreatedPayload
      const payload2 = event2!.payload as MessageCreatedPayload

      expect(payload1.threadId).toBe(thread1.id)
      expect(payload1.replyCount).toBe(2)

      expect(payload2.threadId).toBe(thread2.id)
      expect(payload2.replyCount).toBe(5)
    })
  })

  describe("Thread Bootstrap", () => {
    test("should bootstrap thread stream with its messages", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("thread-boot"), "Thread Bootstrap Test")
      const workspace = await createWorkspace(client, `Thread Boot WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // Create parent message and thread
      const parentMessage = await sendMessage(client, workspace.id, scratchpad.id, "Parent message")
      const thread = await createThread(client, workspace.id, scratchpad.id, parentMessage.id)

      // Send messages in thread
      await sendMessage(client, workspace.id, thread.id, "Thread reply 1")
      await sendMessage(client, workspace.id, thread.id, "Thread reply 2")

      // Bootstrap the thread
      const bootstrap = await getBootstrap(client, workspace.id, thread.id)

      expect(bootstrap.stream.id).toBe(thread.id)
      expect(bootstrap.stream.type).toBe("thread")

      // Thread should have 2 message_created events
      const messageEvents = bootstrap.events.filter((e) => e.eventType === "message_created")
      expect(messageEvents.length).toBe(2)
    })
  })

  describe("Move messages to thread", () => {
    test("should move sparse selected messages into a new direct child thread", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("move-to-thread"), "Move To Thread Test")
      const workspace = await createWorkspace(client, `Move To Thread WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      const target = await sendMessage(client, workspace.id, scratchpad.id, "Target")
      const keep = await sendMessage(client, workspace.id, scratchpad.id, "Keep")
      const movedA = await sendMessage(client, workspace.id, scratchpad.id, "Move A")
      const movedB = await sendMessage(client, workspace.id, scratchpad.id, "Move B")

      const result = await moveMessagesToThread(client, workspace.id, scratchpad.id, target.id, [movedB.id, movedA.id])

      expect(result.thread.type).toBe("thread")
      expect(result.thread.parentStreamId).toBe(scratchpad.id)
      expect(result.thread.parentAnchorId).toBe(target.id)
      expect(result.destinationStreamId).toBe(result.thread.id)
      expect(new Set(result.movedMessageIds)).toEqual(new Set([movedA.id, movedB.id]))

      const sourceEvents = await listEvents(client, workspace.id, scratchpad.id, ["message_created"])
      const sourceMessageIds = new Set(sourceEvents.map((event) => (event.payload as MessageCreatedPayload).messageId))
      expect(sourceMessageIds).toEqual(new Set([target.id, keep.id]))

      const threadEvents = await listEvents(client, workspace.id, result.thread.id, ["message_created"])
      const threadMessageIds = threadEvents.map((event) => (event.payload as MessageCreatedPayload).messageId)
      expect(threadMessageIds).toEqual([movedA.id, movedB.id])

      const bootstrap = await getBootstrap(client, workspace.id, scratchpad.id)
      const targetEvent = bootstrap.events.find(
        (event) =>
          event.eventType === "message_created" && (event.payload as MessageCreatedPayload).messageId === target.id
      )
      expect((targetEvent!.payload as MessageCreatedPayload).threadId).toBe(result.thread.id)
      expect((targetEvent!.payload as MessageCreatedPayload).replyCount).toBe(2)
    })

    test("should reject moving messages onto a following message", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("move-following"), "Move Following Test")
      const workspace = await createWorkspace(client, `Move Following WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      const selected = await sendMessage(client, workspace.id, scratchpad.id, "Selected")
      const following = await sendMessage(client, workspace.id, scratchpad.id, "Following")

      const response = await validateMoveMessagesToThread(client, workspace.id, scratchpad.id, following.id, [
        selected.id,
      ])

      expect(response.status).toBe(400)
      expect(JSON.stringify(response.data)).toContain("TARGET_MUST_PRECEDE_SELECTION")
    })
  })
})
