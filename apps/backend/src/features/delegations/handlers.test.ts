import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import type { Request, Response } from "express"
import * as streamsModule from "../streams"
import { createDelegationHandlers } from "./handlers"
import type { DelegationService } from "./service"
import type { DelegatedTaskWithEvent } from "./repository"

const NOW = new Date("2026-07-14T12:00:00.000Z")

function makeDelegation(overrides: Partial<DelegatedTaskWithEvent> = {}): DelegatedTaskWithEvent {
  return {
    id: "dlg_1",
    workspaceId: "ws_1",
    streamId: "stream_1",
    sessionId: null,
    sourceConversationId: null,
    createdByKind: "persona",
    createdById: "persona_system_ariadne",
    title: "Add rate limiting",
    brief: "Do the thing.",
    contextRefs: [],
    status: "claimed",
    claimTokenHash: null,
    claimIdempotencyKey: null,
    claimExpiresAt: null,
    claimedByLabel: "Kris's MacBook / Claude Code",
    resultMessageId: null,
    statusNote: null,
    createdAt: NOW,
    updatedAt: NOW,
    statusChangedAt: NOW,
    createdEventId: "event_1",
    ...overrides,
  }
}

function createResponse() {
  const payloads: unknown[] = []
  const res = {
    json: mock((payload: unknown) => {
      payloads.push(payload)
      return res
    }),
    status: mock(() => res),
  } as unknown as Response
  return { res, payloads }
}

function makeRequest() {
  return {
    workspaceId: "ws_1",
    params: { id: "dlg_1" },
    user: { id: "usr_1", name: "Kris" },
  } as unknown as Request
}

function makeHandlers(delegationService: Partial<DelegationService>) {
  return createDelegationHandlers({
    pool: {} as Pool,
    delegationService: delegationService as DelegationService,
  })
}

describe("delegation requeue handler", () => {
  afterEach(() => mock.restore())

  it("requeues an accessible delegation and reports a lost race honestly", async () => {
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1" } as never)
    const requeue = mock(async (): Promise<DelegatedTaskWithEvent | null> => makeDelegation({ status: "open" }))
    const handlers = makeHandlers({ getById: mock(async () => makeDelegation({ status: "expired" })), requeue })
    const first = createResponse()
    await handlers.requeue(makeRequest(), first.res)
    expect(first.payloads[0]).toEqual({ requeued: true })
    expect(requeue).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws_1", streamId: "stream_1" }))
    requeue.mockResolvedValue(null)
    const second = createResponse()
    await handlers.requeue(makeRequest(), second.res)
    expect(second.payloads[0]).toEqual({ requeued: false })
  })
})

describe("delegation get handler", () => {
  afterEach(() => mock.restore())

  it("returns the summary (with createdEventId) for an accessible delegation", async () => {
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1" } as never)
    const handlers = makeHandlers({ getByIdWithEvent: mock(async () => makeDelegation()) })
    const { res, payloads } = createResponse()

    await handlers.get(makeRequest(), res)

    expect(payloads[0]).toMatchObject({
      id: "dlg_1",
      streamId: "stream_1",
      title: "Add rate limiting",
      status: "claimed",
      claimedByLabel: "Kris's MacBook / Claude Code",
      createdEventId: "event_1",
    })
  })

  it("404s an unknown delegation id (existence-hiding) without checking stream access", async () => {
    const accessSpy = spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1" } as never)
    const handlers = makeHandlers({ getByIdWithEvent: mock(async () => null) })
    const { res } = createResponse()

    await expect(handlers.get(makeRequest(), res)).rejects.toMatchObject({
      status: 404,
      code: "DELEGATION_NOT_FOUND",
    })
    expect(accessSpy).not.toHaveBeenCalled()
  })

  it("404s a viewer without access to the delegation's stream", async () => {
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue(null)
    const handlers = makeHandlers({ getByIdWithEvent: mock(async () => makeDelegation()) })
    const { res } = createResponse()

    await expect(handlers.get(makeRequest(), res)).rejects.toMatchObject({
      status: 404,
      code: "DELEGATION_NOT_FOUND",
    })
  })
})
