import { describe, test, expect, mock, beforeEach } from "bun:test"
import { LLMBoundaryExtractor, formatRelativeAge } from "./llm-extractor"
import type { ExtractionContext, ConversationSummary } from "./types"
import type { Message } from "../../messaging"
import type { AI } from "@threa/agent-runtime"
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
    conversationIntent: null,
    clientMessageId: null,
    sentVia: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
    ...overrides,
  }
}

function createMockConversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: "conv_existing123",
    topicSummary: "Existing conversation topic",
    summary: null,
    messageCount: 5,
    lastMessagePreview: "Last message preview",
    participantIds: ["usr_test"],
    completenessScore: 3,
    status: "active",
    lastActivityAt: new Date(),
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

  describe("attachment context", () => {
    test("includes new-message attachment fullText in the prompt", async () => {
      const newMessage = createMockMessage({ id: "msg_with_attachment", contentMarkdown: "voice memo" })
      const existingConv = createMockConversation({ id: "conv_existing" })
      const context = createMockContext({
        streamType: "channel",
        newMessage,
        recentMessages: [newMessage],
        activeConversations: [existingConv],
        attachmentsByMessageId: new Map([
          [
            "msg_with_attachment",
            [
              {
                filename: "onboarding.m4a",
                mimeType: "audio/mp4",
                contentType: "audio",
                summary: "Short audio about onboarding",
                fullText: "Hey team, today I want to talk about how we onboard new engineers.",
              },
            ],
          ],
        ]),
      })

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [{ conversationId: "conv_existing", isPrimary: true }],
          confidence: 0.9,
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      await extractor.extract(context)

      expect(mockGenerateObject).toHaveBeenCalledTimes(1)
      const calls = mockGenerateObject.mock.calls as unknown as Array<
        [{ messages: { role: string; content: string }[] }]
      >
      const call = calls[0]?.[0] ?? { messages: [] }
      const userPrompt = call.messages.find((m) => m.role === "user")?.content ?? ""
      expect(userPrompt).toContain("onboarding.m4a")
      expect(userPrompt).toContain("Hey team, today I want to talk about how we onboard new engineers.")
    })

    test("uses summary (not fullText) for context messages even when fullText is provided", async () => {
      const newMessage = createMockMessage({ id: "msg_new", contentMarkdown: "follow up" })
      const contextMessage = createMockMessage({ id: "msg_ctx", contentMarkdown: "" })
      const existingConv = createMockConversation({ id: "conv_existing" })
      const context = createMockContext({
        streamType: "channel",
        newMessage,
        recentMessages: [contextMessage, newMessage],
        activeConversations: [existingConv],
        attachmentsByMessageId: new Map([
          [
            "msg_ctx",
            [
              {
                filename: "old.pdf",
                mimeType: "application/pdf",
                contentType: "pdf",
                summary: "Quarterly results overview",
                // Service strips fullText for non-new messages before passing
                // it to the extractor, so simulate that here.
                fullText: null,
              },
            ],
          ],
        ]),
      })

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [{ conversationId: "conv_existing", isPrimary: true }],
          confidence: 0.85,
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      await extractor.extract(context)

      const calls = mockGenerateObject.mock.calls as unknown as Array<
        [{ messages: { role: string; content: string }[] }]
      >
      const call = calls[0]?.[0] ?? { messages: [] }
      const userPrompt = call.messages.find((m) => m.role === "user")?.content ?? ""
      expect(userPrompt).toContain("old.pdf")
      expect(userPrompt).toContain("Quarterly results overview")
    })

    test("truncates very long attachment text in the new-message block", async () => {
      const longTranscript = "x".repeat(5000)
      const newMessage = createMockMessage({ id: "msg_long", contentMarkdown: "see attached" })
      const existingConv = createMockConversation({ id: "conv_existing" })
      const context = createMockContext({
        streamType: "channel",
        newMessage,
        recentMessages: [newMessage],
        activeConversations: [existingConv],
        attachmentsByMessageId: new Map([
          [
            "msg_long",
            [
              {
                filename: "long.m4a",
                mimeType: "audio/mp4",
                contentType: "audio",
                summary: null,
                fullText: longTranscript,
              },
            ],
          ],
        ]),
      })

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [{ conversationId: "conv_existing", isPrimary: true }],
          confidence: 0.9,
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      await extractor.extract(context)

      const calls = mockGenerateObject.mock.calls as unknown as Array<
        [{ messages: { role: string; content: string }[] }]
      >
      const call = calls[0]?.[0] ?? { messages: [] }
      const userPrompt = call.messages.find((m) => m.role === "user")?.content ?? ""
      expect(userPrompt).toContain("long.m4a")
      // Long transcript must be capped; we should not see the entire 5000-char body inline.
      const xCount = (userPrompt.match(/x/g) ?? []).length
      expect(xCount).toBeLessThan(longTranscript.length)
      expect(userPrompt).toContain("…")
    })

    test("omits attachment block when extraction has neither summary nor fullText", async () => {
      const newMessage = createMockMessage({ id: "msg_empty", contentMarkdown: "ping" })
      const existingConv = createMockConversation({ id: "conv_existing" })
      const context = createMockContext({
        streamType: "channel",
        newMessage,
        recentMessages: [newMessage],
        activeConversations: [existingConv],
        attachmentsByMessageId: new Map(),
      })

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [{ conversationId: "conv_existing", isPrimary: true }],
          confidence: 0.9,
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      await extractor.extract(context)

      const calls = mockGenerateObject.mock.calls as unknown as Array<
        [{ messages: { role: string; content: string }[] }]
      >
      const call = calls[0]?.[0] ?? { messages: [] }
      const userPrompt = call.messages.find((m) => m.role === "user")?.content ?? ""
      // The rendered (not instructional) attachment line lives directly under
      // the message line with a 2-space indent. No rendered block here means
      // no `  [attachment ` anywhere in the prompt.
      expect(userPrompt).not.toContain("  [attachment ")
    })
  })

  describe("temporal context in prompt", () => {
    test("renders message ages and conversation last-activity relative to the new message", async () => {
      const now = new Date("2026-07-01T12:00:00Z")
      const newMessage = createMockMessage({ id: "msg_new", contentMarkdown: "helt orelaterat ämne", createdAt: now })
      const staleMessage = createMockMessage({
        id: "msg_stale",
        contentMarkdown: "gårdagens sista meddelande",
        createdAt: new Date("2026-06-30T10:00:00Z"), // 26h before
      })
      const staleConv = createMockConversation({
        id: "conv_stale",
        lastActivityAt: new Date("2026-06-30T10:00:00Z"),
      })
      const context = createMockContext({
        streamType: "dm",
        newMessage,
        recentMessages: [staleMessage],
        activeConversations: [staleConv],
      })

      mockGenerateObject.mockResolvedValueOnce({
        value: {
          assignments: [{ conversationId: null, isPrimary: true }],
          newConversationTopic: "Nytt ämne",
          confidence: 0.9,
        },
        response: { usage: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })

      await extractor.extract(context)

      const calls = mockGenerateObject.mock.calls as unknown as Array<
        [{ messages: { role: string; content: string }[] }]
      >
      const call = calls[0]?.[0] ?? { messages: [] }
      const userPrompt = call.messages.find((m) => m.role === "user")?.content ?? ""
      expect(userPrompt).toContain("[msg_stale] (26h ago)")
      expect(userPrompt).toContain("last active 26h ago")
    })
  })
})

