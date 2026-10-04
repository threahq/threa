import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { OutboxEvent } from "../../lib/outbox"
import { JobQueues } from "../../lib/queue"
import { E2eStreamsRepository } from "../e2e-streams"
import { StreamRepository } from "../streams"
import { BoundaryExtractionHandler } from "./boundary-extraction-outbox-handler"

class TestableBoundaryExtractionHandler extends BoundaryExtractionHandler {
  run(event: OutboxEvent): Promise<void> {
    return this.processEvent(event)
  }
}

function createHandler(isSharedCopy: boolean) {
  spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
  spyOn(StreamRepository, "isSharedCopy").mockResolvedValue(isSharedCopy)
  const send = mock(async () => "job_1")
  const handler = new TestableBoundaryExtractionHandler({} as any, { send } as any)
  return { handler, send }
}

const messageCreated = {
  id: 1n,
  eventType: "message:created",
  payload: {
    workspaceId: "ws_test",
    streamId: "stream_test",
    event: {
      actorType: "user",
      actorId: "usr_author",
      payload: { messageId: "msg_test", contentMarkdown: "hello" },
    },
  },
  createdAt: new Date(),
} as unknown as OutboxEvent

afterEach(() => {
  mock.restore()
})

describe("BoundaryExtractionHandler — shared copies", () => {
  it("should queue no boundary extraction when the message is in a shared copy", async () => {
    const { handler, send } = createHandler(true)

    await handler.run(messageCreated)

    expect(send).not.toHaveBeenCalled()
  })

  it("should queue boundary extraction when the message is in a local stream", async () => {
    const { handler, send } = createHandler(false)

    await handler.run(messageCreated)

    expect(send).toHaveBeenCalledWith(JobQueues.BOUNDARY_EXTRACT, {
      messageId: "msg_test",
      streamId: "stream_test",
      workspaceId: "ws_test",
    })
  })
})
