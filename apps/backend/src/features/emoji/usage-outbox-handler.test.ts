import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { OutboxRepository, type OutboxEvent } from "../../lib/outbox"
import * as cursorLockModule from "@threahq/backend-common"
import type { ProcessResult } from "@threahq/backend-common"
import { EmojiUsageHandler } from "./usage-outbox-handler"
import { EmojiUsageRepository } from "./usage-repository"
import { E2eStreamsRepository } from "../e2e-streams"
import { StreamRepository } from "../streams"

function makeFakeCursorLock() {
  return () => ({
    run: mock(async (processor: (cursor: bigint, processedIds: bigint[]) => Promise<ProcessResult>) => {
      await processor(0n, [])
    }),
  })
}

function createHandler() {
  ;(spyOn(cursorLockModule, "CursorLock") as any).mockImplementation(makeFakeCursorLock())
  spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
  spyOn(StreamRepository, "isSharedCopy").mockResolvedValue(false)
  const insert = spyOn(EmojiUsageRepository, "insert").mockResolvedValue(undefined as any)
  const insertBatch = spyOn(EmojiUsageRepository, "insertBatch").mockResolvedValue(undefined as any)
  const handler = new EmojiUsageHandler({} as any)
  return { handler, insert, insertBatch }
}

function messageEvent() {
  return {
    id: 1n,
    eventType: "message:created",
    payload: {
      workspaceId: "ws_test",
      streamId: "stream_test",
      event: {
        actorType: "user",
        actorId: "usr_author",
        payload: { messageId: "msg_test", contentMarkdown: "ship it :tada:" },
      },
    },
    createdAt: new Date(),
  }
}

function reactionEvent(overrides: Record<string, unknown>) {
  return {
    id: 1n,
    eventType: "reaction:added",
    payload: {
      workspaceId: "ws_test",
      streamId: "stream_test",
      messageId: "msg_test",
      emoji: ":tada:",
      userId: "usr_reactor",
      ...overrides,
    },
    createdAt: new Date(),
  }
}

afterEach(() => {
  mock.restore()
})

describe("EmojiUsageHandler — reaction attribution", () => {
  it("records emoji usage for a human reactor", async () => {
    const { handler, insert } = createHandler()
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([reactionEvent({ actorType: "user" })] as any)

    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0][1]).toMatchObject({ userId: "usr_reactor", shortcode: "tada" })
  })

  it("skips persona reactions so they don't pollute a user's emoji personalization", async () => {
    const { handler, insert } = createHandler()
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      reactionEvent({ actorType: "persona", userId: "persona_ariadne" }),
    ] as any)

    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(insert).not.toHaveBeenCalled()
  })

  it("treats a missing actorType as a user reaction (legacy events)", async () => {
    const { handler, insert } = createHandler()
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([reactionEvent({})] as any)

    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(insert).toHaveBeenCalledTimes(1)
  })
})

class TestableEmojiUsageHandler extends EmojiUsageHandler {
  run(event: OutboxEvent): Promise<void> {
    return this.processEvent(event)
  }
}

describe("EmojiUsageHandler — shared copies", () => {
  function createTestableHandler(sharedCopy: boolean) {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(StreamRepository, "isSharedCopy").mockResolvedValue(sharedCopy)
    const insert = spyOn(EmojiUsageRepository, "insert").mockResolvedValue(undefined as any)
    const insertBatch = spyOn(EmojiUsageRepository, "insertBatch").mockResolvedValue(undefined as any)
    return { handler: new TestableEmojiUsageHandler({} as any), insert, insertBatch }
  }

  it("should record nothing when a message lands in a shared copy", async () => {
    const { handler, insertBatch } = createTestableHandler(true)

    await handler.run(messageEvent() as unknown as OutboxEvent)

    expect(insertBatch).not.toHaveBeenCalled()
  })

  it("should record nothing when a reaction lands in a shared copy", async () => {
    const { handler, insert } = createTestableHandler(true)

    await handler.run(reactionEvent({ actorType: "user" }) as unknown as OutboxEvent)

    expect(insert).not.toHaveBeenCalled()
  })

  it("should record a message's emoji when its stream is not a copy", async () => {
    const { handler, insertBatch } = createTestableHandler(false)

    await handler.run(messageEvent() as unknown as OutboxEvent)

    expect(insertBatch.mock.calls.map((call) => call[1])).toEqual([
      [
        {
          id: expect.any(String),
          workspaceId: "ws_test",
          userId: "usr_author",
          interactionType: "message",
          shortcode: "tada",
          occurrenceCount: 1,
          sourceId: "msg_test",
        },
      ],
    ])
  })
})
