import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { AuthorTypes, FollowUpStatuses } from "@threa/types"
import { AgentFollowUpService } from "./follow-up-service"
import { AgentFollowUpRepository, type AgentFollowUp } from "./follow-up-repository"
import { JobQueues, QueueRepository } from "../../lib/queue"
import { OutboxRepository } from "../../lib/outbox"
import { StreamEventRepository } from "../streams"
import * as dbModule from "../../db"
import { DEFAULT_MAX_PENDING_FOLLOW_UPS } from "./config"

/**
 * Stub the timeline-event append the service performs inside its transactions
 * (roadmap 1.3). Returns the spies so a test can assert the broadcast row and
 * its outbox row were written (INV-23: presence + content, not counts).
 */
function stubEventAppend() {
  const insertEvent = spyOn(StreamEventRepository, "insert").mockResolvedValue({} as never)
  const insertOutbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)
  return { insertEvent, insertOutbox }
}

const NOW = new Date("2026-07-02T12:00:00.000Z")
const SCHEDULED_FOR = new Date("2026-07-03T12:00:00.000Z")

function fakeFollowUp(overrides: Partial<AgentFollowUp> = {}): AgentFollowUp {
  return {
    id: "agfu_01",
    workspaceId: "ws_1",
    streamId: "stream_1",
    personaId: "persona_system_ariadne",
    sessionId: "session_1",
    sourceConversationId: null,
    note: "check back on the deploy",
    scheduledFor: SCHEDULED_FOR,
    status: FollowUpStatuses.PENDING,
    queueMessageId: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    statusChangedAt: NOW,
    ...overrides,
  }
}

function makeService(maxPendingFollowUps: number = DEFAULT_MAX_PENDING_FOLLOW_UPS) {
  return new AgentFollowUpService({
    pool: {} as Pool,
    workspaceSettingsService: { getSettings: async () => ({ maxPendingFollowUps }) },
  })
}

const scheduleParams = {
  workspaceId: "ws_1",
  streamId: "stream_1",
  personaId: "persona_system_ariadne",
  sessionId: "session_1",
  sourceConversationId: null,
  note: "check back on the deploy",
  scheduledFor: SCHEDULED_FOR,
}

