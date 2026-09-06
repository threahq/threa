import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { OutboxRepository } from "../../lib/outbox"
import * as cursorLockModule from "@threahq/backend-common"
import * as dbModule from "../../db"
import { ActivityFeedHandler } from "./outbox-handler"
import type { ActivityService } from "./service"
import { ActivityRepository } from "./repository"
import type { ProcessResult } from "@threahq/backend-common"
import { AuthorTypes } from "@threahq/types"
import { E2eStreamsRepository } from "../e2e-streams"

function makeFakeCursorLock(onRun?: (result: ProcessResult) => void) {
  return () => ({
    run: mock(async (processor: (cursor: bigint, processedIds: bigint[]) => Promise<ProcessResult>) => {
      const result = await processor(0n, [])
      onRun?.(result)
    }),
  })
}

function mockCursorLock(onRun?: (result: ProcessResult) => void) {
  ;(spyOn(cursorLockModule, "CursorLock") as any).mockImplementation(makeFakeCursorLock(onRun))
}

function createHandler() {
  const activityService = {
    processMessageMentions: mock(async () => []),
    processMessageNotifications: mock(async () => []),
    processSelfMessageActivity: mock(async () => null),
    processReactionAdded: mock(async () => []),
    processReactionRemoved: mock(async () => []),
    processMemberAdded: mock(async () => []),
    listFeed: mock(async () => []),
    getUnreadCounts: mock(async () => ({ mentionsByStream: new Map(), totalByStream: new Map(), total: 0 })),
    markAsRead: mock(async () => {}),
    markStreamActivityAsRead: mock(async () => {}),
    markAllAsRead: mock(async () => {}),
  } as unknown as ActivityService

  mockCursorLock()

  const handler = new ActivityFeedHandler({} as any, activityService)

  return { handler, activityService }
}

// Mirrors what the composer/API path emits: the markdown body plus the
// canonical contentJson carrying the structural mention node (INV-58).
const MENTION_CONTENT_JSON = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "hello " },
        { type: "mention", attrs: { id: "usr_alice", slug: "alice", mentionType: "user" } },
        { type: "text", text: " check this" },
      ],
    },
  ],
}

function makeMessageCreatedEvent(
  id: bigint,
  overrides?: {
    actorType?: string
    actorId?: string | null
    contentMarkdown?: string
    contentJson?: unknown
    workspaceId?: string
    streamId?: string
    messageId?: string
  }
) {
  return {
    id,
    eventType: "message:created" as const,
    payload: {
      workspaceId: overrides?.workspaceId ?? "ws_test",
      streamId: overrides?.streamId ?? "stream_test",
      event: {
        id: "event_1",
        sequence: "1",
        actorType: overrides?.actorType ?? AuthorTypes.USER,
        actorId: "actorId" in (overrides ?? {}) ? overrides!.actorId : "usr_author",
        payload: {
          messageId: overrides?.messageId ?? "msg_test",
          contentMarkdown: overrides?.contentMarkdown ?? "hello @alice check this",
          contentJson: "contentJson" in (overrides ?? {}) ? overrides!.contentJson : MENTION_CONTENT_JSON,
        },
      },
    },
    createdAt: new Date(),
  }
}

