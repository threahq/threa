import { describe, it, expect, mock, spyOn } from "bun:test"
import { createAiAccessLogSink } from "./ai-sink"
import type { AccessLogService, AccessLogEntry } from "./service"
import { logger } from "../../lib/logger"

function fakeService(): { record: ReturnType<typeof mock>; service: AccessLogService } {
  const record = mock((_entry: AccessLogEntry) => {})
  return { record, service: { record } as unknown as AccessLogService }
}

describe("createAiAccessLogSink", () => {
  it("attributes to the persona when metadata carries a personaId", () => {
    const { record, service } = fakeService()
    const sink = createAiAccessLogSink(service)

    sink.record({
      functionId: "agent-loop",
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4.5",
      context: { workspaceId: "ws_1", userId: "usr_9", sessionId: "ses_3" },
      metadata: { personaId: "persona_abc", model_id: "anthropic/claude-sonnet-4.5" },
    })

    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0]).toEqual({
      workspaceId: "ws_1",
      actorType: "persona",
      actorId: "persona_abc",
      onBehalfOfUserId: "usr_9",
      operation: "ai.agent-loop",
      accessKind: "disclose",
      outcome: "success",
      detail: { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", sessionId: "ses_3" },
    })
  })

  it("falls back to a system actor when no persona is threaded", () => {
    const { record, service } = fakeService()
    const sink = createAiAccessLogSink(service)

    sink.record({
      functionId: "memorize-conversation",
      provider: "openrouter",
      modelId: "openai/gpt-5.6",
      context: { workspaceId: "ws_1" },
    })

    expect(record.mock.calls[0][0]).toMatchObject({
      actorType: "system",
      actorId: "system:memorize-conversation",
      onBehalfOfUserId: null,
      operation: "ai.memorize-conversation",
    })
  })

  it("skips the row and warns when workspaceId is absent", () => {
    const { record, service } = fakeService()
    const warn = spyOn(logger, "warn")
    const sink = createAiAccessLogSink(service)

    try {
      sink.record({
        functionId: "message-embedding",
        provider: "openrouter",
        modelId: "openai/text-embedding-3-small",
        context: { userId: "usr_1" } as never,
      })

      expect(record).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it("records one row with a batch count for embedMany events", () => {
    const { record, service } = fakeService()
    const sink = createAiAccessLogSink(service)

    sink.record({
      functionId: "message-embedding",
      provider: "openrouter",
      modelId: "openai/text-embedding-3-small",
      context: { workspaceId: "ws_1" },
      metadata: { count: 42 },
    })

    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0]).toMatchObject({
      actorType: "system",
      actorId: "system:message-embedding",
      operation: "ai.message-embedding",
      accessKind: "disclose",
      detail: { provider: "openrouter", model: "openai/text-embedding-3-small", count: 42 },
    })
  })

  it("maps metadata.subjectRefs to the row's subjects", () => {
    const { record, service } = fakeService()
    const sink = createAiAccessLogSink(service)

    sink.record({
      functionId: "memorize-conversation",
      provider: "openrouter",
      modelId: "openai/gpt-5.6",
      context: { workspaceId: "ws_1" },
      metadata: {
        subjectRefs: [
          { type: "stream", id: "stream_1" },
          { type: "conversation", id: "conv_1" },
        ],
      },
    })

    expect(record.mock.calls[0][0].subjects).toEqual([
      { type: "stream", id: "stream_1" },
      { type: "conversation", id: "conv_1" },
    ])
  })

  it("ignores malformed subjectRefs entries and keeps the valid ones", () => {
    const { record, service } = fakeService()
    const sink = createAiAccessLogSink(service)

    sink.record({
      functionId: "agent-loop",
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4.5",
      context: { workspaceId: "ws_1" },
      metadata: {
        subjectRefs: [
          { type: "stream", id: "stream_1" },
          { type: "stream" },
          { id: "stream_2" },
          { type: 7, id: "stream_3" },
          "stream_4",
          null,
        ],
      },
    })

    expect(record.mock.calls[0][0].subjects).toEqual([{ type: "stream", id: "stream_1" }])
  })

  it("leaves subjects undefined when subjectRefs is absent or all-malformed", () => {
    const { record, service } = fakeService()
    const sink = createAiAccessLogSink(service)

    sink.record({
      functionId: "message-embedding",
      provider: "openrouter",
      modelId: "openai/text-embedding-3-small",
      context: { workspaceId: "ws_1" },
    })
    sink.record({
      functionId: "message-embedding",
      provider: "openrouter",
      modelId: "openai/text-embedding-3-small",
      context: { workspaceId: "ws_1" },
      metadata: { subjectRefs: [{ type: "stream" }, "nope"] },
    })

    expect(record.mock.calls[0][0].subjects).toBeUndefined()
    expect(record.mock.calls[1][0].subjects).toBeUndefined()
  })
})
