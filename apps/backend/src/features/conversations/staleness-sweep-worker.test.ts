import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { ConversationStatuses } from "@threa/types"
import * as dbModule from "../../db"
import { StreamRepository } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import { ConversationRepository, type Conversation } from "./repository"
import { MessageConversationStateRepository } from "./settling-repository"
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
    spyOn(StreamRepository, "findByIds").mockResolvedValue([
      {
        id: "stream_1",
        type: "dm",
        visibility: "private",
      },
    ] as never)
    const insertMany = spyOn(OutboxRepository, "insertMany").mockResolvedValue([] as never)
    spyOn(MessageConversationStateRepository, "listSettlingByConversationIds").mockResolvedValue(new Map())
    spyOn(MessageConversationStateRepository, "settleOlderThan").mockResolvedValue([])
    return { worker: createStalenessSweepWorker({ pool: {} as never }), insertMany }
  }

  it("emits a sweep-tagged conversation:updated per transitioned conversation", async () => {
    const { worker, insertMany } = arrange([
      makeConversation({ id: "conv_a", status: ConversationStatuses.STALLED }),
      makeConversation({ id: "conv_b", status: ConversationStatuses.RESOLVED }),
    ])

    await worker(job)

    expect(insertMany).toHaveBeenCalledTimes(1)
    const entries = insertMany.mock.calls[0][1]
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      eventType: "conversation:updated",
      payload: expect.objectContaining({
        workspaceId: "ws_1",
        streamId: "stream_1",
        conversationId: "conv_a",
        origin: "staleness-sweep",
        conversation: expect.objectContaining({ id: "conv_a", status: ConversationStatuses.STALLED }),
      }),
    })
    expect(entries[1].payload).toEqual(expect.objectContaining({ conversationId: "conv_b" }))
  })

  it("emits nothing when the sweep transitions nothing", async () => {
    const { worker, insertMany } = arrange([])

    await worker(job)

    expect(insertMany).not.toHaveBeenCalled()
  })
})
