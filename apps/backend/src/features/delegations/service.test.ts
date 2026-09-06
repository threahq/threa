import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { AuthorTypes, DelegationStatuses } from "@threahq/types"
import { DelegationService } from "./service"
import { DelegatedTaskRepository, type DelegatedTask } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import { StreamEventRepository, StreamRepository } from "../streams"
import { StreamContextRepository } from "../stream-context"
import { hashCallbackToken } from "../agents"
import * as dbModule from "../../db"
import * as streamsModule from "../streams"
import { HttpError } from "../../lib/errors"

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
    claimIdempotencyKey: null,
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

/** Stub the stream lookup + "In this stream" projection write the create path performs. */
function stubContextIndex(stream: Record<string, unknown> = { id: "stream_1", rootStreamId: null }) {
  spyOn(StreamRepository, "findById").mockResolvedValue(stream as never)
  return spyOn(StreamContextRepository, "insertMany").mockResolvedValue(0)
}

function stubTransaction() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
}

function makeService() {
  return new DelegationService({ pool: {} as Pool, claimTtlSeconds: 900 })
}

describe("DelegationService.create", () => {
  afterEach(() => mock.restore())

  for (const reason of ["archived", "system_stream", "not_member"] as const) {
    it(`denies generated ${reason} before delegation/event writes`, async () => {
      spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
      spyOn(streamsModule, "assertStreamWritable").mockRejectedValue(
        new HttpError("Stream is read-only", { status: 403, code: "STREAM_READ_ONLY", details: { reason } })
      )
      const insert = spyOn(DelegatedTaskRepository, "insert").mockResolvedValue(fakeDelegation())
      const insertEvent = spyOn(StreamEventRepository, "insert").mockResolvedValue({} as never)

      await expect(
        makeService().createGenerated(
          { kind: "user", userId: "usr_1" },
          {
            workspaceId: "ws_1",
            streamId: "stream_1",
            requestedStreamId: "stream_1",
            sessionId: "session_1",
            sourceConversationId: null,
            createdByKind: AuthorTypes.PERSONA,
            createdById: "persona_1",
            title: "blocked",
            brief: "blocked",
            contextRefs: [],
          }
        )
      ).rejects.toMatchObject({ code: "STREAM_READ_ONLY", details: { reason } })
      expect(insert).not.toHaveBeenCalled()
      expect(insertEvent).not.toHaveBeenCalled()
    })
  }

  it("inserts the row and appends the delegation:created card row (+ outbox) in the same tx", async () => {
    stubTransaction()
    spyOn(DelegatedTaskRepository, "insert").mockResolvedValue(fakeDelegation())
    const { insertEvent, insertOutbox } = stubEventAppend()
    stubContextIndex()

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

  it("indexes the delegation at the task's created_at", async () => {
    stubTransaction()
    spyOn(DelegatedTaskRepository, "insert").mockResolvedValue(fakeDelegation())
    stubEventAppend()
    const insertContext = stubContextIndex()

    await makeService().create({
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

    const [row] = insertContext.mock.calls[0]?.[1] as unknown as Array<Record<string, unknown>>
    const { id, ...rest } = row
    expect(rest).toEqual({
      workspaceId: "ws_1",
      streamId: "stream_1",
      rootStreamId: "stream_1",
      category: "delegation",
      refKind: "delegation",
      refId: "dlg_1",
      groupKey: "dlg_1",
      sourceMessageId: null,
      authorId: null,
      occurredAt: NOW,
      sequence: null,
      snippet: "Add rate limiting",
      detail: { title: "Add rate limiting" },
    })
  })

  it("skips the projection for a sealed stream", async () => {
    stubTransaction()
    spyOn(DelegatedTaskRepository, "insert").mockResolvedValue(fakeDelegation())
    stubEventAppend()
    const insertContext = stubContextIndex({ id: "stream_1", rootStreamId: null, e2eEnabled: true })

    await makeService().create({
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

    expect(insertContext).not.toHaveBeenCalled()
  })
})

describe("DelegationService.markDone", () => {
  afterEach(() => mock.restore())

  it("appends a completed status patch attributed to the marking user", async () => {
    stubTransaction()
    spyOn(DelegatedTaskRepository, "markDone").mockResolvedValue(
      fakeDelegation({ status: DelegationStatuses.COMPLETED })
    )
    const { insertEvent, insertOutbox } = stubEventAppend()

    const done = await makeService().markDone({
      workspaceId: "ws_1",
      id: "dlg_1",
      streamId: "stream_1",
      completedBy: { actorId: "usr_kris", actorType: AuthorTypes.USER },
    })

    expect(done?.status).toBe(DelegationStatuses.COMPLETED)
    expect(insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "delegation:status_changed",
        actorId: "usr_kris",
        actorType: AuthorTypes.USER,
        payload: expect.objectContaining({ delegationId: "dlg_1", status: DelegationStatuses.COMPLETED }),
      })
    )
    expect(insertOutbox.mock.calls[0]?.[1]).toBe("stream:delegation_status_changed")
  })

  it("returns null (and appends nothing) when the mark-done lost the race", async () => {
    stubTransaction()
    spyOn(DelegatedTaskRepository, "markDone").mockResolvedValue(null)
    const { insertEvent } = stubEventAppend()

    const done = await makeService().markDone({
      workspaceId: "ws_1",
      id: "dlg_1",
      completedBy: { actorId: "usr_kris", actorType: AuthorTypes.USER },
    })

    expect(done).toBeNull()
    expect(insertEvent).not.toHaveBeenCalled()
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

describe("DelegationService.claim idempotent recovery", () => {
  afterEach(() => mock.restore())

  it("re-keys the live claim on retry with the original idempotency key (fresh token, no card event)", async () => {
    stubTransaction()
    spyOn(DelegatedTaskRepository, "claim").mockResolvedValue(null)
    const reclaim = spyOn(DelegatedTaskRepository, "reclaimByIdempotencyKey").mockResolvedValue(
      fakeDelegation({ status: DelegationStatuses.CLAIMED, claimIdempotencyKey: "runner-key-1" })
    )
    const { insertEvent } = stubEventAppend()

    const result = await makeService().claim({
      workspaceId: "ws_1",
      id: "dlg_1",
      claimedByLabel: "Rig",
      idempotencyKey: "runner-key-1",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    const reclaimParams = reclaim.mock.calls[0]?.[1] as { claimIdempotencyKey: string; claimTokenHash: string }
    expect(reclaimParams.claimIdempotencyKey).toBe("runner-key-1")
    expect(reclaimParams.claimTokenHash).toBe(hashCallbackToken(result.claimToken))
    // Re-keying is not a status change — no patch lands on the card.
    expect(insertEvent).not.toHaveBeenCalled()
  })

  it("still classifies not_open when the retry carries a non-matching key", async () => {
    stubTransaction()
    spyOn(DelegatedTaskRepository, "claim").mockResolvedValue(null)
    spyOn(DelegatedTaskRepository, "reclaimByIdempotencyKey").mockResolvedValue(null)
    spyOn(DelegatedTaskRepository, "findById").mockResolvedValue(fakeDelegation({ status: DelegationStatuses.CLAIMED }))
    stubEventAppend()

    const result = await makeService().claim({
      workspaceId: "ws_1",
      id: "dlg_1",
      claimedByLabel: "Rig",
      idempotencyKey: "wrong-key",
    })

    expect(result).toEqual({ ok: false, reason: "not_open" })
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

  it("complete appends the completed patch carrying the result message id and thread stream id", async () => {
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
      threadStreamId: "stream_thread",
    })

    expect(insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payload: expect.objectContaining({
          status: DelegationStatuses.COMPLETED,
          resultMessageId: "msg_result",
          threadStreamId: "stream_thread",
        }),
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

describe("DelegationService reopening", () => {
  afterEach(() => mock.restore())

  it("appends an open claim_expired patch per reopened row", async () => {
    stubTransaction()
    spyOn(DelegatedTaskRepository, "reopenLapsedClaims").mockResolvedValue([
      fakeDelegation({ id: "dlg_1", status: DelegationStatuses.OPEN }),
      fakeDelegation({ id: "dlg_2", status: DelegationStatuses.OPEN, streamId: "stream_2" }),
    ])
    const { insertEvent } = stubEventAppend()

    expect(await makeService().reopenLapsedClaims()).toHaveLength(2)
    expect(insertEvent.mock.calls.map((call) => (call[1] as any).payload)).toEqual([
      expect.objectContaining({ delegationId: "dlg_1", status: "open", reason: "claim_expired" }),
      expect.objectContaining({ delegationId: "dlg_2", status: "open", reason: "claim_expired" }),
    ])
  })

  it("appends release and requeue reasons, but no event on lost CAS", async () => {
    stubTransaction()
    const release = spyOn(DelegatedTaskRepository, "release").mockResolvedValue(fakeDelegation())
    const requeue = spyOn(DelegatedTaskRepository, "requeue").mockResolvedValue(fakeDelegation())
    const { insertEvent } = stubEventAppend()

    await makeService().release({ workspaceId: "ws_1", id: "dlg_1", claimToken: "tok" })
    await makeService().requeue({
      workspaceId: "ws_1",
      id: "dlg_1",
      requeuedBy: { actorId: "usr_1", actorType: AuthorTypes.USER },
    })
    expect(insertEvent.mock.calls.map((call) => (call[1] as any).payload.reason)).toEqual([
      "claim_released",
      "requeued",
    ])

    release.mockResolvedValue(null)
    requeue.mockResolvedValue(null)
    insertEvent.mockClear()
    expect(await makeService().release({ workspaceId: "ws_1", id: "dlg_1", claimToken: "old" })).toBeNull()
    expect(
      await makeService().requeue({
        workspaceId: "ws_1",
        id: "dlg_1",
        requeuedBy: { actorId: "usr_1", actorType: AuthorTypes.USER },
      })
    ).toBeNull()
    expect(insertEvent).not.toHaveBeenCalled()
  })
})
