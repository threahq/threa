import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { AuthorTypes, StreamTypes } from "@threa/types"
import { E2eStreamsRepository } from "../e2e-streams"
import { StreamRepository } from "../streams"
import type { OutboxEvent } from "../../lib/outbox"
import { DYNAMIC_NAMING_QUIET_MS } from "./config"
import { DynamicNamingOutboxHandler } from "./outbox-handler"
import { DynamicNamingStateRepository } from "./state-repository"

class TestHandler extends DynamicNamingOutboxHandler {
  process(event: OutboxEvent) {
    return this.processEvent(event)
  }
}

const createdAt = new Date("2026-08-07T12:00:00.000Z")
const event = {
  id: 12n,
  eventType: "message:created",
  payload: {
    workspaceId: "ws_1",
    streamId: "stream_1",
    event: {
      actorId: "usr_1",
      actorType: AuthorTypes.USER,
      sequence: 1,
      payload: { messageId: "msg_1" },
    },
  },
  createdAt,
} as unknown as OutboxEvent

const stream = {
  id: "stream_1",
  workspaceId: "ws_1",
  type: StreamTypes.SCRATCHPAD,
  displayName: null,
  displayNameSource: null,
  archivedAt: null,
}

describe("dynamic naming outbox handler", () => {
  const schedule = mock(async () => {})

  beforeEach(() => {
    schedule.mockClear()
    spyOn(StreamRepository, "findById").mockResolvedValue(stream as never)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(DynamicNamingStateRepository, "find").mockResolvedValue(null)
  })

  afterEach(() => {
    mock.restore()
  })

  test("schedules eligible plaintext stream work at the quiet deadline", async () => {
    const handler = new TestHandler({} as never, { schedule })
    await handler.process(event)
    expect(schedule).toHaveBeenCalledWith(
      { workspaceId: "ws_1", targetKind: "stream", targetId: "stream_1" },
      new Date(createdAt.getTime() + DYNAMIC_NAMING_QUIET_MS)
    )
  })

  test("does not schedule protected or encrypted streams", async () => {
    const handler = new TestHandler({} as never, { schedule })
    ;(StreamRepository.findById as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...stream,
      displayName: "Human title",
      displayNameSource: "explicit",
    })
    await handler.process(event)
    ;(E2eStreamsRepository.isE2eStream as ReturnType<typeof mock>).mockResolvedValueOnce(true)
    await handler.process(event)
    expect(schedule).not.toHaveBeenCalled()
  })

  test("does not enqueue ordinary messages after the lifecycle settles", async () => {
    const handler = new TestHandler({} as never, { schedule })
    ;(DynamicNamingStateRepository.find as ReturnType<typeof mock>).mockResolvedValueOnce({
      completedAt: new Date(),
      structureVersion: 0,
      lastEvaluatedStructureVersion: 0,
    })
    await handler.process(event)
    expect(schedule).not.toHaveBeenCalled()
  })
})
