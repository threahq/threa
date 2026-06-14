/**
 * Conversation highlight integration tests (agent-runtimes §2.8 Q8).
 *
 * `loadConversationHighlight` surfaces the "Current Topic" the companion turn is
 * sitting in, read best-effort from the `conversations` segmenter's current
 * state. Verifies the Fork-1 anchoring (prefer the trigger's own conversation,
 * fall back to the most recently active in-window topic) and the eligibility
 * filter (unresolved + non-null topic summary).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { ConversationStatuses } from "@threa/types"
import { withTransaction, addTestMember, setupTestDatabase } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { ConversationRepository } from "../../src/features/conversations"
import { loadConversationHighlight } from "../../src/features/agents/companion/conversation-highlight"
import { userId, workspaceId, streamId, messageId, conversationId } from "../../src/lib/id"

describe("loadConversationHighlight", () => {
  let pool: Pool
  let testUserId: string
  let testWorkspaceId: string
  let testStreamId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()

    testUserId = userId()
    testWorkspaceId = workspaceId()
    testStreamId = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Test Workspace",
        slug: `test-ws-${testWorkspaceId}`,
        createdBy: testUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, testUserId)).id
      await StreamRepository.insert(client, {
        id: testStreamId,
        workspaceId: testWorkspaceId,
        type: "scratchpad",
        visibility: "private",
        companionMode: "on",
        createdBy: testUserId,
      })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("prefers the trigger's own conversation over a more recently active in-window topic", async () => {
    await withTransaction(pool, async (client) => {
      const triggerMsg = messageId()
      const olderMsg = messageId()

      const triggerConv = conversationId()
      await ConversationRepository.insert(client, {
        id: triggerConv,
        streamId: testStreamId,
        workspaceId: testWorkspaceId,
        topicSummary: "Trigger topic",
      })
      await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, triggerConv, triggerMsg, testUserId)

      // A different topic in the same window, made strictly more recently active
      // — it would win the recency fallback, so the trigger preference must beat it.
      const otherConv = conversationId()
      await ConversationRepository.insert(client, {
        id: otherConv,
        streamId: testStreamId,
        workspaceId: testWorkspaceId,
        topicSummary: "Other topic",
      })
      await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, otherConv, olderMsg, testUserId)
      await ConversationRepository.update(client, testWorkspaceId, otherConv, {
        lastActivityAt: new Date("2030-01-01T00:00:00Z"),
      })

      const topic = await loadConversationHighlight(client, {
        workspaceId: testWorkspaceId,
        triggerMessageId: triggerMsg,
        windowMessageIds: [olderMsg, triggerMsg],
      })

      expect(topic).toBe("Trigger topic")
    })
  })

  test("falls back to the most recently active in-window topic when the trigger is unclassified", async () => {
    await withTransaction(pool, async (client) => {
      const triggerMsg = messageId() // never assigned to a conversation
      const staleMsg = messageId()
      const liveMsg = messageId()

      const staleConv = conversationId()
      await ConversationRepository.insert(client, {
        id: staleConv,
        streamId: testStreamId,
        workspaceId: testWorkspaceId,
        topicSummary: "Stale topic",
      })
      await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, staleConv, staleMsg, testUserId)
      await ConversationRepository.update(client, testWorkspaceId, staleConv, {
        lastActivityAt: new Date("2026-01-01T00:00:00Z"),
      })

      const liveConv = conversationId()
      await ConversationRepository.insert(client, {
        id: liveConv,
        streamId: testStreamId,
        workspaceId: testWorkspaceId,
        topicSummary: "Live topic",
      })
      await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, liveConv, liveMsg, testUserId)
      await ConversationRepository.update(client, testWorkspaceId, liveConv, {
        lastActivityAt: new Date("2026-06-01T00:00:00Z"),
      })

      const topic = await loadConversationHighlight(client, {
        workspaceId: testWorkspaceId,
        triggerMessageId: triggerMsg,
        windowMessageIds: [staleMsg, liveMsg, triggerMsg],
      })

      expect(topic).toBe("Live topic")
    })
  })

  test("ignores resolved conversations", async () => {
    await withTransaction(pool, async (client) => {
      const triggerMsg = messageId()
      const resolvedMsg = messageId()

      const resolvedConv = conversationId()
      await ConversationRepository.insert(client, {
        id: resolvedConv,
        streamId: testStreamId,
        workspaceId: testWorkspaceId,
        topicSummary: "Resolved topic",
        status: ConversationStatuses.RESOLVED,
      })
      await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, resolvedConv, resolvedMsg, testUserId)

      const topic = await loadConversationHighlight(client, {
        workspaceId: testWorkspaceId,
        triggerMessageId: triggerMsg,
        windowMessageIds: [resolvedMsg, triggerMsg],
      })

      expect(topic).toBeNull()
    })
  })

  test("ignores conversations without a topic summary", async () => {
    await withTransaction(pool, async (client) => {
      const triggerMsg = messageId()
      const unsummarizedMsg = messageId()

      const conv = conversationId()
      await ConversationRepository.insert(client, {
        id: conv,
        streamId: testStreamId,
        workspaceId: testWorkspaceId,
        // no topicSummary — segmentation hasn't produced one yet
      })
      await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, conv, unsummarizedMsg, testUserId)

      const topic = await loadConversationHighlight(client, {
        workspaceId: testWorkspaceId,
        triggerMessageId: triggerMsg,
        windowMessageIds: [unsummarizedMsg, triggerMsg],
      })

      expect(topic).toBeNull()
    })
  })

  test("returns null when nothing in the window is classified", async () => {
    await withTransaction(pool, async (client) => {
      const triggerMsg = messageId()
      const otherMsg = messageId()

      const fromEmptyWindow = await loadConversationHighlight(client, {
        workspaceId: testWorkspaceId,
        triggerMessageId: triggerMsg,
        windowMessageIds: [],
      })
      const fromUnclassifiedWindow = await loadConversationHighlight(client, {
        workspaceId: testWorkspaceId,
        triggerMessageId: triggerMsg,
        windowMessageIds: [otherMsg, triggerMsg],
      })

      expect(fromEmptyWindow).toBeNull()
      expect(fromUnclassifiedWindow).toBeNull()
    })
  })
})