describe("LLMBoundaryExtractor.splitConversation", () => {
  let extractor: LLMBoundaryExtractor

  beforeEach(() => {
    mockGenerateObject.mockReset()
    extractor = new LLMBoundaryExtractor(mockAI as AI, mockConfigResolver)
  })

  function splitContext(ids: string[]) {
    return {
      conversationId: "conv_split",
      topicSummary: "Fable",
      summary: null,
      messages: ids.map((id, i) =>
        createMockMessage({ id, contentMarkdown: `msg ${id}`, createdAt: new Date(1_700_000_000_000 + i * 60_000) })
      ),
      streamType: "channel",
      workspaceId: "wsp_test123",
    }
  }

  test("returns a single group without an AI call for a short conversation", async () => {
    const result = await extractor.splitConversation(splitContext(["m1", "m2", "m3"]))
    expect(mockGenerateObject).not.toHaveBeenCalled()
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].messageIds).toEqual(["m1", "m2", "m3"])
  })

  test("handles an empty conversation without dereferencing a missing message", async () => {
    // A resolved/emptied thread-split shell: no messages, no topic. Must not throw.
    const result = await extractor.splitConversation({
      conversationId: "conv_empty",
      topicSummary: null,
      summary: null,
      messages: [],
      streamType: "channel",
      workspaceId: "wsp_test123",
    })
    expect(mockGenerateObject).not.toHaveBeenCalled()
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].messageIds).toEqual([])
    expect(result.groups[0].title).toBe("Conversation")
  })

  test("bounds the prompt to the most recent messages for an oversized conversation", async () => {
    const ids = Array.from({ length: 320 }, (_, i) => `m${i}`)
    mockGenerateObject.mockResolvedValueOnce({
      value: {
        groups: [{ title: "Only topic", summary: null, messageIds: ["m319"] }],
        confidence: 0.5,
        reasoning: null,
      },
      response: { usage: {} },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })

    const result = await extractor.splitConversation(splitContext(ids))

    // The prompt (2nd message = the user turn) names only the last 300 ids —
    // m19..m319, never m0.
    const call = mockGenerateObject.mock.calls[0] as unknown as [{ messages: { content: string }[] }]
    const userPrompt = call[0].messages[1].content
    expect(userPrompt).toContain("[m319]")
    expect(userPrompt).not.toContain("[m0]")
    // Validation is scoped to that window, so the swept partition never references
    // the dropped older ids.
    const allIds = result.groups.flatMap((g) => g.messageIds)
    expect(allIds).not.toContain("m0")
    expect(allIds.length).toBe(300)
  })

  test("partitions the model's groups and orders them largest-first", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      value: {
        groups: [
          { title: "Small", summary: null, messageIds: ["m1"] },
          { title: "Big", summary: "the bulk", messageIds: ["m2", "m3", "m4"] },
        ],
        confidence: 0.8,
        reasoning: "two topics",
      },
      response: { usage: {} },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })

    const result = await extractor.splitConversation(splitContext(["m1", "m2", "m3", "m4"]))

    expect(result.groups.map((g) => g.title)).toEqual(["Big", "Small"])
    expect(result.groups[0].messageIds).toEqual(["m2", "m3", "m4"])
    expect(result.groups[1].messageIds).toEqual(["m1"])
  })

  test("drops unknown ids, dedupes across groups, and sweeps unassigned into the largest group", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      value: {
        groups: [
          { title: "A", summary: null, messageIds: ["m1", "m2", "ghost"] },
          // m2 repeated (first group wins); m5 unknown; m3 legitimately in B.
          { title: "B", summary: null, messageIds: ["m2", "m3", "m5"] },
        ],
        confidence: 0.7,
        reasoning: null,
      },
      response: { usage: {} },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })

    // m4 is never mentioned by the model → swept into the largest group.
    const result = await extractor.splitConversation(splitContext(["m1", "m2", "m3", "m4"]))

    const allAssigned = result.groups.flatMap((g) => g.messageIds).sort()
    expect(allAssigned).toEqual(["m1", "m2", "m3", "m4"])
    // No id appears twice; no unknown id survives.
    expect(new Set(allAssigned).size).toBe(4)
    // Largest group ("A": m1,m2 + swept m4) leads.
    expect(result.groups[0].messageIds).toContain("m4")
  })

  test("degrades to a single group when the response is unparseable", async () => {
    mockGenerateObject.mockRejectedValueOnce(
      new NoObjectGeneratedError({
        message: "bad",
        text: "not json",
        response: {} as never,
        usage: {} as never,
        finishReason: "stop",
      })
    )
    const result = await extractor.splitConversation(splitContext(["m1", "m2", "m3", "m4"]))
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].messageIds).toEqual(["m1", "m2", "m3", "m4"])
  })
})

describe("formatRelativeAge", () => {
  const reference = new Date("2026-07-01T12:00:00Z")

  test("renders the age buckets used by the prompt", () => {
    const cases: [string, string][] = [
      ["2026-07-01T11:59:30Z", "just now"],
      ["2026-07-01T11:55:00Z", "5m ago"],
      ["2026-07-01T09:00:00Z", "3h ago"],
      ["2026-06-30T10:00:00Z", "26h ago"] as [string, string],
      ["2026-06-28T12:00:00Z", "3d ago"],
    ]
    const rendered = cases.map(([iso]) => formatRelativeAge(new Date(iso), reference))
    expect(rendered).toEqual(cases.map(([, expected]) => expected))
  })

  test("clamps messages at or after the reference to 'just now'", () => {
    // recentMessages includes MESSAGES_AFTER messages sent after the new one.
    expect(formatRelativeAge(new Date("2026-07-01T12:00:30Z"), reference)).toBe("just now")
  })
})
