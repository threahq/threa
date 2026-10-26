import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { AuthorTypes, StreamTypes } from "@threahq/types"
import { ConversationRepository } from "../conversations"
import { DocRepository } from "../docs"
import { E2eStreamsRepository } from "../e2e-streams"
import { StreamRepository } from "../streams"
import { MessageRepository } from "../messaging"
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
      _data: {
        workspaceId: string
        targetKind: "stream" | "conversation" | "doc"
        targetId: string
        initiatingUserId?: string
      },
      _processAfter?: Date
    ) => {}
  )

  beforeEach(() => {
    schedule.mockClear()
    spyOn(StreamRepository, "findById").mockResolvedValue(stream as never)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(DynamicNamingStateRepository, "find").mockResolvedValue(null)
    spyOn(MessageRepository, "findById").mockResolvedValue({
      id: "msg_1",
      authorId: "usr_1",
      authorType: AuthorTypes.USER,
    } as never)
  })

  afterEach(() => {
    mock.restore()
  })

  test("schedules eligible plaintext stream work at the quiet deadline", async () => {
    const handler = new TestHandler({} as never, { schedule })
    await handler.process(event)
    expect(schedule).toHaveBeenCalledWith(
      { workspaceId: "ws_1", targetKind: "stream", targetId: "stream_1", initiatingUserId: "usr_1" },
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

  test("should not schedule when the message is in a shared copy's thread", async () => {
    const handler = new TestHandler({} as never, { schedule })
    ;(StreamRepository.findById as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...stream,
      type: StreamTypes.THREAD,
      originWorkspaceId: "ws_host",
    })
    await handler.process(event)
    expect(schedule).not.toHaveBeenCalled()
  })

  test("schedules primary non-scratchpad conversation assignments", async () => {
    ;(StreamRepository.findById as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...stream,
      type: StreamTypes.CHANNEL,
    })
    const findConversation = spyOn(ConversationRepository, "findById").mockResolvedValue({
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
        initiatingUserId: "usr_operator",
        conversationId: "conv_1",
        isPrimary: true,
        reason: "classifier",
      },
      createdAt,
    } as unknown as OutboxEvent)
    expect(schedule).toHaveBeenCalledWith(
      {
        workspaceId: "ws_1",
        targetKind: "conversation",
        targetId: "conv_1",
        initiatingUserId: "usr_operator",
      },
      new Date(createdAt.getTime() + DYNAMIC_NAMING_QUIET_MS)
    )
    expect(findConversation).toHaveBeenCalledWith(expect.anything(), "ws_1", "conv_1")
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
        initiatingUserId: "usr_operator",
        fromConversationId: "conv_from",
        toConversationId: "conv_to",
        reason: "user_correction",
      },
      createdAt,
    } as unknown as OutboxEvent)
    expect(recordStructuralEvent.mock.calls.map((call) => call[0])).toEqual([
      {
        workspaceId: "ws_1",
        targetKind: "conversation",
        targetId: "conv_from",
        initiatingUserId: "usr_operator",
      },
      {
        workspaceId: "ws_1",
        targetKind: "conversation",
        targetId: "conv_to",
        initiatingUserId: "usr_operator",
      },
    ])
  })

  test("schedules plaintext regeneration requests and leaves E2E requests deferred", async () => {
    const handler = new TestHandler({} as never, { schedule })
    const requested = (id: bigint, targetId: string, deferred: boolean) =>
      ({
        id,
        eventType: "dynamic_naming:requested",
        payload: { workspaceId: "ws_1", targetKind: "stream", targetId, deferred, initiatingUserId: "usr_1" },
        createdAt,
      }) as unknown as OutboxEvent
    await handler.processAll([requested(10n, "stream_1", false), event, requested(11n, "stream_e2e", true)])
    expect(schedule.mock.calls[0]).toEqual([
      { workspaceId: "ws_1", targetKind: "stream", targetId: "stream_1", initiatingUserId: "usr_1" },
    ])
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

  describe("doc edits", () => {
    const doc = { ...stream, id: "stream_doc", type: StreamTypes.DOC, parentStreamId: "stream_host" }
    const docUpdated = (id: bigint, overrides: Record<string, unknown> = {}) =>
      ({
        id,
        eventType: "doc:updated",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_doc",
          seq: Number(id),
          update: "AA==",
          touchedBlockIds: [],
          actorId: "usr_1",
          actorType: AuthorTypes.USER,
          ...overrides,
        },
        createdAt,
      }) as unknown as OutboxEvent

    const blocks = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ blockId: `blk_${index}`, markdown: `Block ${index}` }))

    beforeEach(() => {
      ;(StreamRepository.findById as ReturnType<typeof mock>).mockResolvedValue(doc)
      spyOn(DocRepository, "listSections").mockResolvedValue(blocks(1) as never)
    })

    test("should schedule doc naming at the quiet deadline when a user edits an untitled doc", async () => {
      const handler = new TestHandler({} as never, { schedule })
      await handler.process(docUpdated(30n))
      expect(schedule.mock.calls).toEqual([
        [
          { workspaceId: "ws_1", targetKind: "doc", targetId: "stream_doc", initiatingUserId: "usr_1" },
          new Date(createdAt.getTime() + DYNAMIC_NAMING_QUIET_MS),
        ],
      ])
    })

    test("should not schedule when the edit is the server's own update", async () => {
      const handler = new TestHandler({} as never, { schedule })
      await handler.process(docUpdated(31n, { actorId: AuthorTypes.SYSTEM, actorType: AuthorTypes.SYSTEM }))
      expect(schedule).not.toHaveBeenCalled()
    })

    test("should not schedule when a human named the doc", async () => {
      ;(StreamRepository.findById as ReturnType<typeof mock>).mockResolvedValue({
        ...doc,
        displayName: "Launch plan",
        displayNameSource: "explicit",
      })
      const handler = new TestHandler({} as never, { schedule })
      await handler.process(docUpdated(32n))
      expect(schedule).not.toHaveBeenCalled()
    })

    test("should not schedule when the doc's naming lifecycle has settled", async () => {
      ;(DynamicNamingStateRepository.find as ReturnType<typeof mock>).mockResolvedValue({
        lastEvaluatedMessageCount: 10,
        consecutiveKeeps: 2,
        completedAt: new Date(),
        structureVersion: 0,
        lastEvaluatedStructureVersion: 0,
      })
      const handler = new TestHandler({} as never, { schedule })
      await handler.process(docUpdated(33n))
      expect(schedule).not.toHaveBeenCalled()
    })

    test("should not schedule when the doc's block count has crossed no new checkpoint since the last evaluation", async () => {
      ;(DynamicNamingStateRepository.find as ReturnType<typeof mock>).mockResolvedValue({
        lastEvaluatedMessageCount: 3,
        consecutiveKeeps: 0,
        completedAt: null,
        structureVersion: 0,
        lastEvaluatedStructureVersion: 0,
      })
      ;(DocRepository.listSections as ReturnType<typeof mock>).mockResolvedValue(blocks(4) as never)
      const handler = new TestHandler({} as never, { schedule })
      await handler.process(docUpdated(37n))
      expect(schedule).not.toHaveBeenCalled()
    })

    test("should schedule when the doc's block count reaches the next checkpoint", async () => {
      ;(DynamicNamingStateRepository.find as ReturnType<typeof mock>).mockResolvedValue({
        lastEvaluatedMessageCount: 3,
        consecutiveKeeps: 0,
        completedAt: null,
        structureVersion: 0,
        lastEvaluatedStructureVersion: 0,
      })
      ;(DocRepository.listSections as ReturnType<typeof mock>).mockResolvedValue(blocks(6) as never)
      const handler = new TestHandler({} as never, { schedule })
      await handler.process(docUpdated(38n))
      expect(schedule.mock.calls).toEqual([
        [
          { workspaceId: "ws_1", targetKind: "doc", targetId: "stream_doc", initiatingUserId: "usr_1" },
          new Date(createdAt.getTime() + DYNAMIC_NAMING_QUIET_MS),
        ],
      ])
    })

    test("should schedule once when a batch holds several edits to one doc", async () => {
      const handler = new TestHandler({} as never, { schedule })
      await handler.processAll([
        docUpdated(34n),
        docUpdated(35n),
        docUpdated(36n, { actorId: AuthorTypes.SYSTEM, actorType: AuthorTypes.SYSTEM }),
      ])
      expect(schedule.mock.calls).toEqual([
        [
          { workspaceId: "ws_1", targetKind: "doc", targetId: "stream_doc", initiatingUserId: "usr_1" },
          new Date(createdAt.getTime() + DYNAMIC_NAMING_QUIET_MS),
        ],
      ])
    })
  })
})
