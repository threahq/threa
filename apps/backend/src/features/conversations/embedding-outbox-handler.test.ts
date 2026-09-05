import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { E2eStreamsRepository } from "../e2e-streams"
import { JobQueues } from "../../lib/queue"
import { ConversationEmbeddingHandler } from "./embedding-outbox-handler"
import type { OutboxEvent } from "../../lib/outbox"

class TestableHandler extends ConversationEmbeddingHandler {
  run(event: OutboxEvent): Promise<void> {
    return this["processEvent"](event)
  }
}

function conversationEvent(
  eventType: "conversation:created" | "conversation:updated",
  overrides: Partial<Record<string, unknown>> = {},
  conversationOverrides: Partial<Record<string, unknown>> = {}
): OutboxEvent {
  return {
    id: 1n,
    eventType,
    createdAt: new Date(),
    payload: {
      workspaceId: "ws_1",
      streamId: "stream_x",
      conversationId: "conv_1",
      conversation: {
        id: "conv_1",
        streamId: "stream_x",
        topicSummary: "Choosing the launch date",
        summary: null,
        messageIds: ["msg_1"],
        ...conversationOverrides,
      },
      ...overrides,
    },
  } as unknown as OutboxEvent
}

describe("ConversationEmbeddingHandler", () => {
  afterEach(() => mock.restore())

  function arrange(isE2eStream = false) {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(isE2eStream)
    const jobQueue = { send: mock() }
    const handler = new TestableHandler({} as any, jobQueue as any)
    return { handler, jobQueue }
  }

  it("enqueues an embedding job when a summarized conversation is created or updated", async () => {
    const { handler, jobQueue } = arrange()

    await handler.run(conversationEvent("conversation:created"))
    await handler.run(conversationEvent("conversation:updated"))

    expect(jobQueue.send.mock.calls).toEqual([
      [JobQueues.CONVERSATION_EMBEDDING_GENERATE, { conversationId: "conv_1", workspaceId: "ws_1" }],
      [JobQueues.CONVERSATION_EMBEDDING_GENERATE, { conversationId: "conv_1", workspaceId: "ws_1" }],
    ])
  })

  it("skips conversations that have no summary text yet", async () => {
    const { handler, jobQueue } = arrange()

    await handler.run(conversationEvent("conversation:created", {}, { topicSummary: null, summary: null }))

    expect(jobQueue.send).not.toHaveBeenCalled()
  })

  it("skips staleness-sweep status updates, which carry no new text", async () => {
    const { handler, jobQueue } = arrange()

    await handler.run(conversationEvent("conversation:updated", { origin: "staleness-sweep" }))

    expect(jobQueue.send).not.toHaveBeenCalled()
  })

  it("skips sealed streams", async () => {
    const { handler, jobQueue } = arrange(true)

    await handler.run(conversationEvent("conversation:updated"))

    expect(jobQueue.send).not.toHaveBeenCalled()
  })

  it("ignores unrelated events", async () => {
    const { handler, jobQueue } = arrange()

    await handler.run({ ...conversationEvent("conversation:created"), eventType: "message:created" } as OutboxEvent)

    expect(jobQueue.send).not.toHaveBeenCalled()
  })
})
