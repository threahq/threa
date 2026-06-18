import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { StreamTypes, CompanionModes, MemoryModes } from "@threa/types"
import * as dbModule from "../../db"
import { StreamRepository, StreamStateRepository } from "../streams"
import { E2eStreamsRepository } from "../e2e-streams"
import { MemoAccumulatorHandler } from "./accumulator-outbox-handler"
import { PendingItemRepository } from "./pending-item-repository"
import type { OutboxEvent } from "../../lib/outbox"

// Drive a single event past the protected dispatcher without the cursor/debounce
// machinery (INV-48: scoped spyOn, no module mocking).
class TestableMemoAccumulatorHandler extends MemoAccumulatorHandler {
  run(event: OutboxEvent): Promise<void> {
    return this["processEvent"](event)
  }
}

function makeStream(overrides: Partial<Record<string, unknown>>): any {
  return {
    id: "stream_x",
    workspaceId: "ws_1",
    type: StreamTypes.SCRATCHPAD,
    displayName: null,
    slug: null,
    description: null,
    visibility: "private",
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: CompanionModes.OFF,
    companionPersonaId: null,
    memoryMode: MemoryModes.AUTO,
    createdBy: "usr_1",
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    displayNameGeneratedAt: null,
    ...overrides,
  }
}

function conversationEvent(streamId: string): OutboxEvent {
  return {
    id: 1n,
    eventType: "conversation:created",
    createdAt: new Date(),
    payload: { workspaceId: "ws_1", streamId, conversationId: "conv_1" },
  } as unknown as OutboxEvent
}

describe("MemoAccumulatorHandler memory gate", () => {
  afterEach(() => mock.restore())

  function arrange(findById: (id: string) => any) {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(dbModule, "withClient").mockImplementation((async (_pool: unknown, fn: (c: unknown) => unknown) =>
      fn({})) as typeof dbModule.withClient)
    spyOn(StreamRepository, "findById").mockImplementation(async (_db: any, id: string) => findById(id))
    const queue = spyOn(PendingItemRepository, "queue").mockResolvedValue([])
    const activity = spyOn(StreamStateRepository, "upsertActivity").mockResolvedValue(undefined as never)
    const handler = new TestableMemoAccumulatorHandler({} as any)
    return { handler, queue, activity }
  }

  it("queues the conversation when memoryMode is auto", async () => {
    const { handler, queue, activity } = arrange(() => makeStream({ id: "stream_x", memoryMode: MemoryModes.AUTO }))

    await handler.run(conversationEvent("stream_x"))

    expect(queue).toHaveBeenCalledTimes(1)
    expect(queue.mock.calls[0][1]).toEqual([
      expect.objectContaining({ streamId: "stream_x", itemType: "conversation", itemId: "conv_1" }),
    ])
    expect(activity).toHaveBeenCalledTimes(1)
  })

  it("skips queueing when memoryMode is off", async () => {
    const { handler, queue, activity } = arrange(() => makeStream({ id: "stream_x", memoryMode: MemoryModes.OFF }))

    await handler.run(conversationEvent("stream_x"))

    expect(queue).not.toHaveBeenCalled()
    expect(activity).not.toHaveBeenCalled()
  })

  it("inherits the root stream's memoryMode for a thread (INV-62)", async () => {
    // The thread's own row says auto, but its root is off — the gate resolves
    // through the root, so nothing is queued.
    const thread = makeStream({
      id: "stream_thread",
      type: StreamTypes.THREAD,
      rootStreamId: "stream_root",
      memoryMode: MemoryModes.AUTO,
    })
    const root = makeStream({ id: "stream_root", memoryMode: MemoryModes.OFF })
    const { handler, queue } = arrange((id) => (id === "stream_thread" ? thread : root))

    await handler.run(conversationEvent("stream_thread"))

    expect(queue).not.toHaveBeenCalled()
  })

  it("skips queueing when a thread's root stream is gone", async () => {
    // Root deleted: findById returns the thread but null for the root. Don't
    // queue an orphan against a non-existent top-level stream.
    const thread = makeStream({ id: "stream_thread", type: StreamTypes.THREAD, rootStreamId: "stream_root" })
    const { handler, queue, activity } = arrange((id) => (id === "stream_thread" ? thread : null))

    await handler.run(conversationEvent("stream_thread"))

    expect(queue).not.toHaveBeenCalled()
    expect(activity).not.toHaveBeenCalled()
  })
})
