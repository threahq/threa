import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { OutboxRepository } from "../../lib/outbox"
import * as cursorLockModule from "@threa/backend-common"
import type { ProcessResult } from "@threa/backend-common"
import { AnalyticsOutboxHandler } from "./outbox-handler"
import { E2eStreamsRepository } from "../e2e-streams"
import { UserPreferencesRepository } from "../user-preferences"

function makeFakeCursorLock() {
  return () => ({
    run: mock(async (processor: (cursor: bigint, processedIds: bigint[]) => Promise<ProcessResult>) => {
      return processor(0n, [])
    }),
  })
}

function createHandler(consent: Map<string, unknown> = new Map()) {
  const fakeCursorLock = makeFakeCursorLock()
  ;(spyOn(cursorLockModule, "CursorLock") as any).mockImplementation(fakeCursorLock)
  const excludeE2eRootedStreamIds = spyOn(E2eStreamsRepository, "excludeE2eRootedStreamIds").mockImplementation(
    async (_db, _workspaceId, streamIds) => streamIds
  )
  const findOverrideForUsers = spyOn(UserPreferencesRepository, "findOverrideForUsers").mockResolvedValue(consent)
  const captureEvent = mock()
  const reporter = { captureEvent, captureException: mock(), shutdown: mock(async () => {}) }
  const handler = new AnalyticsOutboxHandler({} as any, reporter as any)
  return { handler, captureEvent, excludeE2eRootedStreamIds, findOverrideForUsers }
}

function messageCreatedEvent(overrides: {
  id?: bigint
  actorType?: string
  actorId?: string | null
  workspaceId?: string
  streamId?: string
  messageId?: string
}) {
  return {
    id: overrides.id ?? 1n,
    eventType: "message:created",
    payload: {
      workspaceId: overrides.workspaceId ?? "ws_test",
      streamId: overrides.streamId ?? "stream_test",
      event: {
        id: "event_1",
        sequence: "1",
        actorType: overrides.actorType ?? "user",
        actorId: overrides.actorId === undefined ? "usr_a" : overrides.actorId,
        payload: {
          messageId: overrides.messageId ?? "msg_test",
          contentMarkdown: "hi",
          contentJson: null,
        },
      },
    },
    createdAt: new Date(),
  }
}

function reactionEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: (overrides.id as bigint) ?? 2n,
    eventType: "reaction:added",
    payload: {
      workspaceId: "ws_test",
      streamId: "stream_test",
      messageId: "msg_test",
      emoji: ":tada:",
      userId: "usr_a",
      ...overrides,
    },
    createdAt: new Date(),
  }
}

function streamCreatedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: (overrides.id as bigint) ?? 3n,
    eventType: "stream:created",
    payload: {
      workspaceId: "ws_test",
      streamId: "stream_test",
      stream: { id: "stream_test", createdBy: "usr_a", type: "channel", ...(overrides.stream as object) },
      ...overrides,
    },
    createdAt: new Date(),
  }
}

function streamMemberJoinedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: (overrides.id as bigint) ?? 4n,
    eventType: "stream:member_joined",
    payload: {
      workspaceId: "ws_test",
      streamId: "stream_test",
      event: { actorId: "usr_a", ...(overrides.event as object) },
      ...overrides,
    },
    createdAt: new Date(),
  }
}

afterEach(() => {
  mock.restore()
})

