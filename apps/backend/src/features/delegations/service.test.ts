import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { AuthorTypes, DelegationStatuses } from "@threa/types"
import { DelegationService } from "./service"
import { DelegatedTaskRepository, type DelegatedTask } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import { StreamEventRepository } from "../streams"
import { hashCallbackToken } from "../agents"
import * as dbModule from "../../db"

const NOW = new Date("2026-07-09T12:00:00.000Z")

function fakeDelegation(overrides: Partial<DelegatedTask> = {}): DelegatedTask {
  return {
    id: "dlg_1",
    workspaceId: "ws_1",
    streamId: "stream_1",
    sessionId: "session_1",
    sourceConversationId: "conv_1",
    createdByKind: AuthorTypes.PERSONA,
    createdById: "persona_system_ariadne",
    title: "Add rate limiting",
    brief: "Do the thing. Done when tests pass.",
    contextRefs: ["memo:memo_1"],
    status: DelegationStatuses.OPEN,
    claimTokenHash: null,
    claimExpiresAt: null,
    claimedByLabel: null,
    resultMessageId: null,
    statusNote: null,
    createdAt: NOW,
    updatedAt: NOW,
    statusChangedAt: NOW,
    ...overrides,
  }
}

/** Stub the in-transaction timeline append; returns spies for INV-23 presence asserts. */
function stubEventAppend() {
  const insertEvent = spyOn(StreamEventRepository, "insert").mockResolvedValue({} as never)
  const insertOutbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)
  return { insertEvent, insertOutbox }
}

function stubTransaction() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
}

function makeService() {
  return new DelegationService({ pool: {} as Pool, claimTtlSeconds: 900 })
}

describe("DelegationService.create", () => {
  afterEach(() => mock.restore())

  it("inserts the row and appends the delegation:created card row (+ outbox) in the same tx", async () => {
    stubTransaction()
    spyOn(DelegatedTaskRepository, "insert").mockResolvedValue(fakeDelegation())
    const { insertEvent, insertOutbox } = stubEventAppend()

    const created = await makeService().create({
      workspaceId: "ws_1",
      streamId: "stream_1",
      sessionId: "session_1",
      sourceConversationId: "conv_1",
      createdByKind: AuthorTypes.PERSONA,
      createdById: "persona_system_ariadne",
      title: "Add rate limiting",
      brief: "Do the thing. Done when tests pass.",
      contextRefs: ["memo:memo_1"],
    })

    expect(created.id).toBe("dlg_1")
    expect(insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        streamId: "stream_1",
        eventType: "delegation:created",
        actorId: "persona_system_ariadne",
        actorType: AuthorTypes.PERSONA,
        payload: expect.objectContaining({
          delegationId: "dlg_1",
          title: "Add rate limiting",
          brief: "Do the thing. Done when tests pass.",
          contextRefs: ["memo:memo_1"],
          sourceConversationId: "conv_1",
        }),
      })
    )
    expect(insertOutbox.mock.calls[0]?.[1]).toBe("stream:delegation_created")
  })
})

describe("DelegationService.cancel", () => {
  afterEach(() => mock.restore())

  it("appends a cancelled status patch attributed to the cancelling user", async () => {
    stubTransaction()
    spyOn(DelegatedTaskRepository, "markCancelled").mockResolvedValue(
      fakeDelegation({ status: DelegationStatuses.CANCELLED })
    )
    const { insertEvent, insertOutbox } = stubEventAppend()

    const cancelled = await makeService().cancel({
      workspaceId: "ws_1",
      id: "dlg_1",
      streamId: "stream_1",
      cancelledBy: { actorId: "usr_kris", actorType: AuthorTypes.USER },
    })

    expect(cancelled?.status).toBe(DelegationStatuses.CANCELLED)
    expect(insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "delegation:status_changed",
        actorId: "usr_kris",
        actorType: AuthorTypes.USER,
        payload: expect.objectContaining({ delegationId: "dlg_1", status: DelegationStatuses.CANCELLED }),
      })
    )
    expect(insertOutbox.mock.calls[0]?.[1]).toBe("stream:delegation_status_changed")
  })

  it("returns null (and appends nothing) when the cancel lost the race to a terminal state", async () => {
    stubTransaction()
    spyOn(DelegatedTaskRepository, "markCancelled").mockResolvedValue(null)
    const { insertEvent } = stubEventAppend()

    const cancelled = await makeService().cancel({
      workspaceId: "ws_1",
      id: "dlg_1",
      cancelledBy: { actorId: "usr_kris", actorType: AuthorTypes.USER },
    })

    expect(cancelled).toBeNull()
    expect(insertEvent).not.toHaveBeenCalled()
  })
})