describe("ActivityFeedHandler", () => {
  beforeEach(() => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
  })

  afterEach(() => {
    mock.restore()
  })

  it("should call processMessageMentions for message:created events from members", async () => {
    const event = makeMessageCreatedEvent(1n, {
      contentMarkdown: "hey @alice look at this",
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)

    const { handler, activityService } = createHandler()
    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    expect(activityService.processMessageMentions).toHaveBeenCalledWith({
      workspaceId: "ws_test",
      streamId: "stream_test",
      messageId: "msg_test",
      actorId: "usr_author",
      actorType: "user",
      contentMarkdown: "hey @alice look at this",
      contentJson: MENTION_CONTENT_JSON,
    })
  })

  it("should process persona messages for mentions and notifications", async () => {
    const event = makeMessageCreatedEvent(1n, {
      actorType: "persona",
      actorId: "persona_agent1",
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)

    const { handler, activityService } = createHandler()
    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    expect(activityService.processMessageMentions).toHaveBeenCalled()
  })

  it("should skip system-authored messages", async () => {
    const event = makeMessageCreatedEvent(1n, {
      actorType: "system",
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)

    const { handler, activityService } = createHandler()
    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    expect(activityService.processMessageMentions).not.toHaveBeenCalled()
  })

  it("should skip events with no actorId", async () => {
    const event = makeMessageCreatedEvent(1n, {
      actorId: null,
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)

    const { handler, activityService } = createHandler()
    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    expect(activityService.processMessageMentions).not.toHaveBeenCalled()
  })

  it("should not treat unrelated events as messages", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      { id: 1n, eventType: "stream:created", payload: {}, createdAt: new Date() },
    ] as any)

    const { handler, activityService } = createHandler()
    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    expect(activityService.processMessageMentions).not.toHaveBeenCalled()
    expect(activityService.processReactionAdded).not.toHaveBeenCalled()
  })

  it("should route reaction:added events to processReactionAdded", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "reaction:added",
        payload: {
          workspaceId: "ws_test",
          streamId: "stream_test",
          messageId: "msg_test",
          emoji: ":eyes:",
          userId: "usr_reactor",
        },
        createdAt: new Date(),
      },
    ] as any)

    const { handler, activityService } = createHandler()
    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    expect(activityService.processReactionAdded).toHaveBeenCalledWith({
      workspaceId: "ws_test",
      streamId: "stream_test",
      messageId: "msg_test",
      emoji: ":eyes:",
      actorId: "usr_reactor",
      actorType: "user",
    })
  })

  it("should route reaction:removed events to processReactionRemoved", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "reaction:removed",
        payload: {
          workspaceId: "ws_test",
          streamId: "stream_test",
          messageId: "msg_test",
          emoji: ":eyes:",
          userId: "usr_reactor",
        },
        createdAt: new Date(),
      },
    ] as any)

    const { handler, activityService } = createHandler()
    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    expect(activityService.processReactionRemoved).toHaveBeenCalledWith({
      workspaceId: "ws_test",
      messageId: "msg_test",
      actorId: "usr_reactor",
      emoji: ":eyes:",
    })
  })

  it("should publish activity:created outbox events for each created activity", async () => {
    const createdActivity = {
      id: "activity_test123",
      workspaceId: "ws_test",
      userId: "usr_alice",
      activityType: "mention",
      streamId: "stream_test",
      messageId: "msg_test",
      actorId: "usr_author",
      actorType: "user",
      context: { contentPreview: "hey @alice" },
      readAt: null,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      isSelf: false,
      emoji: null,
    }

    const event = makeMessageCreatedEvent(1n)

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const countsSpy = spyOn(ActivityRepository, "countUnreadForPairs").mockResolvedValue(
      new Map([["usr_alice:stream_test", { mentionCount: 3, totalCount: 5 }]])
    )
    spyOn(ActivityRepository, "findStillUnreadIds").mockResolvedValue(new Set(["activity_test123"]))

    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool, callback) => {
      return callback({} as any)
    })

    const { handler, activityService } = createHandler()
    ;(activityService.processMessageMentions as any).mockResolvedValue([createdActivity])

    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    expect(countsSpy).toHaveBeenCalledWith({}, "ws_test", [{ userId: "usr_alice", streamId: "stream_test" }])
    expect(insertSpy).toHaveBeenCalledWith({}, "activity:created", {
      workspaceId: "ws_test",
      targetUserId: "usr_alice",
      counts: { mentionCount: 3, activityCount: 5 },
      activity: {
        id: "activity_test123",
        activityType: "mention",
        streamId: "stream_test",
        messageId: "msg_test",
        actorId: "usr_author",
        actorType: "user",
        context: { contentPreview: "hey @alice" },
        createdAt: "2025-01-01T00:00:00.000Z",
        isSelf: false,
        emoji: null,
      },
    })
  })

  it("does not publish activity:created for born-read recipient rows", async () => {
    // A born-read row (read_at set because the recipient had already read the
    // message) must not push a live event — the client would re-add it to the
    // badge it just cleared. The unread recipient still gets their event.
    const bornRead = {
      id: "act_bornread",
      workspaceId: "ws_test",
      userId: "usr_caughtup",
      activityType: "message",
      streamId: "stream_test",
      messageId: "msg_test",
      actorId: "usr_author",
      actorType: "user",
      context: {},
      readAt: new Date("2025-01-01T00:00:00Z"),
      createdAt: new Date("2025-01-01T00:00:00Z"),
      isSelf: false,
      emoji: null,
    }
    const unread = { ...bornRead, id: "act_unread", userId: "usr_behind", readAt: null }

    const event = makeMessageCreatedEvent(1n)
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    spyOn(ActivityRepository, "countUnreadForPairs").mockResolvedValue(
      new Map([["usr_behind:stream_test", { mentionCount: 0, totalCount: 1 }]])
    )
    spyOn(ActivityRepository, "findStillUnreadIds").mockResolvedValue(new Set(["act_unread"]))
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool, callback) => callback({} as any))

    const { handler, activityService } = createHandler()
    ;(activityService.processMessageNotifications as any).mockResolvedValue([bornRead, unread])

    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(insertSpy).toHaveBeenCalledWith(
      {},
      "activity:created",
      expect.objectContaining({ targetUserId: "usr_behind" })
    )
    expect(insertSpy).not.toHaveBeenCalledWith(
      {},
      "activity:created",
      expect.objectContaining({ targetUserId: "usr_caughtup" })
    )
  })

  it("skips activity:created for rows read before publish (activity:read ordering barrier)", async () => {
    // A row can be read — and its activity:read logged — between the source
    // commit and this publish. The FOR SHARE re-read sees the committed
    // read_at and the stale creation is never published, so the sync log
    // can't order a creation after its read (replay would resurrect the row).
    const readBeforePublish = {
      id: "act_read_early",
      workspaceId: "ws_test",
      userId: "usr_a",
      activityType: "message",
      streamId: "stream_test",
      messageId: "msg_test",
      actorId: "usr_author",
      actorType: "user",
      context: {},
      readAt: null,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      isSelf: false,
      emoji: null,
    }
    const stillUnread = { ...readBeforePublish, id: "act_still_unread", userId: "usr_b" }

    const event = makeMessageCreatedEvent(1n)
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    spyOn(ActivityRepository, "countUnreadForPairs").mockResolvedValue(new Map())
    // The locked re-read reports only one row still unread.
    spyOn(ActivityRepository, "findStillUnreadIds").mockResolvedValue(new Set(["act_still_unread"]))
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool, callback) => callback({} as any))

    const { handler, activityService } = createHandler()
    ;(activityService.processMessageNotifications as any).mockResolvedValue([readBeforePublish, stillUnread])

    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(insertSpy).toHaveBeenCalledWith({}, "activity:created", {
      workspaceId: "ws_test",
      targetUserId: "usr_b",
      counts: { mentionCount: 0, activityCount: 0 },
      activity: {
        id: "act_still_unread",
        activityType: "message",
        streamId: "stream_test",
        messageId: "msg_test",
        actorId: "usr_author",
        actorType: "user",
        context: {},
        createdAt: "2025-01-01T00:00:00.000Z",
        isSelf: false,
        emoji: null,
      },
    })
    expect(insertSpy).not.toHaveBeenCalledWith(
      {},
      "activity:created",
      expect.objectContaining({ targetUserId: "usr_a" })
    )
  })

  it("still publishes self rows even when the barrier reports nothing unread", async () => {
    // Self rows are born read (read_at set at insert) so they never appear in
    // an activity:read delta — the barrier must not suppress their emission.
    const selfRow = {
      id: "act_self",
      workspaceId: "ws_test",
      userId: "usr_author",
      activityType: "message",
      streamId: "stream_test",
      messageId: "msg_test",
      actorId: "usr_author",
      actorType: "user",
      context: {},
      readAt: new Date("2025-01-01T00:00:00Z"),
      createdAt: new Date("2025-01-01T00:00:00Z"),
      isSelf: true,
      emoji: null,
    }

    const event = makeMessageCreatedEvent(1n)
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    spyOn(ActivityRepository, "countUnreadForPairs").mockResolvedValue(new Map())
    spyOn(ActivityRepository, "findStillUnreadIds").mockResolvedValue(new Set())
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool, callback) => callback({} as any))

    const { handler, activityService } = createHandler()
    ;(activityService.processSelfMessageActivity as any).mockResolvedValue(selfRow)

    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(insertSpy).toHaveBeenCalledWith({}, "activity:created", {
      workspaceId: "ws_test",
      targetUserId: "usr_author",
      counts: { mentionCount: 0, activityCount: 0 },
      activity: {
        id: "act_self",
        activityType: "message",
        streamId: "stream_test",
        messageId: "msg_test",
        actorId: "usr_author",
        actorType: "user",
        context: {},
        createdAt: "2025-01-01T00:00:00.000Z",
        isSelf: true,
        emoji: null,
      },
    })
  })

  it("should return no_events when batch is empty", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([])

    let result: ProcessResult | undefined
    mockCursorLock((r) => {
      result = r
    })

    const activityService = {
      processMessageMentions: mock(async () => []),
      processMessageNotifications: mock(async () => []),
      processSelfMessageActivity: mock(async () => null),
      processReactionAdded: mock(async () => []),
      processReactionRemoved: mock(async () => []),
    } as unknown as ActivityService
    const handler = new ActivityFeedHandler({} as any, activityService)
    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    expect(result).toEqual({ status: "no_events" })
  })

  it("should publish outbox events on retry when activities already exist", async () => {
    // Simulates retry: insertBatch returns pre-existing rows via ON CONFLICT DO UPDATE
    const preExistingActivity = {
      id: "activity_existing",
      workspaceId: "ws_test",
      userId: "usr_bob",
      activityType: "mention",
      streamId: "stream_test",
      messageId: "msg_test",
      actorId: "usr_author",
      actorType: "user",
      context: { contentPreview: "hey @bob" },
      readAt: null,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      isSelf: false,
      emoji: null,
    }

    const event = makeMessageCreatedEvent(1n, {
      contentMarkdown: "hey @bob check this",
    })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    const insertSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    spyOn(ActivityRepository, "countUnreadForPairs").mockResolvedValue(
      new Map([["usr_bob:stream_test", { mentionCount: 1, totalCount: 1 }]])
    )
    spyOn(ActivityRepository, "findStillUnreadIds").mockResolvedValue(new Set(["activity_existing"]))

    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool, callback) => {
      return callback({} as any)
    })

    const { handler, activityService } = createHandler()
    ;(activityService.processMessageMentions as any).mockResolvedValue([preExistingActivity])

    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    const want = {
      workspaceId: "ws_test",
      targetUserId: "usr_bob",
      counts: { mentionCount: 1, activityCount: 1 },
      activity: {
        id: "activity_existing",
        activityType: "mention",
        streamId: "stream_test",
        messageId: "msg_test",
        actorId: "usr_author",
        actorType: "user",
        context: { contentPreview: "hey @bob" },
        createdAt: "2025-01-01T00:00:00.000Z",
        isSelf: false,
        emoji: null,
      },
    }
    expect(insertSpy).toHaveBeenCalledWith({}, "activity:created", want)
  })

  it("skips message:created events on end-to-end encrypted streams", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    const event = makeMessageCreatedEvent(1n, { streamId: "stream_e2e" })

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)

    const { handler, activityService } = createHandler()
    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    expect(activityService.processMessageMentions).not.toHaveBeenCalled()
    expect(activityService.processMessageNotifications).not.toHaveBeenCalled()
    expect(activityService.processSelfMessageActivity).not.toHaveBeenCalled()
  })

  it("skips reaction:added events on end-to-end encrypted streams", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "reaction:added",
        payload: {
          workspaceId: "ws_test",
          streamId: "stream_e2e",
          messageId: "msg_test",
          emoji: ":eyes:",
          userId: "usr_reactor",
        },
        createdAt: new Date(),
      },
    ] as any)

    const { handler, activityService } = createHandler()
    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    expect(activityService.processReactionAdded).not.toHaveBeenCalled()
  })

  it("skips reaction:removed events on end-to-end encrypted streams", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "reaction:removed",
        payload: {
          workspaceId: "ws_test",
          streamId: "stream_e2e",
          messageId: "msg_test",
          emoji: ":eyes:",
          userId: "usr_reactor",
        },
        createdAt: new Date(),
      },
    ] as any)

    const { handler, activityService } = createHandler()
    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    expect(activityService.processReactionRemoved).not.toHaveBeenCalled()
  })

  it("should advance cursor past all events including skipped ones", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      { id: 1n, eventType: "stream:created", payload: {}, createdAt: new Date() },
      { id: 2n, eventType: "reaction:added", payload: {}, createdAt: new Date() },
      makeMessageCreatedEvent(3n),
    ] as any)

    let result: ProcessResult | undefined
    mockCursorLock((r) => {
      result = r
    })

    const activityService = {
      processMessageMentions: mock(async () => []),
      processMessageNotifications: mock(async () => []),
      processSelfMessageActivity: mock(async () => null),
      processReactionAdded: mock(async () => []),
      processReactionRemoved: mock(async () => []),
    } as unknown as ActivityService
    const handler = new ActivityFeedHandler({} as any, activityService)
    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    expect(result).toEqual({ status: "processed", processedIds: [1n, 2n, 3n] })
  })
})
