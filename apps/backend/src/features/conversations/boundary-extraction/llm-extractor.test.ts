/**
 * LLM Boundary Extractor Unit Tests
 *
 * Tests verify:
 * 1. Thread cold-start (no active/parent convs) deterministically creates a new conversation
 * 2. Structured output parsing extracts assignments + reassignments
 * 3. LLM errors fall back to safe defaults
 * 4. Invalid conversation IDs in assignments are dropped
 * 5. Reassignments are validated against the candidate set
 * 6. Topic extraction from message content
 */

import { describe, test, expect, mock, beforeEach } from "bun:test"
import { LLMBoundaryExtractor } from "./llm-extractor"
import type { ExtractionContext, ConversationSummary } from "./types"
import type { Message } from "../../messaging"
import type { AI } from "../../../lib/ai/ai"
import type { ConfigResolver, ComponentConfig } from "../../../lib/ai/config-resolver"

import { NoObjectGeneratedError } from "ai"

const mockGenerateObject = mock(
  async (): Promise<{ value: any; response: any; usage: any }> => ({
    value: { assignments: [{ conversationId: null, isPrimary: true }], confidence: 0.5 },
    response: { usage: {} },
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  })
)

const mockAI: Partial<AI> = {
  generateObject: mockGenerateObject as AI["generateObject"],
}

const mockConfigResolver: ConfigResolver = {
  async resolve<T extends ComponentConfig>(): Promise<T> {
    return {
      modelId: "openrouter:anthropic/claude-haiku-4.5",
      temperature: 0.2,
      systemPrompt: "You are a conversation boundary classifier.",
    } as T
  },
}

function createMockMessage(overrides: Partial<Message> = {}): Message {
  const contentMarkdown = overrides.contentMarkdown ?? "Test message content"
  return {
    id: "msg_test123",
    streamId: "stream_test",
    sequence: BigInt(1),
    authorId: "usr_test",
    authorType: "user",
    contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: contentMarkdown }] }] },
    contentMarkdown,
    replyCount: 0,
    reactions: {},
    metadata: {},
    clientMessageId: null,
    sentVia: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    ...overrides,
  }
}

function createMockConversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: "conv_existing123",
    topicSummary: "Existing conversation topic",
    messageCount: 5,
    lastMessagePreview: "Last message preview",
    participantIds: ["usr_test"],
    completenessScore: 3,
    contextMessageIds: [],
    ...overrides,
  }
}

function createMockContext(overrides: Partial<ExtractionContext> = {}): ExtractionContext {
  return {
    newMessage: createMockMessage(),
    recentMessages: [createMockMessage()],
    activeConversations: [],
    streamType: "scratchpad",
    workspaceId: "wsp_test123",
    ...overrides,
  }
}