describe("AgentFollowUpService.schedule", () => {
  afterEach(() => mock.restore())

  it("inserts under the cap, enqueues a fire job, and reports the cap + count", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "acquireStreamCapLock").mockResolvedValue(undefined)
    spyOn(AgentFollowUpRepository, "insertIfUnderCap").mockResolvedValue(fakeFollowUp())
    spyOn(AgentFollowUpRepository, "setQueueMessageId").mockResolvedValue(undefined)
    spyOn(AgentFollowUpRepository, "countPending").mockResolvedValue(1)
    const queueInsert = spyOn(QueueRepository, "insert").mockResolvedValue({} as never)
    stubEventAppend()

    const result = await makeService().schedule(scheduleParams)

    expect(result).toEqual({
      ok: true,
      followUp: expect.objectContaining({ id: "agfu_01" }),
      pendingCount: 1,
      limit: DEFAULT_MAX_PENDING_FOLLOW_UPS,
    })
    const fireEnqueue = queueInsert.mock.calls.find(
      (call) => (call[1] as { queueName: string }).queueName === JobQueues.AGENT_FOLLOW_UP_FIRE
    )
    expect(fireEnqueue).toBeDefined()
  })

  it("appends a scheduled broadcast row (+ outbox) attributed to the persona (roadmap 1.3)", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "acquireStreamCapLock").mockResolvedValue(undefined)
    spyOn(AgentFollowUpRepository, "insertIfUnderCap").mockResolvedValue(fakeFollowUp())
    spyOn(AgentFollowUpRepository, "setQueueMessageId").mockResolvedValue(undefined)
    spyOn(AgentFollowUpRepository, "countPending").mockResolvedValue(1)
    spyOn(QueueRepository, "insert").mockResolvedValue({} as never)
    const { insertEvent, insertOutbox } = stubEventAppend()

    await makeService().schedule(scheduleParams)

    expect(insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        streamId: "stream_1",
        eventType: "agent:follow_up_scheduled",
        actorId: "persona_system_ariadne",
        actorType: AuthorTypes.PERSONA,
        payload: expect.objectContaining({
          followUpId: "agfu_01",
          note: "check back on the deploy",
          scheduledFor: SCHEDULED_FOR.toISOString(),
          sourceConversationId: null,
        }),
      })
    )
    expect(insertOutbox.mock.calls[0]?.[1]).toBe("stream:agent_follow_up_scheduled")
  })

  it("returns cap_reached without enqueuing when the guarded insert writes nothing", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "acquireStreamCapLock").mockResolvedValue(undefined)
    spyOn(AgentFollowUpRepository, "insertIfUnderCap").mockResolvedValue(null)
    spyOn(AgentFollowUpRepository, "countPending").mockResolvedValue(DEFAULT_MAX_PENDING_FOLLOW_UPS)
    const queueInsert = spyOn(QueueRepository, "insert").mockResolvedValue({} as never)

    const result = await makeService().schedule(scheduleParams)

    expect(result).toEqual({
      ok: false,
      reason: "cap_reached",
      pendingCount: DEFAULT_MAX_PENDING_FOLLOW_UPS,
      limit: DEFAULT_MAX_PENDING_FOLLOW_UPS,
    })
    expect(queueInsert).not.toHaveBeenCalled()
  })

  it("resolves the cap from the workspace setting, not the code default (roadmap 1.4)", async () => {
    const workspaceLimit = 25
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "acquireStreamCapLock").mockResolvedValue(undefined)
    const insertIfUnderCap = spyOn(AgentFollowUpRepository, "insertIfUnderCap").mockResolvedValue(fakeFollowUp())
    spyOn(AgentFollowUpRepository, "setQueueMessageId").mockResolvedValue(undefined)
    spyOn(AgentFollowUpRepository, "countPending").mockResolvedValue(1)
    spyOn(QueueRepository, "insert").mockResolvedValue({} as never)
    stubEventAppend()

    const result = await makeService(workspaceLimit).schedule(scheduleParams)

    expect(result).toMatchObject({ ok: true, limit: workspaceLimit })
    // The guarded insert enforces the resolved cap, not DEFAULT_MAX_PENDING_FOLLOW_UPS.
    expect(insertIfUnderCap.mock.calls[0]?.[2]).toBe(workspaceLimit)
  })
})

describe("AgentFollowUpService.cancel", () => {
  afterEach(() => mock.restore())

  it("cancels the fire queue row when the CAS wins", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "markCancelled").mockResolvedValue(
      fakeFollowUp({ status: FollowUpStatuses.CANCELLED, queueMessageId: "agfuq_1" })
    )
    const queueCancel = spyOn(QueueRepository, "cancelById").mockResolvedValue(true)
    stubEventAppend()

    const result = await makeService().cancel({ workspaceId: "ws_1", id: "agfu_01" })

    expect(result?.status).toBe(FollowUpStatuses.CANCELLED)
    expect(queueCancel).toHaveBeenCalledWith(expect.anything(), "agfuq_1")
  })

  it("appends a cancelled broadcast row (+ outbox), attributing to the persona by default (roadmap 1.3)", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "markCancelled").mockResolvedValue(
      fakeFollowUp({ status: FollowUpStatuses.CANCELLED, queueMessageId: "agfuq_1" })
    )
    spyOn(QueueRepository, "cancelById").mockResolvedValue(true)
    const { insertEvent, insertOutbox } = stubEventAppend()

    await makeService().cancel({ workspaceId: "ws_1", id: "agfu_01" })

    expect(insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "agent:follow_up_cancelled",
        actorId: "persona_system_ariadne",
        actorType: AuthorTypes.PERSONA,
        payload: { followUpId: "agfu_01" },
      })
    )
    expect(insertOutbox.mock.calls[0]?.[1]).toBe("stream:agent_follow_up_cancelled")
  })

  it("attributes the cancelled row to the caller when cancelledBy is given (the card's Cancel button)", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "markCancelled").mockResolvedValue(
      fakeFollowUp({ status: FollowUpStatuses.CANCELLED })
    )
    spyOn(QueueRepository, "cancelById").mockResolvedValue(true)
    const { insertEvent } = stubEventAppend()

    await makeService().cancel({
      workspaceId: "ws_1",
      id: "agfu_01",
      cancelledBy: { actorId: "usr_kris", actorType: AuthorTypes.USER },
    })

    expect(insertEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorId: "usr_kris", actorType: AuthorTypes.USER })
    )
  })

  it("returns null and cancels nothing when it loses the race to the fire worker", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "markCancelled").mockResolvedValue(null)
    const queueCancel = spyOn(QueueRepository, "cancelById").mockResolvedValue(true)

    const result = await makeService().cancel({ workspaceId: "ws_1", id: "agfu_01" })

    expect(result).toBeNull()
    expect(queueCancel).not.toHaveBeenCalled()
  })

  it("uses the stream-scoped CAS so an agent only cancels its own stream's follow-ups", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    const markInStream = spyOn(AgentFollowUpRepository, "markCancelledInStream").mockResolvedValue(null)
    const markWorkspace = spyOn(AgentFollowUpRepository, "markCancelled").mockResolvedValue(null)

    await makeService().cancel({ workspaceId: "ws_1", id: "agfu_01", streamId: "stream_1" })

    expect(markInStream.mock.calls[0]?.slice(1)).toEqual(["ws_1", "stream_1", "agfu_01"])
    expect(markWorkspace).not.toHaveBeenCalled()
  })
})

