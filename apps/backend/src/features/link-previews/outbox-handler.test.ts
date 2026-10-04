import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { OutboxEvent } from "../../lib/outbox"
import { JobQueues } from "../../lib/queue"
import { E2eStreamsRepository } from "../e2e-streams"
import { StreamRepository } from "../streams"
import { LinkPreviewOutboxHandler } from "./outbox-handler"

class TestableLinkPreviewOutboxHandler extends LinkPreviewOutboxHandler {
  run(event: OutboxEvent): Promise<void> {
    return this.processEvent(event)
  }
}

function createHandler(isSharedCopy: boolean) {
  spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
  spyOn(StreamRepository, "isSharedCopy").mockResolvedValue(isSharedCopy)
  const send = mock(async () => "job_1")
  const handler = new TestableLinkPreviewOutboxHandler({} as any, { send } as any)
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
      payload: { messageId: "msg_test", contentMarkdown: "see https://example.com" },
    },
  },
  createdAt: new Date(),
} as unknown as OutboxEvent

afterEach(() => {
  mock.restore()
})

describe("LinkPreviewOutboxHandler — shared copies", () => {
  it("should queue no extraction when the message is in a shared copy", async () => {
    const { handler, send } = createHandler(true)

    await handler.run(messageCreated)

    expect(send).not.toHaveBeenCalled()
  })

  it("should queue extraction when the message is in a local stream", async () => {
    const { handler, send } = createHandler(false)

    await handler.run(messageCreated)

    expect(send).toHaveBeenCalledWith(JobQueues.LINK_PREVIEW_EXTRACT, {
      workspaceId: "ws_test",
      streamId: "stream_test",
      messageId: "msg_test",
      contentMarkdown: "see https://example.com",
      contentJson: null,
      isEdit: false,
    })
  })
})
