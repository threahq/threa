import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { AI } from "../../lib/ai/ai"
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

  const mockGenerateObject = mock((_options: unknown) =>
    Promise.resolve({
      value: { summary: "Updated summary with key decisions and pending task" },
      response: { usage: {} },
      usage: {},
    })
  )
  const mockAI = {
    generateObject: mockGenerateObject,
  } as unknown as AI

  const findSummarySpy = spyOn(ConversationSummaryRepository, "findByStreamAndPersona")
  const upsertSummarySpy = spyOn(ConversationSummaryRepository, "upsert")
  const listMessagesSpy = spyOn(MessageRepository, "list")
  const listByRangeSpy = spyOn(MessageRepository, "listBySequenceRange")

  beforeEach(() => {
    mockGenerateObject.mockClear()
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
    expect(mockGenerateObject).toHaveBeenCalledTimes(1)
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
    const firstGenerateObjectCall = mockGenerateObject.mock.calls[0]?.[0] as
      | { context?: unknown; telemetry?: unknown; repair?: ((args: { text: string }) => string) | false }
      | undefined
    expect(firstGenerateObjectCall).toMatchObject({
      context: { workspaceId: "ws_1", origin: "system" },
      telemetry: { functionId: "summary-update" },
    })
    const repairFn = firstGenerateObjectCall?.repair
    expect(typeof repairFn).toBe("function")
    if (typeof repairFn !== "function") {
      throw new Error("Expected repair function to be provided")
    }
    const repaired = await repairFn({
      text: "**Rolling Summary:**\n\nUser asked about fish identification.",
    })
    expect(repaired).toBe(JSON.stringify({ summary: "User asked about fish identification." }))
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
    expect(mockGenerateObject).not.toHaveBeenCalled()
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
      lastSummarizedSequence: 10n,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    })
    listMessagesSpy.mockResolvedValue([makeMessage(29n, "Older boundary message")])
    listByRangeSpy.mockResolvedValue([makeMessage(11n, "Dropped message that needs summarization")])
    mockGenerateObject.mockRejectedValueOnce(new Error("No object generated"))

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
})