describe("DelegationService.claim", () => {
  afterEach(() => mock.restore())

  it("mints a cleartext token, stores only its hash, and appends the claimed patch", async () => {
    stubTransaction()
    const repoClaim = spyOn(DelegatedTaskRepository, "claim").mockResolvedValue(
      fakeDelegation({ status: DelegationStatuses.CLAIMED, claimedByLabel: "Kris's MacBook" })
    )
    const { insertEvent } = stubEventAppend()

    const result = await makeService().claim({ workspaceId: "ws_1", id: "dlg_1", claimedByLabel: "Kris's MacBook" })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    // The repo never sees the cleartext — only its sha256.
    const repoParams = repoClaim.mock.calls[0]?.[1] as { claimTokenHash: string }
    expect(repoParams.claimTokenHash).toBe(hashCallbackToken(result.claimToken))
    expect(repoParams.claimTokenHash).not.toBe(result.claimToken)
    expect(insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "delegation:status_changed",
        actorType: AuthorTypes.SYSTEM,
        payload: expect.objectContaining({
          delegationId: "dlg_1",
          status: DelegationStatuses.CLAIMED,
          claimedByLabel: "Kris's MacBook",
        }),
      })
    )
  })

  it("classifies a failed CAS as not_open (row exists) or not_found", async () => {
    stubTransaction()
    spyOn(DelegatedTaskRepository, "claim").mockResolvedValue(null)
    stubEventAppend()
    const findById = spyOn(DelegatedTaskRepository, "findById").mockResolvedValue(
      fakeDelegation({ status: DelegationStatuses.CANCELLED })
    )

    expect(await makeService().claim({ workspaceId: "ws_1", id: "dlg_1", claimedByLabel: "x" })).toEqual({
      ok: false,
      reason: "not_open",
    })

    findById.mockResolvedValue(null)
    expect(await makeService().claim({ workspaceId: "ws_1", id: "dlg_missing", claimedByLabel: "x" })).toEqual({
      ok: false,
      reason: "not_found",
    })
  })
})

describe("DelegationService.heartbeat", () => {
  afterEach(() => mock.restore())

  it("renews without appending any event (liveness is not card state)", async () => {
    const expiresAt = new Date("2026-07-09T12:15:00.000Z")
    const renew = spyOn(DelegatedTaskRepository, "renewClaim").mockResolvedValue(
      fakeDelegation({ status: DelegationStatuses.CLAIMED, claimExpiresAt: expiresAt })
    )
    const { insertEvent } = stubEventAppend()

    const result = await makeService().heartbeat({ workspaceId: "ws_1", id: "dlg_1", claimToken: "tok_1" })

    expect(result).toEqual(expiresAt)
    expect((renew.mock.calls[0]?.[1] as { claimTokenHash: string }).claimTokenHash).toBe(hashCallbackToken("tok_1"))
    expect(insertEvent).not.toHaveBeenCalled()
  })
})

describe("DelegationService.complete / fail / markRunning", () => {
  afterEach(() => mock.restore())

  it("complete appends the completed patch carrying the result message id", async () => {
    stubTransaction()
    spyOn(DelegatedTaskRepository, "complete").mockResolvedValue(
      fakeDelegation({ status: DelegationStatuses.COMPLETED, resultMessageId: "msg_result" })
    )
    const { insertEvent } = stubEventAppend()

    await makeService().complete({
      workspaceId: "ws_1",
      id: "dlg_1",
      claimToken: "tok_1",
      resultMessageId: "msg_result",
    })

    expect(insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payload: expect.objectContaining({ status: DelegationStatuses.COMPLETED, resultMessageId: "msg_result" }),
      })
    )
  })

  it("fail appends the failed patch carrying the note", async () => {
    stubTransaction()
    spyOn(DelegatedTaskRepository, "fail").mockResolvedValue(
      fakeDelegation({ status: DelegationStatuses.FAILED, statusNote: "build broke" })
    )
    const { insertEvent } = stubEventAppend()

    await makeService().fail({ workspaceId: "ws_1", id: "dlg_1", claimToken: "tok_1", statusNote: "build broke" })

    expect(insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payload: expect.objectContaining({ status: DelegationStatuses.FAILED, statusNote: "build broke" }),
      })
    )
  })

  it("markRunning appends the running patch and returns null on a lapsed claim", async () => {
    stubTransaction()
    const markRunning = spyOn(DelegatedTaskRepository, "markRunning").mockResolvedValue(
      fakeDelegation({ status: DelegationStatuses.RUNNING, statusNote: "half way" })
    )
    const { insertEvent } = stubEventAppend()

    await makeService().markRunning({ workspaceId: "ws_1", id: "dlg_1", claimToken: "tok_1", statusNote: "half way" })
    expect(insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payload: expect.objectContaining({ status: DelegationStatuses.RUNNING, statusNote: "half way" }),
      })
    )

    markRunning.mockResolvedValue(null)
    insertEvent.mockClear()
    const result = await makeService().markRunning({ workspaceId: "ws_1", id: "dlg_1", claimToken: "tok_stale" })
    expect(result).toBeNull()
    expect(insertEvent).not.toHaveBeenCalled()
  })
})

describe("DelegationService.expireLapsedClaims", () => {
  afterEach(() => mock.restore())

  it("appends an expired patch per reaped row, in the sweep's own transaction", async () => {
    stubTransaction()
    spyOn(DelegatedTaskRepository, "expireLapsedClaims").mockResolvedValue([
      fakeDelegation({ id: "dlg_1", status: DelegationStatuses.EXPIRED }),
      fakeDelegation({ id: "dlg_2", status: DelegationStatuses.EXPIRED, streamId: "stream_2" }),
    ])
    const { insertEvent } = stubEventAppend()

    const expired = await makeService().expireLapsedClaims()

    expect(expired).toHaveLength(2)
    const appendedIds = insertEvent.mock.calls.map(
      (call) => (call[1] as { payload: { delegationId: string } }).payload.delegationId
    )
    expect(appendedIds).toEqual(["dlg_1", "dlg_2"])
    const secondAppend = insertEvent.mock.calls[1]?.[1] as { streamId: string; payload: { status: string } }
    expect(secondAppend.streamId).toBe("stream_2")
    expect(secondAppend.payload.status).toBe(DelegationStatuses.EXPIRED)
  })
})