describe("LLMBoundaryExtractor", () => {
  let extractor: LLMBoundaryExtractor

  beforeEach(() => {
    mockGenerateObject.mockReset()
    extractor = new LLMBoundaryExtractor(mockAI as AI, mockConfigResolver)
  })

  describe("thread cold-start", () => {
    test("creates new conversation when thread has no active and no parent conversations", async () => {
      const context = createMockContext({
        streamType: "thread",
        activeConversations: [],
        newMessage: createMockMessage({ contentMarkdown: "Starting a thread discussion" }),
      })

      const result = await extractor.extract(context)

      expect(result.assignments).toEqual([{ conversationId: null, isPrimary: true }])
      expect(result.newConversationTopic).toBe("Starting a thread discussion")
      expect(result.confidence).toBe(1.0)
    })

    test("does not call LLM during thread cold-start", async () => {
      const context = createMockContext({
        streamType: "thread",
        activeConversations: [],
      })

      await extractor.extract(context)

      expect(mockGenerateObject).not.toHaveBeenCalled()
    })

    test("calls LLM when thread has an existing active conversation", async () => {
      const existingConv = createMockConversation({ id: "conv_thread123" })
      const context = createMockContext({
        streamType: "thread",
        activeConversations: [existingConv],
      })

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [{ conversationId: "conv_thread123", isPrimary: true }],
          confidence: 0.95,
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      const result = await extractor.extract(context)

      expect(mockGenerateObject).toHaveBeenCalled()
      expect(result.assignments[0].conversationId).toBe("conv_thread123")
      expect(result.assignments[0].isPrimary).toBe(true)
    })

    test("calls LLM when thread has only a parent conversation", async () => {
      const parentConv = createMockConversation({ id: "conv_parent123" })
      const context = createMockContext({
        streamType: "thread",
        activeConversations: [],
        parentMessageConversations: [parentConv],
      })

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [{ conversationId: "conv_parent123", isPrimary: true }],
          confidence: 0.9,
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      const result = await extractor.extract(context)

      expect(mockGenerateObject).toHaveBeenCalled()
      expect(result.assignments[0].conversationId).toBe("conv_parent123")
    })
  })

  describe("structured output handling", () => {
    test("handles response with existing conversation as primary", async () => {
      const existingConv = createMockConversation({ id: "conv_match123" })
      const context = createMockContext({
        activeConversations: [existingConv],
      })

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [{ conversationId: "conv_match123", isPrimary: true }],
          confidence: 0.92,
          reasoning: "Topic matches existing conversation",
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      const result = await extractor.extract(context)

      expect(result.assignments).toEqual([{ conversationId: "conv_match123", isPrimary: true }])
      expect(result.confidence).toBe(0.92)
    })

    test("handles response for new conversation", async () => {
      const context = createMockContext()

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [{ conversationId: null, isPrimary: true }],
          newConversationTopic: "New topic from LLM",
          confidence: 0.88,
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      const result = await extractor.extract(context)

      expect(result.assignments).toEqual([{ conversationId: null, isPrimary: true }])
      expect(result.newConversationTopic).toBe("New topic from LLM")
      expect(result.confidence).toBe(0.88)
    })

    test("handles multi-membership with primary + secondary", async () => {
      const convA = createMockConversation({ id: "conv_a" })
      const convB = createMockConversation({ id: "conv_b" })
      const context = createMockContext({
        activeConversations: [convA, convB],
      })

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [
            { conversationId: "conv_a", isPrimary: true },
            { conversationId: "conv_b", isPrimary: false },
          ],
          confidence: 0.85,
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      const result = await extractor.extract(context)

      expect(result.assignments).toHaveLength(2)
      expect(result.assignments[0]).toEqual({ conversationId: "conv_a", isPrimary: true })
      expect(result.assignments[1]).toEqual({ conversationId: "conv_b", isPrimary: false })
    })

    test("demotes extra primaries to secondaries when LLM returns multiple", async () => {
      const convA = createMockConversation({ id: "conv_a" })
      const convB = createMockConversation({ id: "conv_b" })
      const context = createMockContext({
        activeConversations: [convA, convB],
      })

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [
            { conversationId: "conv_a", isPrimary: true },
            { conversationId: "conv_b", isPrimary: true },
          ],
          confidence: 0.8,
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      const result = await extractor.extract(context)

      const primaries = result.assignments.filter((a) => a.isPrimary)
      expect(primaries).toHaveLength(1)
      expect(primaries[0].conversationId).toBe("conv_a")
    })

    test("handles completeness updates", async () => {
      const existingConv = createMockConversation({ id: "conv_update123" })
      const context = createMockContext({
        activeConversations: [existingConv],
      })

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [{ conversationId: "conv_update123", isPrimary: true }],
          confidence: 0.95,
          completenessUpdates: [{ conversationId: "conv_update123", score: 6, status: "resolved" }],
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      const result = await extractor.extract(context)

      expect(result.completenessUpdates).toBeDefined()
      expect(result.completenessUpdates?.length).toBe(1)
      expect(result.completenessUpdates?.[0].score).toBe(6)
      expect(result.completenessUpdates?.[0].status).toBe("resolved")
    })

    test("accepts valid reassignments within the candidate set", async () => {
      const existingConv = createMockConversation({
        id: "conv_existing",
        contextMessageIds: ["msg_prior1"],
      })
      const recentMsg = createMockMessage({ id: "msg_recent" })
      const context = createMockContext({
        activeConversations: [existingConv],
        recentMessages: [recentMsg, createMockMessage({ id: "msg_test123" })],
      })

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [{ conversationId: null, isPrimary: true }],
          newConversationTopic: "New topic emerges",
          reassignments: [
            { messageId: "msg_prior1", toConversationId: null, reason: "actually about new topic", confidence: 0.8 },
            {
              messageId: "msg_recent",
              toConversationId: "conv_existing",
              reason: "fits existing topic",
              confidence: 0.9,
            },
          ],
          confidence: 0.85,
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      const result = await extractor.extract(context)

      expect(result.reassignments).toEqual([
        { messageId: "msg_prior1", toConversationId: null, reason: "actually about new topic", confidence: 0.8 },
        { messageId: "msg_recent", toConversationId: "conv_existing", reason: "fits existing topic", confidence: 0.9 },
      ])
    })

    test("accepts reassignment of a parent-thread context message", async () => {
      const parentConv = createMockConversation({
        id: "conv_parent",
        contextMessageIds: ["msg_parent_ctx"],
      })
      const activeConv = createMockConversation({ id: "conv_active" })
      const context = createMockContext({
        streamType: "thread",
        activeConversations: [activeConv],
        parentMessageConversations: [parentConv],
      })

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [{ conversationId: "conv_active", isPrimary: true }],
          reassignments: [
            {
              messageId: "msg_parent_ctx",
              toConversationId: "conv_active",
              reason: "belongs to thread topic",
              confidence: 0.8,
            },
          ],
          confidence: 0.9,
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      const result = await extractor.extract(context)

      expect(result.reassignments).toEqual([
        {
          messageId: "msg_parent_ctx",
          toConversationId: "conv_active",
          reason: "belongs to thread topic",
          confidence: 0.8,
        },
      ])
    })

    test("drops reassignments whose messageId is not in the candidate set", async () => {
      const existingConv = createMockConversation({ id: "conv_existing", contextMessageIds: ["msg_prior1"] })
      const context = createMockContext({
        activeConversations: [existingConv],
      })

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [{ conversationId: "conv_existing", isPrimary: true }],
          reassignments: [
            { messageId: "msg_unknown", toConversationId: "conv_existing", reason: "out of scope", confidence: 0.7 },
          ],
          confidence: 0.85,
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      const result = await extractor.extract(context)

      expect(result.reassignments).toBeUndefined()
    })

    test("drops reassignments whose toConversationId is not valid", async () => {
      const existingConv = createMockConversation({ id: "conv_existing", contextMessageIds: ["msg_prior1"] })
      const context = createMockContext({
        activeConversations: [existingConv],
      })

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [{ conversationId: "conv_existing", isPrimary: true }],
          reassignments: [
            { messageId: "msg_prior1", toConversationId: "conv_hallucinated", reason: "no such conv", confidence: 0.7 },
          ],
          confidence: 0.85,
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      const result = await extractor.extract(context)

      expect(result.reassignments).toBeUndefined()
    })
  })

  describe("error handling", () => {
    test("propagates API errors for retry handling", async () => {
      const context = createMockContext({
        newMessage: createMockMessage({ contentMarkdown: "Error fallback topic" }),
      })

      mockGenerateObject.mockRejectedValueOnce(new Error("API error"))

      await expect(extractor.extract(context)).rejects.toThrow("API error")
    })

    test("handles NoObjectGeneratedError gracefully with new conversation", async () => {
      const context = createMockContext({
        newMessage: createMockMessage({ contentMarkdown: "Parsing error topic here" }),
      })

      const parseError = new NoObjectGeneratedError({
        message: "No object generated",
        text: "```json\n{...}\n```",
        response: { id: "test", modelId: "test", timestamp: new Date(), headers: {} },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        finishReason: "stop",
      })
      mockGenerateObject.mockRejectedValueOnce(parseError)

      const result = await extractor.extract(context)

      expect(result.assignments).toEqual([{ conversationId: null, isPrimary: true }])
      expect(result.newConversationTopic).toBe("Parsing error topic here")
      expect(result.confidence).toBe(0.5)
    })

    test("treats invalid conversation ID as new conversation", async () => {
      const existingConv = createMockConversation({ id: "conv_real123" })
      const context = createMockContext({
        activeConversations: [existingConv],
        newMessage: createMockMessage({ contentMarkdown: "New topic content" }),
      })

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [{ conversationId: "conv_hallucinated_id", isPrimary: true }],
          confidence: 0.8,
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      const result = await extractor.extract(context)

      expect(result.assignments).toEqual([{ conversationId: null, isPrimary: true }])
      expect(result.newConversationTopic).toBe("New topic content")
    })
  })

  describe("topic extraction (thread cold-start path)", () => {
    test("extracts first sentence as topic", async () => {
      const context = createMockContext({
        streamType: "thread",
        activeConversations: [],
        newMessage: createMockMessage({
          contentMarkdown: "This is the first sentence. This is the second sentence.",
        }),
      })

      const result = await extractor.extract(context)

      expect(result.newConversationTopic).toBe("This is the first sentence")
    })

    test("handles messages ending with question mark", async () => {
      const context = createMockContext({
        streamType: "thread",
        activeConversations: [],
        newMessage: createMockMessage({
          contentMarkdown: "How do we handle this? I'm not sure about it.",
        }),
      })

      const result = await extractor.extract(context)

      expect(result.newConversationTopic).toBe("How do we handle this")
    })

    test("handles messages ending with exclamation", async () => {
      const context = createMockContext({
        streamType: "thread",
        activeConversations: [],
        newMessage: createMockMessage({
          contentMarkdown: "This is exciting news! Can't wait to share more.",
        }),
      })

      const result = await extractor.extract(context)

      expect(result.newConversationTopic).toBe("This is exciting news")
    })

    test("handles newline-separated content", async () => {
      const context = createMockContext({
        streamType: "thread",
        activeConversations: [],
        newMessage: createMockMessage({
          contentMarkdown: "First line here\nSecond line here\nThird line",
        }),
      })

      const result = await extractor.extract(context)

      expect(result.newConversationTopic).toBe("First line here")
    })

    test("truncates very long topics to 100 characters", async () => {
      const longContent = "A".repeat(200)
      const context = createMockContext({
        streamType: "thread",
        activeConversations: [],
        newMessage: createMockMessage({ contentMarkdown: longContent }),
      })

      const result = await extractor.extract(context)

      expect(result.newConversationTopic?.length).toBe(100)
    })
  })
})