describe("AgentFollowUpService.listPending", () => {
  afterEach(() => mock.restore())

  it("returns a stream's pending rows via the pool", async () => {
    const rows = [fakeFollowUp()]
    const listPending = spyOn(AgentFollowUpRepository, "listPending").mockResolvedValue(rows)

    const result = await makeService().listPending({ workspaceId: "ws_1", streamId: "stream_1" })

    expect(result).toEqual(rows)
    expect(listPending.mock.calls[0]?.slice(1)).toEqual(["ws_1", "stream_1"])
  })
})

describe("AgentFollowUpService.update", () => {
  afterEach(() => mock.restore())

  const NEW_TIME = new Date("2026-07-10T09:00:00.000Z")

  it("reschedules: tombstones the CAS-fresh fire job and enqueues a fresh one at the new time", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    // The cancel target comes from the CAS result (updatePending), not a pre-read.
    spyOn(AgentFollowUpRepository, "updatePending").mockResolvedValue(
      fakeFollowUp({ note: "new note", scheduledFor: NEW_TIME, queueMessageId: "agfuq_old" })
    )
    spyOn(AgentFollowUpRepository, "setQueueMessageId").mockResolvedValue(undefined)
    const queueCancel = spyOn(QueueRepository, "cancelById").mockResolvedValue(true)
    const queueInsert = spyOn(QueueRepository, "insert").mockResolvedValue({} as never)

    const result = await makeService().update({
      workspaceId: "ws_1",
      streamId: "stream_1",
      id: "agfu_01",
      note: "new note",
      scheduledFor: NEW_TIME,
    })

    expect(result).toEqual({ ok: true, followUp: expect.objectContaining({ scheduledFor: NEW_TIME }) })
    expect(queueCancel).toHaveBeenCalledWith(expect.anything(), "agfuq_old")
    const fireEnqueue = queueInsert.mock.calls.find(
      (call) => (call[1] as { queueName: string }).queueName === JobQueues.AGENT_FOLLOW_UP_FIRE
    )
    expect((fireEnqueue?.[1] as { processAfter: Date }).processAfter).toEqual(NEW_TIME)
  })

  it("note-only update leaves the fire job alone (no reschedule) and never reads first", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    const findById = spyOn(AgentFollowUpRepository, "findById").mockResolvedValue(fakeFollowUp())
    spyOn(AgentFollowUpRepository, "updatePending").mockResolvedValue(
      fakeFollowUp({ note: "new note", queueMessageId: "agfuq_old" })
    )
    const queueCancel = spyOn(QueueRepository, "cancelById").mockResolvedValue(true)
    const queueInsert = spyOn(QueueRepository, "insert").mockResolvedValue({} as never)

    const result = await makeService().update({
      workspaceId: "ws_1",
      streamId: "stream_1",
      id: "agfu_01",
      note: "new note",
    })

    expect(result).toEqual({ ok: true, followUp: expect.objectContaining({ note: "new note" }) })
    expect(queueCancel).not.toHaveBeenCalled()
    expect(queueInsert).not.toHaveBeenCalled()
    // Happy path is a single CAS — no select-then-set (INV-20).
    expect(findById).not.toHaveBeenCalled()
  })

  it("passes only the changed field to the CAS (null for the untouched column)", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    const updatePending = spyOn(AgentFollowUpRepository, "updatePending").mockResolvedValue(fakeFollowUp())

    await makeService().update({ workspaceId: "ws_1", streamId: "stream_1", id: "agfu_01", note: "just the note" })

    expect(updatePending.mock.calls[0]?.[1]).toMatchObject({ note: "just the note", scheduledFor: null })
  })

  it("returns not_found for an unknown id (classified by the failure-path read)", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    const updatePending = spyOn(AgentFollowUpRepository, "updatePending").mockResolvedValue(null)
    spyOn(AgentFollowUpRepository, "findById").mockResolvedValue(null)

    const result = await makeService().update({ workspaceId: "ws_1", streamId: "stream_1", id: "agfu_x", note: "n" })

    expect(result).toEqual({ ok: false, reason: "not_found" })
    expect(updatePending).toHaveBeenCalled()
  })

  it("returns not_found for a follow-up that belongs to a different stream", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "updatePending").mockResolvedValue(null)
    spyOn(AgentFollowUpRepository, "findById").mockResolvedValue(fakeFollowUp({ streamId: "stream_other" }))

    const result = await makeService().update({ workspaceId: "ws_1", streamId: "stream_1", id: "agfu_01", note: "n" })

    expect(result).toEqual({ ok: false, reason: "not_found" })
  })

  it("returns not_pending when the follow-up already fired", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "updatePending").mockResolvedValue(null)
    spyOn(AgentFollowUpRepository, "findById").mockResolvedValue(fakeFollowUp({ status: FollowUpStatuses.FIRED }))

    const result = await makeService().update({ workspaceId: "ws_1", streamId: "stream_1", id: "agfu_01", note: "n" })

    expect(result).toEqual({ ok: false, reason: "not_pending" })
  })
})

