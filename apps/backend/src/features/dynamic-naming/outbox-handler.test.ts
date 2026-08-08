import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { AuthorTypes, StreamTypes } from "@threa/types"
import { ConversationRepository } from "../conversations"
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

  processAll(events: OutboxEvent[]) {
    return this.processBatch(events)
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
  const schedule = mock(
    async (
      _data: { workspaceId: string; targetKind: "stream" | "conversation"; targetId: string },
      _processAfter?: Date
    ) => {}
  )

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

  test("schedules primary non-scratchpad conversation assignments", async () => {
    ;(StreamRepository.findById as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...stream,
      type: StreamTypes.CHANNEL,
    })
    spyOn(ConversationRepository, "findById").mockResolvedValue({
      id: "conv_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      topicSummary: "Generated title",
      topicSummarySource: "generated",
    } as never)
    const handler = new TestHandler({} as never, { schedule })
    await handler.process({
      id: 13n,
      eventType: "conversation:message_assigned",
      payload: {
        workspaceId: "ws_1",
        streamId: "stream_1",
        messageId: "msg_1",
        conversationId: "conv_1",
        isPrimary: true,
        reason: "classifier",
      },
      createdAt,
    } as unknown as OutboxEvent)
    expect(schedule).toHaveBeenCalledWith(
      { workspaceId: "ws_1", targetKind: "conversation", targetId: "conv_1" },
      new Date(createdAt.getTime() + DYNAMIC_NAMING_QUIET_MS)
    )
  })

  test("marks both ends of a reassignment structurally dirty", async () => {
    const recordStructuralEvent = mock(async (_ref: unknown, _eventId: string) => true)
    const handler = new TestHandler({} as never, { schedule }, { recordStructuralEvent })
    await handler.process({
      id: 14n,
      eventType: "conversation:message_reassigned",
      payload: {
        workspaceId: "ws_1",
        streamId: "stream_1",
        messageId: "msg_1",
        fromConversationId: "conv_from",
        toConversationId: "conv_to",
        reason: "user_correction",
      },
      createdAt,
    } as unknown as OutboxEvent)
    expect(recordStructuralEvent.mock.calls.map((call) => call[0])).toEqual([
      { workspaceId: "ws_1", targetKind: "conversation", targetId: "conv_from" },
      { workspaceId: "ws_1", targetKind: "conversation", targetId: "conv_to" },
    ])
  })

  test("schedules plaintext regeneration requests and leaves E2E requests deferred", async () => {
    const handler = new TestHandler({} as never, { schedule })
    const requested = (id: bigint, targetId: string, deferred: boolean) =>
      ({
        id,
        eventType: "dynamic_naming:requested",
        payload: { workspaceId: "ws_1", targetKind: "stream", targetId, deferred },
        createdAt,
      }) as unknown as OutboxEvent
    await handler.processAll([requested(10n, "stream_1", false), event, requested(11n, "stream_e2e", true)])
    expect(schedule.mock.calls[0]).toEqual([{ workspaceId: "ws_1", targetKind: "stream", targetId: "stream_1" }])
    expect(schedule.mock.calls).toHaveLength(2)
  })

  test("coalesces repeated structural events to the newest id per target", async () => {
    const recordStructuralEvent = mock(async (_ref: unknown, _eventId: string) => true)
    const handler = new TestHandler({} as never, { schedule }, { recordStructuralEvent })
    const reassigned = (id: bigint) =>
      ({
        id,
        eventType: "conversation:message_reassigned",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_1",
          messageId: `msg_${id}`,
          fromConversationId: "conv_from",
          toConversationId: "conv_to",
          reason: "split",
        },
        createdAt,
      }) as unknown as OutboxEvent
    await handler.processAll([reassigned(20n), reassigned(21n)])
    expect(recordStructuralEvent.mock.calls).toHaveLength(2)
    expect(recordStructuralEvent.mock.calls.map((call) => call[1])).toEqual(["21", "21"])
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
