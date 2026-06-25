import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { AI } from "@threa/agent-runtime"
import type { Message } from "../messaging"
import { MessageRepository } from "../messaging"
import { ConversationSummaryRepository } from "./conversation-summary-repository"
import { ConversationSummaryService } from "./conversation-summary-service"

function makeMessage(sequence: bigint, content: string): Message {
  return {
    id: `msg_${sequence.toString()}`,
    streamId: "stream_1",
    sequence,
    authorId: "usr_1",
    authorType: "user",
    contentJson: { type: "doc", content: [] },
    contentMarkdown: content,
    replyCount: 0,
    reactions: {},
    metadata: {},
    conversationIntent: null,
    clientMessageId: null,
    sentVia: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
  }
}

describe("ConversationSummaryService", () => {
  // Module-level spies on shared repositories leak past this file's tests
  // unless we tear them down. Bun's `spyOn` returns the existing spy when a
  // method is already patched, so a downstream file calling
  // `spyOn(MessageRepository, "list")` would inherit our call history and
  // break `expect(...).not.toHaveBeenCalled()` assertions.
  afterAll(() => mock.restore())

  const TEST_MODEL_ID = "openrouter:anthropic/claude-haiku-4.5"
  const TEST_TEMPERATURE = 0.1

  // The companion folds through the shared `foldRollingSummary`, which calls
  // `generateTextWithTools` (the narrow surface the enclave shares) rather than
  // `generateObject` — so the summary is plain text, not a schema'd object.
  const mockGenerateText = mock((_options: unknown) =>
    Promise.resolve({
      text: "Updated summary with key decisions and pending task",
      toolCalls: [],
      response: { messages: [] },
    })
  )
  const mockAI = {
    generateTextWithTools: mockGenerateText,
    getLanguageModel: mock((_modelId: string) => ({}) as unknown),
  } as unknown as AI

  const findSummarySpy = spyOn(ConversationSummaryRepository, "findByStreamAndPersona")
  const upsertSummarySpy = spyOn(ConversationSummaryRepository, "upsert")
  const listMessagesSpy = spyOn(MessageRepository, "list")
  const listByRangeSpy = spyOn(MessageRepository, "listBySequenceRange")

  beforeEach(() => {
    mockGenerateText.mockClear()
    findSummarySpy.mockClear()
    upsertSummarySpy.mockClear()
    listMessagesSpy.mockClear()
    listByRangeSpy.mockClear()
    findSummarySpy.mockResolvedValue(null)
    upsertSummarySpy.mockResolvedValue({
      id: "agsum_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      personaId: "persona_1",
      summary: "Updated summary with key decisions and pending task",
      sealed: null,
      lastSummarizedSequence: 20n,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    })
    listMessagesSpy.mockResolvedValue([])
    listByRangeSpy.mockResolvedValue([])
  })

  test("summarizes dropped messages and persists rolling summary state", async () => {
    const service = new ConversationSummaryService({
      ai: mockAI,
      modelId: TEST_MODEL_ID,
      temperature: TEST_TEMPERATURE,
    })
    const keptMessages = [makeMessage(21n, "Most recent context that remains in window")]
    const droppedMessages = Array.from({ length: 20 }, (_, idx) =>
      makeMessage(BigInt(idx + 1), `Older message ${idx + 1}`)
    )

    listMessagesSpy.mockResolvedValue([makeMessage(20n, "Older boundary message")])
    listByRangeSpy.mockResolvedValue(droppedMessages)

    const summary = await service.updateForContext({
      db: {} as any,
      workspaceId: "ws_1",
      streamId: "stream_1",
      personaId: "persona_1",
      keptMessages,
    })

    expect(summary).toBe("Updated summary with key decisions and pending task")
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    expect(listByRangeSpy).toHaveBeenCalledWith({}, "stream_1", 1n, 20n, { limit: 40 })
    expect(upsertSummarySpy).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceId: "ws_1",
        streamId: "stream_1",
        personaId: "persona_1",
        lastSummarizedSequence: 20n,
      })
    )
  })

  test("only summarizes messages after the persisted cursor", async () => {
    const service = new ConversationSummaryService({
      ai: mockAI,
      modelId: TEST_MODEL_ID,
      temperature: TEST_TEMPERATURE,
    })
    const keptMessages = [makeMessage(80n, "Recent message")]

    findSummarySpy.mockResolvedValue({
      id: "agsum_existing",
      workspaceId: "ws_1",
      streamId: "stream_1",
      personaId: "persona_1",
      summary: "Existing summary of older context",
      sealed: null,
      lastSummarizedSequence: 50n,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    })
    listMessagesSpy.mockResolvedValue([makeMessage(79n, "Older boundary message")])
    listByRangeSpy
      .mockResolvedValueOnce([
        makeMessage(51n, "Message after cursor"),
        makeMessage(52n, "Another message after cursor"),
      ])
      .mockResolvedValueOnce([])

    await service.updateForContext({
      db: {} as any,
      workspaceId: "ws_1",
      streamId: "stream_1",
      personaId: "persona_1",
      keptMessages,
    })

    expect(listByRangeSpy).toHaveBeenCalledWith({}, "stream_1", 51n, 79n, { limit: 40 })
    // The fold carries the cost-attribution context and telemetry through to the
    // shared `generateTextWithTools` call, and folds the prior summary in (so the
    // running memory accumulates rather than restarting each batch).
    const firstFoldCall = mockGenerateText.mock.calls[0]?.[0] as
      | { context?: unknown; telemetry?: unknown; temperature?: number; messages?: { content: string }[] }
      | undefined
    expect(firstFoldCall).toMatchObject({
      context: { workspaceId: "ws_1", origin: "system" },
      telemetry: { functionId: "summary-update" },
      temperature: TEST_TEMPERATURE,
    })
    expect(firstFoldCall?.messages?.[0]?.content).toContain("Existing summary of older context")
  })

  test("returns existing summary without AI call when no new dropped messages need summarization", async () => {
    const service = new ConversationSummaryService({
      ai: mockAI,
      modelId: TEST_MODEL_ID,
      temperature: TEST_TEMPERATURE,
    })
    const keptMessages = [makeMessage(60n, "Recent message")]

    findSummarySpy.mockResolvedValue({
      id: "agsum_existing",
      workspaceId: "ws_1",
      streamId: "stream_1",
      personaId: "persona_1",
      summary: "Existing summary",
      sealed: null,
      lastSummarizedSequence: 59n,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    })
    listMessagesSpy.mockResolvedValue([makeMessage(59n, "Older boundary message")])

    const summary = await service.updateForContext({
      db: {} as any,
      workspaceId: "ws_1",
      streamId: "stream_1",
      personaId: "persona_1",
      keptMessages,
    })

    expect(summary).toBe("Existing summary")
    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(upsertSummarySpy).not.toHaveBeenCalled()
  })

  test("does not throw when summary generation fails", async () => {
    const service = new ConversationSummaryService({
      ai: mockAI,
      modelId: TEST_MODEL_ID,
      temperature: TEST_TEMPERATURE,
    })
    const keptMessages = [makeMessage(30n, "Recent message")]

    findSummarySpy.mockResolvedValue({
      id: "agsum_existing",
      workspaceId: "ws_1",
      streamId: "stream_1",
      personaId: "persona_1",
      summary: "Existing summary",
      sealed: null,
      lastSummarizedSequence: 10n,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    })
    listMessagesSpy.mockResolvedValue([makeMessage(29n, "Older boundary message")])
    listByRangeSpy.mockResolvedValue([makeMessage(11n, "Dropped message that needs summarization")])
    mockGenerateText.mockRejectedValueOnce(new Error("No object generated"))

    const summary = await service.updateForContext({
      db: {} as any,
      workspaceId: "ws_1",
      streamId: "stream_1",
      personaId: "persona_1",
      keptMessages,
    })

    expect(summary).toBe("Existing summary")
    expect(upsertSummarySpy).not.toHaveBeenCalled()
  })

  test("refuses to overwrite a sealed (E2E) summary row", async () => {
    const service = new ConversationSummaryService({
      ai: mockAI,
      modelId: TEST_MODEL_ID,
      temperature: TEST_TEMPERATURE,
    })

    findSummarySpy.mockResolvedValue({
      id: "agsum_sealed",
      workspaceId: "ws_1",
      streamId: "stream_1",
      personaId: "persona_1",
      summary: null,
      sealed: {
        ciphertext: "Y2lwaGVydGV4dA==",
        envelope: { v: 2, keyGeneration: 0, iv: "aXYxMjM0NTY3OA==", aad: "YWFk" },
        keyGeneration: 0,
      },
      lastSummarizedSequence: 30n,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    })
    listMessagesSpy.mockResolvedValue([makeMessage(29n, "Older boundary message")])
    listByRangeSpy.mockResolvedValue([makeMessage(11n, "Dropped message")])

    const summary = await service.updateForContext({
      db: {} as any,
      workspaceId: "ws_1",
      streamId: "stream_1",
      personaId: "persona_1",
      keptMessages: [makeMessage(31n, "Recent message")],
    })

    expect(summary).toBeNull()
    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(upsertSummarySpy).not.toHaveBeenCalled()
  })
})