describe("AgentFollowUpService.fire", () => {
  afterEach(() => mock.restore())

  it("CASes to fired and enqueues a PERSONA_AGENT job carrying followUpId", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "markFired").mockResolvedValue(fakeFollowUp({ status: FollowUpStatuses.FIRED }))
    const queueInsert = spyOn(QueueRepository, "insert").mockResolvedValue({} as never)

    const result = await makeService().fire({ workspaceId: "ws_1", followUpId: "agfu_01" })

    expect(result).toEqual({ fired: true })
    const personaEnqueue = queueInsert.mock.calls.find(
      (call) => (call[1] as { queueName: string }).queueName === JobQueues.PERSONA_AGENT
    )
    expect(personaEnqueue).toBeDefined()
    expect((personaEnqueue?.[1] as { payload: { followUpId?: string } }).payload.followUpId).toBe("agfu_01")
  })

  it("no-ops when the row is no longer pending (cancelled before firing)", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "markFired").mockResolvedValue(null)
    const queueInsert = spyOn(QueueRepository, "insert").mockResolvedValue({} as never)

    const result = await makeService().fire({ workspaceId: "ws_1", followUpId: "agfu_01" })

    expect(result).toEqual({ fired: false })
    expect(queueInsert).not.toHaveBeenCalled()
  })
})

describe("AgentFollowUpService.getById", () => {
  afterEach(() => mock.restore())

  it("reads the row workspace-scoped via the pool (roadmap 1.2 context load)", async () => {
    const row = fakeFollowUp()
    const findById = spyOn(AgentFollowUpRepository, "findById").mockResolvedValue(row)

    const result = await makeService().getById({ workspaceId: "ws_1", followUpId: "agfu_01" })

    expect(result).toEqual(row)
    expect(findById.mock.calls[0]?.slice(1)).toEqual(["ws_1", "agfu_01"])
  })

  it("returns null when the row is gone", async () => {
    spyOn(AgentFollowUpRepository, "findById").mockResolvedValue(null)

    const result = await makeService().getById({ workspaceId: "ws_1", followUpId: "agfu_missing" })

    expect(result).toBeNull()
  })
})
