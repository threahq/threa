import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { ConversationStatuses } from "@threa/types"
import * as dbModule from "../../db"
import { StreamRepository } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import { ConversationRepository, type Conversation } from "./repository"
import { createStalenessSweepWorker } from "./staleness-sweep-worker"

function makeConversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: "conv_1",
    streamId: "stream_1",
    workspaceId: "ws_1",
    messageIds: ["msg_1"],
    participantIds: ["usr_1"],
    secondaryMessageIds: [],
    topicSummary: "Idle topic",
    summary: null,
    completenessScore: 3,
    confidence: 0.8,
    status: ConversationStatuses.STALLED,
    parentConversationId: null,
    lastActivityAt: new Date("2026-06-01T00:00:00Z"),
    createdAt: new Date("2026-05-30T00:00:00Z"),
    updatedAt: new Date(),
    ...overrides,
  }
}

const job = { id: "job_1", name: "conversation.staleness-sweep", data: { workspaceId: "system" } }

describe("createStalenessSweepWorker", () => {
  afterEach(() => mock.restore())

  function arrange(swept: Conversation[]) {
    spyOn(dbModule, "withTransaction").mockImplementation((async (_pool: unknown, fn: (c: unknown) => unknown) =>
      fn({})) as typeof dbModule.withTransaction)
    spyOn(ConversationRepository, "sweepStale").mockResolvedValue(swept)
    spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_1",
      type: "dm",
      visibility: "private",
    } as never)
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    return { worker: createStalenessSweepWorker({ pool: {} as never }), insert }
  }

  it("emits a sweep-tagged conversation:updated per transitioned conversation", async () => {
    const { worker, insert } = arrange([
      makeConversation({ id: "conv_a", status: ConversationStatuses.STALLED }),
      makeConversation({ id: "conv_b", status: ConversationStatuses.RESOLVED }),
    ])

    await worker(job)

    expect(insert).toHaveBeenCalledTimes(2)
    expect(insert.mock.calls.map((c) => c[1])).toEqual(["conversation:updated", "conversation:updated"])
    expect(insert.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        workspaceId: "ws_1",
        streamId: "stream_1",
        conversationId: "conv_a",
        origin: "staleness-sweep",
        conversation: expect.objectContaining({ id: "conv_a", status: ConversationStatuses.STALLED }),
      })
    )
  })

  it("emits nothing when the sweep transitions nothing", async () => {
    const { worker, insert } = arrange([])

    await worker(job)

    expect(insert).not.toHaveBeenCalled()
  })
})
