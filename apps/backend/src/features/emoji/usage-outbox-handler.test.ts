import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { OutboxRepository } from "../../lib/outbox"
import * as cursorLockModule from "@threa/backend-common"
import type { ProcessResult } from "@threa/backend-common"
import { EmojiUsageHandler } from "./usage-outbox-handler"
import { EmojiUsageRepository } from "./usage-repository"
import { E2eStreamsRepository } from "../e2e-streams"

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
  const insert = spyOn(EmojiUsageRepository, "insert").mockResolvedValue(undefined as any)
  const handler = new EmojiUsageHandler({} as any)
  return { handler, insert }
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
