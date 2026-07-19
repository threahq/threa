import { describe, it, expect, mock, spyOn } from "bun:test"
import * as aiSdk from "ai"
import { createAI, type AccessLogSink } from "./ai"

const embedResponse = { embedding: [0.1, 0.2, 0.3], usage: { tokens: 3 } }
const embedManyResponse = { embeddings: [[0.1], [0.2]], usage: { tokens: 6 } }

describe("access-log disclose sink", () => {
  it("invokes the sink with provider/model/context after an embed call", async () => {
    const embedSpy = spyOn(aiSdk, "embed").mockResolvedValue(embedResponse as never)
    const record = mock((_event: Parameters<AccessLogSink["record"]>[0]) => {})
    const ai = createAI({ openrouter: { apiKey: "test-key" }, accessLogSink: { record } })

    try {
      await ai.embed({
        model: "openrouter:openai/text-embedding-3-small",
        value: "hello",
        telemetry: { functionId: "message-embedding" },
        context: { workspaceId: "ws_1", userId: "usr_1", sessionId: "ses_1" },
      })
    } finally {
      embedSpy.mockRestore()
    }

    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0]).toEqual({
      functionId: "message-embedding",
      provider: "openrouter",
      modelId: "openai/text-embedding-3-small",
      context: { workspaceId: "ws_1", userId: "usr_1", sessionId: "ses_1" },
      metadata: undefined,
    })
  })

  it("forwards embedMany batch count in metadata", async () => {
    const embedManySpy = spyOn(aiSdk, "embedMany").mockResolvedValue(embedManyResponse as never)
    const record = mock((_event: Parameters<AccessLogSink["record"]>[0]) => {})
    const ai = createAI({ openrouter: { apiKey: "test-key" }, accessLogSink: { record } })

    try {
      await ai.embedMany({
        model: "openrouter:openai/text-embedding-3-small",
        values: ["a", "b"],
        telemetry: { functionId: "message-embedding" },
        context: { workspaceId: "ws_1" },
      })
    } finally {
      embedManySpy.mockRestore()
    }

    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0]).toMatchObject({
      functionId: "message-embedding",
      provider: "openrouter",
      modelId: "openai/text-embedding-3-small",
      metadata: { count: 2 },
    })
  })

  it("is a no-op when no sink is configured", async () => {
    const embedSpy = spyOn(aiSdk, "embed").mockResolvedValue(embedResponse as never)
    const ai = createAI({ openrouter: { apiKey: "test-key" } })

    try {
      await expect(
        ai.embed({
          model: "openrouter:openai/text-embedding-3-small",
          value: "hello",
          context: { workspaceId: "ws_1" },
        })
      ).resolves.toMatchObject({ value: embedResponse.embedding })
    } finally {
      embedSpy.mockRestore()
    }
  })

  it("swallows a throwing sink so the AI call still succeeds", async () => {
    const embedSpy = spyOn(aiSdk, "embed").mockResolvedValue(embedResponse as never)
    const record = mock((_event: Parameters<AccessLogSink["record"]>[0]) => {
      throw new Error("sink boom")
    })
    const ai = createAI({ openrouter: { apiKey: "test-key" }, accessLogSink: { record } })

    try {
      await expect(
        ai.embed({
          model: "openrouter:openai/text-embedding-3-small",
          value: "hello",
          context: { workspaceId: "ws_1" },
        })
      ).resolves.toMatchObject({ value: embedResponse.embedding })
    } finally {
      embedSpy.mockRestore()
    }

    expect(record).toHaveBeenCalledTimes(1)
  })

  it("swallows a sink that returns a rejected promise so the AI call still succeeds", async () => {
    const embedSpy = spyOn(aiSdk, "embed").mockResolvedValue(embedResponse as never)
    const record = mock((_event: Parameters<AccessLogSink["record"]>[0]) =>
      Promise.reject(new Error("async sink boom"))
    )
    const ai = createAI({ openrouter: { apiKey: "test-key" }, accessLogSink: { record } })

    try {
      await expect(
        ai.embed({
          model: "openrouter:openai/text-embedding-3-small",
          value: "hello",
          context: { workspaceId: "ws_1" },
        })
      ).resolves.toMatchObject({ value: embedResponse.embedding })
    } finally {
      embedSpy.mockRestore()
    }

    expect(record).toHaveBeenCalledTimes(1)
  })

  it("discloses at send time: sink fires even when the provider call rejects, and the rejection still propagates", async () => {
    const embedSpy = spyOn(aiSdk, "embed").mockRejectedValue(new Error("provider boom"))
    const record = mock((_event: Parameters<AccessLogSink["record"]>[0]) => {})
    const ai = createAI({ openrouter: { apiKey: "test-key" }, accessLogSink: { record } })

    try {
      await expect(
        ai.embed({
          model: "openrouter:openai/text-embedding-3-small",
          value: "hello",
          telemetry: { functionId: "message-embedding" },
          context: { workspaceId: "ws_1" },
        })
      ).rejects.toThrow("provider boom")
    } finally {
      embedSpy.mockRestore()
    }

    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0]).toMatchObject({
      functionId: "message-embedding",
      provider: "openrouter",
      modelId: "openai/text-embedding-3-small",
    })
  })
})
