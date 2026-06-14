/**
 * Context Builder Integration Tests
 *
 * Tests verify:
 * 1. Scratchpad context includes conversation history
 * 2. Channel context includes members and conversation
 * 3. Thread context includes hierarchy path
 * 4. DM context includes both participants
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { addTestMember, withTestTransaction } from "./setup"
import { WorkspaceRepository, UserRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { buildStreamContext } from "../../src/features/agents"
import { setupTestDatabase, testMessageContent } from "./setup"
import { userId, workspaceId, streamId, messageId } from "../../src/lib/id"
import { StreamTypes, Visibilities } from "@threa/types"

describe("Context Builder", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  describe("Scratchpad Context", () => {
    test("should include conversation history", async () => {
      await withTestTransaction(pool, async (client) => {
        const workosUserId = userId()
        const wsId = workspaceId()
        const scratchpadId = streamId()
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Context Test Workspace",
          slug: `ctx-ws-${wsId}`,
          createdBy: workosUserId,
        })
        const ownerUserId = (await addTestMember(client, wsId, workosUserId)).id

        const scratchpad = await StreamRepository.insert(client, {
          id: scratchpadId,
          workspaceId: wsId,
          type: StreamTypes.SCRATCHPAD,
          displayName: "My Scratchpad",
          description: "Personal notes",
          visibility: Visibilities.PRIVATE,
          createdBy: ownerUserId,
        })

        // Add some messages
        const msg1Id = messageId()
        const msg2Id = messageId()
        await MessageRepository.insert(client, {
          id: msg1Id,
          streamId: scratchpadId,
          sequence: BigInt(1),
          authorId: ownerUserId,
          authorType: "user",
          ...testMessageContent("Hello world"),
        })
        await MessageRepository.insert(client, {
          id: msg2Id,
          streamId: scratchpadId,
          sequence: BigInt(2),
          authorId: ownerUserId,
          authorType: "user",
          ...testMessageContent("Second message"),
        })

        const context = await buildStreamContext(client, scratchpad)

        expect(context).toMatchObject({
          streamType: StreamTypes.SCRATCHPAD,
          streamInfo: {
            name: "My Scratchpad",
            description: "Personal notes",
          },
          conversationHistory: [{ contentMarkdown: "Hello world" }, { contentMarkdown: "Second message" }],
        })
        expect(context.participants).toBeUndefined()
      })
    })

    test("should include temporal when only currentTime is provided (no user preferences)", async () => {
      await withTestTransaction(pool, async (client) => {
        const workosUserId = userId()
        const wsId = workspaceId()
        const scratchpadId = streamId()
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Context Test Workspace 2",
          slug: `ctx-ws-${wsId}`,
          createdBy: workosUserId,
        })
        const ownerUserId = (await addTestMember(client, wsId, workosUserId)).id

        const scratchpad = await StreamRepository.insert(client, {
          id: scratchpadId,
          workspaceId: wsId,
          type: StreamTypes.SCRATCHPAD,
          displayName: "Pinned time scratchpad",
          description: null,
          visibility: Visibilities.PRIVATE,
          createdBy: ownerUserId,
        })

        const pinned = new Date("2026-11-15T10:00:00.000Z")
        const context = await buildStreamContext(client, scratchpad, { currentTime: pinned })

        expect(context.temporal).toMatchObject({
          currentTime: pinned.toISOString(),
          timezone: "UTC",
          dateFormat: "YYYY-MM-DD",
          timeFormat: "24h",
        })
      })
    })
  })

  describe("Channel Context", () => {
    test("should include members and conversation", async () => {
      await withTestTransaction(pool, async (client) => {
        const ownerWorkosId = userId()
        const memberWorkosId = userId()
        const wsId = workspaceId()
        const channelId = streamId()
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Channel Context Workspace",
          slug: `channel-ctx-ws-${wsId}`,
          createdBy: ownerWorkosId,
        })
        const ownerUser = await addTestMember(client, wsId, ownerWorkosId)
        const memberMember = await addTestMember(client, wsId, memberWorkosId)
        const ownerUserId = ownerUser.id
        const memberUserId = memberMember.id
        await UserRepository.update(client, wsId, ownerUserId, { name: "Channel Owner" })
        await UserRepository.update(client, wsId, memberUserId, { name: "Channel Member" })

        const channel = await StreamRepository.insert(client, {
          id: channelId,
          workspaceId: wsId,
          type: StreamTypes.CHANNEL,
          displayName: "General",
          slug: "general",
          description: "General discussion",
          visibility: Visibilities.PUBLIC,
          createdBy: ownerUserId,
        })

        // Add members
        await StreamMemberRepository.insert(client, channelId, ownerUserId)
        await StreamMemberRepository.insert(client, channelId, memberUserId)

        // Add a message
        const msgId = messageId()
        await MessageRepository.insert(client, {
          id: msgId,
          streamId: channelId,
          sequence: BigInt(1),
          authorId: ownerUserId,
          authorType: "user",
          ...testMessageContent("Welcome to the channel!"),
        })

        const context = await buildStreamContext(client, channel)

        expect(context.streamType).toBe(StreamTypes.CHANNEL)
        expect(context.streamInfo.name).toBe("General")
        expect(context.streamInfo.slug).toBe("general")
        expect(context.streamInfo.description).toBe("General discussion")
        expect(context.conversationHistory).toHaveLength(1)
        expect(context.participants).toHaveLength(2)

        const participantNames = context.participants!.map((p) => p.name).sort()
        expect(participantNames).toEqual(["Channel Member", "Channel Owner"])
      })
    })
  })

  describe("Thread Context", () => {
    test("should include thread hierarchy path", async () => {
      await withTestTransaction(pool, async (client) => {
        const workosUserId = userId()
        const wsId = workspaceId()
        const channelId = streamId()
        const threadId = streamId()
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Thread Context Workspace",
          slug: `thread-ctx-ws-${wsId}`,
          createdBy: workosUserId,
        })
        const ownerUserId = (await addTestMember(client, wsId, workosUserId)).id

        // Create channel
        await StreamRepository.insert(client, {
          id: channelId,
          workspaceId: wsId,
          type: StreamTypes.CHANNEL,
          displayName: "Discussions",
          slug: "discussions",
          visibility: Visibilities.PUBLIC,
          createdBy: ownerUserId,
        })

        // Add parent message
        const parentMsgId = messageId()
        await MessageRepository.insert(client, {
          id: parentMsgId,
          streamId: channelId,
          sequence: BigInt(1),
          authorId: ownerUserId,
          authorType: "user",
          ...testMessageContent("This is the parent message that spawned the thread"),
        })

        // Create thread from channel
        const thread = await StreamRepository.insert(client, {
          id: threadId,
          workspaceId: wsId,
          type: StreamTypes.THREAD,
          displayName: "Thread Discussion",
          visibility: Visibilities.PRIVATE,
          parentStreamId: channelId,
          parentMessageId: parentMsgId,
          rootStreamId: channelId,
          createdBy: ownerUserId,
        })

        // Add thread message
        const threadMsgId = messageId()
        await MessageRepository.insert(client, {
          id: threadMsgId,
          streamId: threadId,
          sequence: BigInt(1),
          authorId: ownerUserId,
          authorType: "user",
          ...testMessageContent("Reply in thread"),
        })

        const context = await buildStreamContext(client, thread)

        expect(context).toMatchObject({
          streamType: StreamTypes.THREAD,
          streamInfo: { name: "Thread Discussion" },
          // Parent message is prepended to conversation history for full context
          conversationHistory: [
            { contentMarkdown: "This is the parent message that spawned the thread" },
            { contentMarkdown: "Reply in thread" },
          ],
          threadContext: {
            depth: 2,
            path: [
              { streamId: channelId, displayName: "Discussions" },
              { streamId: threadId, displayName: "Thread Discussion" },
            ],
          },
        })

        // Verify anchor message content (uses toContain, cannot express in toMatchObject)
        expect(context.threadContext!.path[1].anchorMessage!.content).toContain("parent message")
      })
    })

    test("should handle deeply nested threads", async () => {
      await withTestTransaction(pool, async (client) => {
        const workosUserId = userId()
        const wsId = workspaceId()
        const channelId = streamId()
        const thread1Id = streamId()
        const thread2Id = streamId()
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Deep Thread Context Workspace",
          slug: `deep-thread-ws-${wsId}`,
          createdBy: workosUserId,
        })
        const ownerUserId = (await addTestMember(client, wsId, workosUserId)).id

        // Create channel -> thread1 -> thread2
        await StreamRepository.insert(client, {
          id: channelId,
          workspaceId: wsId,
          type: StreamTypes.CHANNEL,
          displayName: "Root Channel",
          slug: "root",
          visibility: Visibilities.PUBLIC,
          createdBy: ownerUserId,
        })

        const msg1Id = messageId()
        await MessageRepository.insert(client, {
          id: msg1Id,
          streamId: channelId,
          sequence: BigInt(1),
          authorId: ownerUserId,
          authorType: "user",
          ...testMessageContent("First level message"),
        })

        await StreamRepository.insert(client, {
          id: thread1Id,
          workspaceId: wsId,
          type: StreamTypes.THREAD,
          displayName: "Thread Level 1",
          visibility: Visibilities.PRIVATE,
          parentStreamId: channelId,
          parentMessageId: msg1Id,
          rootStreamId: channelId,
          createdBy: ownerUserId,
        })

        const msg2Id = messageId()
        await MessageRepository.insert(client, {
          id: msg2Id,
          streamId: thread1Id,
          sequence: BigInt(1),
          authorId: ownerUserId,
          authorType: "user",
          ...testMessageContent("Second level message"),
        })

        const thread2 = await StreamRepository.insert(client, {
          id: thread2Id,
          workspaceId: wsId,
          type: StreamTypes.THREAD,
          displayName: "Thread Level 2",
          visibility: Visibilities.PRIVATE,
          parentStreamId: thread1Id,
          parentMessageId: msg2Id,
          rootStreamId: channelId,
          createdBy: ownerUserId,
        })

        const msg3Id = messageId()
        await MessageRepository.insert(client, {
          id: msg3Id,
          streamId: thread2Id,
          sequence: BigInt(1),
          authorId: ownerUserId,
          authorType: "user",
          ...testMessageContent("Third level message"),
        })

        const context = await buildStreamContext(client, thread2)

        expect(context.threadContext).toMatchObject({
          depth: 3,
          path: [{ displayName: "Root Channel" }, { displayName: "Thread Level 1" }, { displayName: "Thread Level 2" }],
        })

        // Parent message from thread1 should be prepended to conversation history
        expect(context.conversationHistory).toMatchObject([
          { contentMarkdown: "Second level message" },
          { contentMarkdown: "Third level message" },
        ])
      })
    })
  })

  describe("DM Context", () => {
    test("should include both participants", async () => {
      await withTestTransaction(pool, async (client) => {
        const user1Id = userId()
        const user2Id = userId()
        const wsId = workspaceId()
        const dmId = streamId()
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "DM Context Workspace",
          slug: `dm-ctx-ws-${wsId}`,
          createdBy: user1Id,
        })
        const member1 = await addTestMember(client, wsId, user1Id)
        const member2 = await addTestMember(client, wsId, user2Id)
        const member1Id = member1.id
        const member2Id = member2.id
        await UserRepository.update(client, wsId, member1Id, { name: "Alice" })
        await UserRepository.update(client, wsId, member2Id, { name: "Bob" })

        const dm = await StreamRepository.insert(client, {
          id: dmId,
          workspaceId: wsId,
          type: StreamTypes.DM,
          visibility: Visibilities.PRIVATE,
          createdBy: member1Id,
        })

        // Add both as members
        await StreamMemberRepository.insert(client, dmId, member1Id)
        await StreamMemberRepository.insert(client, dmId, member2Id)

        // Add messages
        const msgId = messageId()
        await MessageRepository.insert(client, {
          id: msgId,
          streamId: dmId,
          sequence: BigInt(1),
          authorId: member1Id,
          authorType: "user",
          ...testMessageContent("Hey Bob!"),
        })

        const context = await buildStreamContext(client, dm)

        expect(context.streamType).toBe(StreamTypes.DM)
        expect(context.conversationHistory).toHaveLength(1)
        expect(context.participants).toHaveLength(2)

        const participantNames = context.participants!.map((p) => p.name).sort()
        expect(participantNames).toEqual(["Alice", "Bob"])
      })
    })
  })

  describe("Budgeted window (C-2b)", () => {
    test("maxChars trims the window newest-first; maxMessages alone keeps all", async () => {
      await withTestTransaction(pool, async (client) => {
        const workosUserId = userId()
        const wsId = workspaceId()
        const scratchpadId = streamId()
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Budget Window Workspace",
          slug: `ctx-ws-${wsId}`,
          createdBy: workosUserId,
        })
        const ownerUserId = (await addTestMember(client, wsId, workosUserId)).id

        const scratchpad = await StreamRepository.insert(client, {
          id: scratchpadId,
          workspaceId: wsId,
          type: StreamTypes.SCRATCHPAD,
          displayName: "Budgeted scratchpad",
          description: null,
          visibility: Visibilities.PRIVATE,
          createdBy: ownerUserId,
        })

        // 6 messages of 100 chars each (chronological).
        const body = "x".repeat(100)
        for (let i = 1; i <= 6; i++) {
          await MessageRepository.insert(client, {
            id: messageId(),
            streamId: scratchpadId,
            sequence: BigInt(i),
            authorId: ownerUserId,
            authorType: "user",
            ...testMessageContent(`${body}-${i}`),
          })
        }

        // No char budget → all 6 fetched (within the message ceiling).
        const full = await buildStreamContext(client, scratchpad, { maxMessages: 10 })
        expect(full.conversationHistory).toHaveLength(6)
        expect(full.conversationHistory.at(-1)?.contentMarkdown).toContain("-6")

        // ~250 char budget keeps only the newest messages that fit, always the
        // last one. Each message is ~102 chars, so the window holds the newest 2.
        const trimmed = await buildStreamContext(client, scratchpad, { maxMessages: 10, maxChars: 250 })
        expect(trimmed.conversationHistory).toHaveLength(2)
        expect(trimmed.conversationHistory.at(-1)?.contentMarkdown).toContain("-6")
        expect(trimmed.conversationHistory.at(0)?.contentMarkdown).toContain("-5")
      })
    })

    test("a single oversized message is still kept (window holds at least the trigger)", async () => {
      await withTestTransaction(pool, async (client) => {
        const workosUserId = userId()
        const wsId = workspaceId()
        const scratchpadId = streamId()
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Oversized Window Workspace",
          slug: `ctx-ws-${wsId}`,
          createdBy: workosUserId,
        })
        const ownerUserId = (await addTestMember(client, wsId, workosUserId)).id

        const scratchpad = await StreamRepository.insert(client, {
          id: scratchpadId,
          workspaceId: wsId,
          type: StreamTypes.SCRATCHPAD,
          displayName: "Oversized scratchpad",
          description: null,
          visibility: Visibilities.PRIVATE,
          createdBy: ownerUserId,
        })

        await MessageRepository.insert(client, {
          id: messageId(),
          streamId: scratchpadId,
          sequence: BigInt(1),
          authorId: ownerUserId,
          authorType: "user",
          ...testMessageContent("y".repeat(1000)),
        })

        const trimmed = await buildStreamContext(client, scratchpad, { maxMessages: 10, maxChars: 50 })
        expect(trimmed.conversationHistory).toHaveLength(1)
      })
    })

    test("keeps the prepended thread root anchor even when the budget trims thread messages", async () => {
      await withTestTransaction(pool, async (client) => {
        const workosUserId = userId()
        const wsId = workspaceId()
        const channelId = streamId()
        const threadId = streamId()
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Thread Budget Workspace",
          slug: `ctx-ws-${wsId}`,
          createdBy: workosUserId,
        })
        const ownerUserId = (await addTestMember(client, wsId, workosUserId)).id

        await StreamRepository.insert(client, {
          id: channelId,
          workspaceId: wsId,
          type: StreamTypes.CHANNEL,
          displayName: "Discussions",
          slug: "discussions",
          visibility: Visibilities.PUBLIC,
          createdBy: ownerUserId,
        })

        const parentMsgId = messageId()
        await MessageRepository.insert(client, {
          id: parentMsgId,
          streamId: channelId,
          sequence: BigInt(1),
          authorId: ownerUserId,
          authorType: "user",
          ...testMessageContent("ANCHOR: the parent message that spawned the thread"),
        })

        const thread = await StreamRepository.insert(client, {
          id: threadId,
          workspaceId: wsId,
          type: StreamTypes.THREAD,
          displayName: "Thread Discussion",
          visibility: Visibilities.PRIVATE,
          parentStreamId: channelId,
          parentMessageId: parentMsgId,
          rootStreamId: channelId,
          createdBy: ownerUserId,
        })

        // Three ~100-char thread replies; a 150 char budget keeps only the newest
        // thread reply, but the anchor (from the channel) must remain pinned.
        for (let i = 1; i <= 3; i++) {
          await MessageRepository.insert(client, {
            id: messageId(),
            streamId: threadId,
            sequence: BigInt(i),
            authorId: ownerUserId,
            authorType: "user",
            ...testMessageContent(`${"r".repeat(100)}-${i}`),
          })
        }

        const trimmed = await buildStreamContext(client, thread, { maxMessages: 10, maxChars: 150 })

        expect(trimmed.conversationHistory.at(0)?.contentMarkdown).toContain("ANCHOR")
        expect(trimmed.conversationHistory.at(-1)?.contentMarkdown).toContain("-3")
        // Anchor + the single newest thread reply that fits the budget.
        expect(trimmed.conversationHistory).toHaveLength(2)
      })
    })
  })
})