describe("AnalyticsOutboxHandler", () => {
  it("should capture message_sent with the workspace group when the author granted consent", async () => {
    const { handler, captureEvent } = createHandler(new Map([["usr_a", "granted"]]))
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([messageCreatedEvent({})] as any)

    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(captureEvent).toHaveBeenCalledTimes(1)
    expect(captureEvent.mock.calls[0][0]).toEqual({
      distinctId: "usr_a",
      event: "message_sent",
      properties: { workspaceId: "ws_test", streamId: "stream_test", messageId: "msg_test" },
      groups: { workspace: "ws_test" },
    })
  })

  it.each(["denied", "unset"])("should not capture when consent is %s", async (consentValue) => {
    const consent = consentValue === "unset" ? new Map() : new Map([["usr_a", consentValue]])
    const { handler, captureEvent } = createHandler(consent)
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([messageCreatedEvent({})] as any)

    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(captureEvent).not.toHaveBeenCalled()
  })

  it("should not capture a persona-authored message", async () => {
    const { handler, captureEvent } = createHandler(new Map([["usr_a", "granted"]]))
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      messageCreatedEvent({ actorType: "persona", actorId: "persona_ariadne" }),
    ] as any)

    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(captureEvent).not.toHaveBeenCalled()
  })

  it("should not capture anything for an E2E stream", async () => {
    const { handler, captureEvent, excludeE2eRootedStreamIds } = createHandler(new Map([["usr_a", "granted"]]))
    excludeE2eRootedStreamIds.mockResolvedValue([])
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([messageCreatedEvent({})] as any)

    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(captureEvent).not.toHaveBeenCalled()
  })

  it("should capture reaction_added with the expected object", async () => {
    const { handler, captureEvent } = createHandler(new Map([["usr_a", "granted"]]))
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([reactionEvent()] as any)

    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(captureEvent).toHaveBeenCalledTimes(1)
    expect(captureEvent.mock.calls[0][0]).toEqual({
      distinctId: "usr_a",
      event: "reaction_added",
      properties: { workspaceId: "ws_test", streamId: "stream_test", messageId: "msg_test" },
      groups: { workspace: "ws_test" },
    })
  })

  it("should capture stream_created with streamType", async () => {
    const { handler, captureEvent } = createHandler(new Map([["usr_a", "granted"]]))
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([streamCreatedEvent()] as any)

    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(captureEvent).toHaveBeenCalledTimes(1)
    expect(captureEvent.mock.calls[0][0]).toEqual({
      distinctId: "usr_a",
      event: "stream_created",
      properties: { workspaceId: "ws_test", streamId: "stream_test", streamType: "channel" },
      groups: { workspace: "ws_test" },
    })
  })

  it("should capture the created thread's own id when stream:created routes to the parent stream", async () => {
    const { handler, captureEvent, excludeE2eRootedStreamIds } = createHandler(new Map([["usr_a", "granted"]]))
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      streamCreatedEvent({
        streamId: "stream_parent",
        stream: { id: "stream_thread", createdBy: "usr_a", type: "thread" },
      }),
    ] as any)

    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(captureEvent.mock.calls[0][0]).toEqual({
      distinctId: "usr_a",
      event: "stream_created",
      properties: { workspaceId: "ws_test", streamId: "stream_thread", streamType: "thread" },
      groups: { workspace: "ws_test" },
    })
    expect(excludeE2eRootedStreamIds.mock.calls[0].slice(1)).toEqual(["ws_test", ["stream_thread"]])
  })

  it("should capture stream_joined with the expected object", async () => {
    const { handler, captureEvent } = createHandler(new Map([["usr_a", "granted"]]))
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([streamMemberJoinedEvent()] as any)

    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(captureEvent).toHaveBeenCalledTimes(1)
    expect(captureEvent.mock.calls[0][0]).toEqual({
      distinctId: "usr_a",
      event: "stream_joined",
      properties: { workspaceId: "ws_test", streamId: "stream_test" },
      groups: { workspace: "ws_test" },
    })
  })

  it("should ignore an unrelated event type and still mark it processed", async () => {
    const { handler, captureEvent } = createHandler()
    const unrelatedEvent = {
      id: 5n,
      eventType: "stream:read",
      payload: { workspaceId: "ws_test", streamId: "stream_test", userId: "usr_a" },
      createdAt: new Date(),
    }
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([unrelatedEvent] as any)

    let result: ProcessResult | undefined
    ;(spyOn(cursorLockModule, "CursorLock") as any).mockImplementation(() => ({
      run: mock(async (processor: (cursor: bigint, processedIds: bigint[]) => Promise<ProcessResult>) => {
        result = await processor(0n, [])
        return result
      }),
    }))
    const handlerWithCapturedResult = new AnalyticsOutboxHandler(
      {} as any,
      {
        captureEvent,
        captureException: mock(),
        shutdown: mock(async () => {}),
      } as any
    )

    handlerWithCapturedResult.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(captureEvent).not.toHaveBeenCalled()
    expect(result).toEqual({ status: "processed", processedIds: [5n] })
  })

  it("should read consent once per batch with the distinct actor ids", async () => {
    const { handler, findOverrideForUsers } = createHandler(new Map())
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      messageCreatedEvent({ id: 1n, actorId: "usr_a" }),
      reactionEvent({ id: 2n, userId: "usr_b" }),
      messageCreatedEvent({ id: 3n, actorId: "usr_a" }),
    ] as any)

    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(findOverrideForUsers).toHaveBeenCalledTimes(1)
    expect(findOverrideForUsers.mock.calls[0][1]).toEqual(["usr_a", "usr_b"])
    expect(findOverrideForUsers.mock.calls[0][2]).toBe("analyticsConsent")
  })
})
