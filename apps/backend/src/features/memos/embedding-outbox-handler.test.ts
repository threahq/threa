import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { E2eStreamsRepository } from "../e2e-streams"
import { JobQueues } from "../../lib/queue"
import { EmbeddingHandler } from "./embedding-outbox-handler"
import type { OutboxEvent } from "../../lib/outbox"

class TestableEmbeddingHandler extends EmbeddingHandler {
  run(event: OutboxEvent): Promise<void> {
    return this["processEvent"](event)
  }
}

function assignmentEvent(overrides: Partial<Record<string, unknown>> = {}): OutboxEvent {
  return {
    id: 1n,
    eventType: "conversation:message_assigned",
    createdAt: new Date(),
    payload: {
      workspaceId: "ws_1",
      streamId: "stream_x",
      messageId: "msg_1",
      conversationId: "conv_1",
      isPrimary: true,
      reason: "extracted",
      ...overrides,
    },
  } as unknown as OutboxEvent
}

function reassignmentEvent(overrides: Partial<Record<string, unknown>> = {}): OutboxEvent {
  return {
    id: 2n,
    eventType: "conversation:message_reassigned",
    createdAt: new Date(),
    payload: {
      workspaceId: "ws_1",
      streamId: "stream_x",
      messageId: "msg_1",
      fromConversationId: "conv_1",
      toConversationId: "conv_2",
      reason: "extracted",
      ...overrides,
    },
  } as unknown as OutboxEvent
}

describe("EmbeddingHandler conversation assignment events", () => {
  afterEach(() => mock.restore())

  function arrange(isE2eStream: boolean) {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(isE2eStream)
    const jobQueue = { send: mock() }
    const handler = new TestableEmbeddingHandler({} as any, jobQueue as any)
    return { handler, jobQueue }
  }

  it("enqueues an embedding job when a message is assigned as primary", async () => {
    const { handler, jobQueue } = arrange(false)

    await handler.run(assignmentEvent())

    expect(jobQueue.send).toHaveBeenCalledTimes(1)
    expect(jobQueue.send.mock.calls[0]).toEqual([
      JobQueues.EMBEDDING_GENERATE,
      { messageId: "msg_1", workspaceId: "ws_1" },
    ])
  })

  it("does not enqueue when the assignment is not primary", async () => {
    const { handler, jobQueue } = arrange(false)

    await handler.run(assignmentEvent({ isPrimary: false }))

    expect(jobQueue.send).not.toHaveBeenCalled()
  })

  it("enqueues an embedding job on reassignment", async () => {
    const { handler, jobQueue } = arrange(false)

    await handler.run(reassignmentEvent())

    expect(jobQueue.send).toHaveBeenCalledTimes(1)
    expect(jobQueue.send.mock.calls[0]).toEqual([
      JobQueues.EMBEDDING_GENERATE,
      { messageId: "msg_1", workspaceId: "ws_1" },
    ])
  })

  it("does not enqueue when the assignment's stream is E2E", async () => {
    const { handler, jobQueue } = arrange(true)

    await handler.run(assignmentEvent())

    expect(jobQueue.send).not.toHaveBeenCalled()
  })
})
